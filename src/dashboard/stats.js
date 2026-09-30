import { ROLES } from './permissions.js';
import { canShowPeople, channelLabel } from './privacy.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Everything the dashboard renders, already scoped to what the viewer is allowed
 * to see. Owners get the lot, channel managers only their channels, everyone else
 * aggregate numbers and their own switch.
 */
export async function buildDashboardStats({
  store,
  botChannels,
  permissions,
  cachet,
  flaron,
  slack,
  startedAt,
  statusEvents = [],
}) {
  const isOwner = permissions.role === ROLES.OWNER;
  const isManager = permissions.role === ROLES.MANAGER;
  const channelIds = await botChannels.list();
  const now = Date.now();
  // Every number, card and huddle on the dashboard comes from channels the bot is
  // actually in. A channel it cannot see could not have tracked a huddle, so
  // counting it would inflate the aggregates with data that can never exist.
  const botChannelSet = new Set(channelIds);

  const allHuddles = store.listHuddles().filter((h) => botChannelSet.has(h.channel_id));
  const channels = store.listTrackedHuddleChannels().filter((c) => botChannelSet.has(c.channel_id));
  const visibleHuddles =
    isOwner || !isManager ? allHuddles : allHuddles.filter((h) => permissions.managedChannelIds.includes(h.channel_id));

  const active = visibleHuddles.filter((h) => h.status === 'active');
  const ended = visibleHuddles.filter((h) => h.status === 'ended');
  const optedOut = visibleHuddles.filter((h) => h.status === 'opted_out');
  const last24h = ended.filter((h) => now - toMillis(h.ended_at) < DAY_MS);
  const durations = ended
    .map((h) => (toMillis(h.ended_at) - toMillis(h.started_at)) / 1000)
    .filter((seconds) => Number.isFinite(seconds) && seconds > 0);
  const membersSeen = new Set();
  for (const huddle of visibleHuddles) {
    for (const member of parseJsonArray(huddle.participant_json)) {
      membersSeen.add(member);
    }
  }

  // The board counts a channel only when it is both tracked and one the bot is
  // actually in. Passing the bot's whole membership list is what put people from
  // untracked huddles on the board; tracked alone would count channels the bot
  // cannot see, which could not have scored anyway.
  const scopeChannelIds = channels.map((channel) => channel.channel_id).filter((id) => id && channelIds.includes(id));
  const leaderboardRows = store.listHuddleLeaderboard(25, scopeChannelIds);
  const rawLeaderboard = await withProfiles({
    rows: leaderboardRows.map((row, index) => ({
      rank: index + 1,
      userId: row.user_id,
      points: Number(row.points) || 0,
    })),
    cachet,
    store,
  });

  // The dashboard is served to anyone holding the URL, with no sign-in, so a
  // named leaderboard here publishes who was in which channel's huddles. A
  // private channel's scores are exactly the thing that must not leak, and the
  // board mixes channels together, so the only honest public answer is the
  // number with no name attached.
  //
  // Opting out of the board is a separate promise and still applies on top.
  // A session at all is a real gate: it exists because the viewer signed in
  // through Slack and proved workspace membership. That is a different promise
  // from "anyone holding the URL", and it is what keeps the leaderboard useful
  // for the people who are in the workspace without publishing it to the web.
  const isSignedIn = permissions.role != null;
  const showNames = isSignedIn || isOwner || isManager;
  const leaderboard = showNames
    ? rawLeaderboard
    : rawLeaderboard.map((row, index) => ({
        rank: index + 1,
        userId: '',
        displayName: `Member ${index + 1}`,
        realName: '',
        pronouns: '',
        imageUrl: '',
        points: row.points,
      }));

  const logs = isOwner ? store.listTriggerLog(25, channelIds) : [];

  const incidents = statusEvents
    .filter((event) => event.state !== 'ok' && event.state !== 'operational')
    .slice(-6)
    .reverse()
    .map((event) => ({ state: event.state, at: event.at, detail: event.detail || '' }));

  // A channel can be saved with a blank name, and huddle rows only carry a name
  // when something recorded one, so ask Slack for the ones we are missing and
  // remember the answer instead of rendering a raw id forever.
  // is_private is tri-state and -1 means "never checked". Nothing else in the
  // app wrote it, so every channel sat at unknown forever and the dashboard
  // published all of them by accident. Ask Slack once per channel that is still
  // unknown, remember the answer, and let the privacy rules below do the rest.
  if (slack?.channelPrivacy) {
    await Promise.all(
      channels
        .filter((channel) => Number(channel.is_private) === -1)
        .map(async (channel) => {
          const isPrivate = await slack.channelPrivacy(channel.channel_id).catch(() => null);
          if (isPrivate === null) {
            // A failed lookup leaves it at -1, which still reads as private.
            return;
          }
          channel.is_private = isPrivate;
          if (typeof store.setHuddleChannelPrivacy === 'function') {
            store.setHuddleChannelPrivacy(channel.channel_id, isPrivate);
          }
        }),
    );
  }

  const unnamed = channels.filter((channel) => !channel.name).map((channel) => channel.channel_id);
  if (unnamed.length && typeof botChannels.names === 'function') {
    const resolved = await botChannels.names(unnamed);
    for (const [channelId, name] of Object.entries(resolved)) {
      const match = channels.find((channel) => channel.channel_id === channelId);
      if (match) {
        match.name = name;
      }
      store.setHuddleChannelName?.(channelId, name);
    }
  }

  // Flaron knows who runs a channel and how big it is. It refuses to describe a
  // private channel, so Slack covers the headcount there and we record which
  // source answered.
  const flaronRecords = flaron ? await flaron.list(channels.map((c) => c.channel_id)) : {};
  const slackSizes = new Map();
  if (slack?.channelSize) {
    await Promise.all(
      channels
        .filter((channel) => flaronRecords[channel.channel_id]?.members == null)
        .map(async (channel) => {
          const size = await slack.channelSize(channel.channel_id).catch(() => null);
          if (Number.isFinite(size)) {
            slackSizes.set(channel.channel_id, size);
          }
        }),
    );
  }

  // A channel manager gets a CM tag on the board, and a card in the channel
  // popup with their picture and their standing. Leaderboard profiles go through
  // withProfiles, which drops anyone who opted out of the board; a manager is
  // named by Flaron as running a channel, which is not the same as being ranked,
  // so they are looked up directly.
  //
  // The owner list lives in `huddle_channels.owner_ids` and is the single source
  // of truth shared with the App Home settings block, so a CM added or removed
  // there shows up here unchanged. Flaron only seeds a channel that has no
  // owners at all, with the creator Flaron already made the owner of, and
  // `seedHuddleChannelOwner` is a no-op once a channel has an owner, so a later
  // sync can never undo a hand edit.
  if (typeof store.seedHuddleChannelOwner === 'function') {
    for (const channel of channels) {
      const record = flaronRecords[channel.channel_id];
      const seedId = record?.creator || record?.managers?.[0] || '';
      if (seedId && store.seedHuddleChannelOwner(channel.channel_id, seedId)) {
        channel.owner_ids = JSON.stringify([seedId]);
      }
    }
  }
  const managerIds = [...new Set(channels.flatMap((channel) => parseJsonArray(channel.owner_ids)))];
  const managerProfiles = cachet && managerIds.length ? await cachet.list(managerIds) : {};
  const managerSet = new Set(managerIds);

  const channelCards = await Promise.all(
    channels.map(async (channel) => {
      const record = flaronRecords[channel.channel_id] || null;
      const fromSlack = slackSizes.has(channel.channel_id);
      return {
        id: channel.channel_id,
        isPrivate: Number(channel.is_private) === 0 ? 0 : Number(channel.is_private) === 1 ? 1 : -1,
        name: channelLabel({
          name: channel.name,
          channelId: channel.channel_id,
          isPrivate: channel.is_private,
          canIdentify: isSignedIn,
        }),
        inBot: channelIds.includes(channel.channel_id),
        enabled: !!channel.enabled,
        autoReplies: !!channel.auto_replies,
        restrictTriggers: !!channel.restrict_triggers,
        paused: Number(channel.paused_until) > Math.floor(now / 1000),
        ownerCount: parseJsonArray(channel.owner_ids).length,
        managed: isOwner || permissions.managedChannelIds?.includes(channel.channel_id) || false,
        flaron: {
          known: !!record,
          source: record?.members != null ? 'flaron' : fromSlack ? 'slack' : 'none',
          members: record?.members ?? (fromSlack ? slackSizes.get(channel.channel_id) : null),
          humans: record?.humans ?? null,
          bots: record?.bots ?? null,
        },
        stats: summariseHuddles(
          visibleHuddles.filter((huddle) => huddle.channel_id === channel.channel_id),
          now,
        ),
        // Managers are named people. A viewer who is not allowed to see people
        // in this channel gets a count instead, which still tells the dashboard
        // how the channel is run without naming anyone.
        managers: canShowPeople({
          isPrivate: channel.is_private,
          isOwner,
          isManager,
          permissions,
          channelId: channel.channel_id,
        })
          ? parseJsonArray(channel.owner_ids)
              .map((userId) => {
                const profile = managerProfiles[userId] || {};
                const onBoard = leaderboard.find((row) => row.userId === userId);
                return {
                  userId,
                  displayName: profile.displayName || userId,
                  realName: profile.realName || '',
                  pronouns: profile.pronouns || '',
                  imageUrl: profile.imageUrl || (cachet ? cachet.avatarUrl(userId) : ''),
                  rank: onBoard?.rank ?? null,
                  points: onBoard?.points ?? null,
                };
              })
              .filter((manager) => manager.userId)
          : [],
        managerCount: parseJsonArray(channel.owner_ids).length,
      };
    }),
  );

  return {
    generatedAt: new Date(now).toISOString(),
    viewer: {
      role: permissions.role,
      isOwner,
      isManager,
      managedChannelIds: permissions.managedChannelIds,
    },
    uptime: {
      startedAt: new Date(startedAt).toISOString(),
      seconds: Math.max(0, Math.round((now - startedAt) / 1000)),
      state: statusEvents.at(-1)?.state || 'unknown',
      lastEvent: statusEvents.at(-1) || null,
      incidents,
    },
    huddles: {
      total: visibleHuddles.length,
      active: active.length,
      ended: ended.length,
      optedOut: optedOut.length,
      last24h: last24h.length,
      longestSeconds: durations.length ? Math.round(Math.max(...durations)) : 0,
      averageSeconds: durations.length
        ? Math.round(durations.reduce((total, value) => total + value, 0) / durations.length)
        : 0,
      members: membersSeen.size,
    },
    channels: channelCards,
    botChannels: { count: channelIds.length, ids: isOwner ? channelIds : [] },
    // Slack deep links need the workspace team id, which only auth.test knows.
    teamId: typeof botChannels.team === 'function' ? await botChannels.team() : '',
    leaderboard: leaderboard.map((row) => ({ ...row, channelManager: managerSet.has(row.userId) })),
    logs,
  };
}

/** Leaderboard rows with Cachet profiles attached and opt-out honoured. */
async function withProfiles({ rows, cachet, store }) {
  const visible = rows.filter((row) => (store.isLeaderboardOptIn ? store.isLeaderboardOptIn(row.userId) : true));
  const profiles = cachet ? await cachet.list(visible.map((row) => row.userId)) : {};
  return visible.map((row) => {
    const profile = profiles[row.userId] || {};
    return {
      ...row,
      displayName: profile.displayName || profile.realName || row.userId,
      realName: profile.realName || '',
      pronouns: profile.pronouns || '',
      imageUrl: profile.imageUrl || (cachet ? cachet.avatarUrl(row.userId) : ''),
      profileUrl: cachet ? cachet.profileUrl(row.userId) : '',
    };
  });
}

/** Huddle totals for one channel, for the channel popup. */
function summariseHuddles(huddles, now) {
  const ended = huddles.filter((huddle) => huddle.status === 'ended');
  const durations = ended
    .map((huddle) => (toMillis(huddle.ended_at) - toMillis(huddle.started_at)) / 1000)
    .filter((seconds) => Number.isFinite(seconds) && seconds > 0);
  const members = new Set();
  for (const huddle of huddles) {
    for (const member of parseJsonArray(huddle.participant_json)) {
      members.add(member);
    }
  }
  return {
    total: huddles.length,
    active: huddles.filter((huddle) => huddle.status === 'active').length,
    ended: ended.length,
    optedOut: huddles.filter((huddle) => huddle.status === 'opted_out').length,
    last24h: ended.filter((huddle) => now - toMillis(huddle.ended_at) < DAY_MS).length,
    longestSeconds: durations.length ? Math.round(Math.max(...durations)) : 0,
    averageSeconds: durations.length
      ? Math.round(durations.reduce((total, value) => total + value, 0) / durations.length)
      : 0,
    totalSeconds: Math.round(durations.reduce((total, value) => total + value, 0)),
    members: members.size,
  };
}

function toMillis(value) {
  if (!value) {
    return 0;
  }
  if (typeof value === 'number') {
    return value < 1e12 ? value * 1000 : value;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(String(value).replace(' ', 'T') + (String(value).includes('Z') ? '' : 'Z'));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function parseJsonArray(raw) {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
