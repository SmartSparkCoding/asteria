import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DateTime } from 'luxon';
import { describeHuddleChannels } from '../huddles/channels.js';
import { createPermissions, isSlackUserId, parseOwnerIds } from '../permissions.js';
import { awardItems, POINT_RULES } from '../huddles/points.js';
import { buildStatusRss, readStatusEvents } from '../status/status-core.js';
import { createDashboardAuth } from './auth.js';
import { RECAP_AGREEMENT, RECAP_AGREEMENT_VERSION } from './agreement.js';
import { createCachetDirectory } from './cachet.js';
import { createFlaronDirectory } from './flaron.js';
import { renderHuddlePage } from './huddle-page.js';
import { resolvePermissions } from './permissions.js';
import { renderApp, renderLanding } from './site.js';
import { isLegacyHost, renderRebrandPage } from './rebrand.js';
import { channelSlug, parseRecapLink, renderRecapPage } from './recap.js';
import { buildDashboardStats } from './stats.js';
import { ORBIT_FAVICON } from './theme.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SESSION_COOKIE = 'asteria_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const PAGES = {
  '/dashboard': 'dashboard',
  '/j-log': 'j-log',
  '/huddles': 'huddles',
  '/channels': 'channels',
  '/recaps': 'recaps',
  '/admin': 'admin',
  '/users': 'users',
  '/messages': 'messages',
};
// Long enough to stop a channel being a nuisance for a while without needing a
// separate unpause control.
const PAUSE_SECONDS = 60 * 60 * 12;

function nowEpochSeconds() {
  return Math.floor(Date.now() / 1000);
}

export function createDashboardServer({
  store,
  client,
  botChannels,
  logger = console,
  startedAt = Date.now(),
  // Injectable so tests can drive a huddle page without reaching the network.
  cachet: injectedCachet = null,
  flaron: injectedFlaron = null,
}) {
  const eventsFilePath = process.env.ASTERIA_STATUS_FILE || path.join(repoRoot, 'data', 'status-events.json');
  const cachet = injectedCachet || createCachetDirectory({ logger });
  const flaron = injectedFlaron || createFlaronDirectory({ logger });
  // Flaron will not describe a private channel, so Slack supplies the headcount
  // for those. This has to be the SDK's own method: the equivalent
  // `client.apiCall('conversations.info', …)` answers `unknown_method` on this
  // app, which looks exactly like a channel with no members.
  const memberCache = new Map();
  const MEMBER_TTL_MS = 5 * 60 * 1000;
  // /api/stats is polled every few seconds by every open tab, and it used to ask
  // Slack for the same channel's size and privacy on every single poll. That is
  // what got us rate limited (retry-after 10s, then a 34s response and a 502 at
  // the edge). Both answers change slowly, so they are remembered.
  const infoCache = new Map();
  // Two tabs open at once used to trigger two identical builds, each asking
  // Slack the same questions. Share the build that is already running.
  const statsBuilds = new Map();
  // One build is shared by every section endpoint for a few seconds. Writes that
  // change the board clear it, so this is a request coalescer, not a stale page.
  const statsCache = new Map();
  const STATS_TTL_MS = 15_000;
  const STATS_CACHE_MAX = 120;
  const viewerKey = (session) => `${session?.session?.slack_user_id || 'anon'}:${session?.permissions?.role || 'none'}`;
  const invalidateStats = () => statsCache.clear();

  /**
   * The leaderboard on its own.
   *
   * It needs the database and Cachet profiles, not Flaron, not Slack channel
   * lookups. Building it through the full dashboard payload made the board wait
   * seconds for data it never displays.
   */
  async function buildLeaderboard(session) {
    const channelIds = await botChannels.list();
    const scope = store
      .listTrackedHuddleChannels()
      .filter((channel) => channelIds.includes(channel.channel_id))
      .map((channel) => channel.channel_id);
    // The SQL already drops anyone who opted out of the board.
    const rows = store.listHuddleLeaderboard(25, scope);
    const profiles = cachet && rows.length ? await cachet.list(rows.map((row) => row.user_id)).catch(() => ({})) : {};
    const managers = new Set(store.listHuddleChannels().flatMap((channel) => parseOwnerIds(channel.owner_ids)));
    return rows.map((row, index) => {
      const profile = profiles[row.user_id] || {};
      return {
        rank: index + 1,
        key: row.user_id,
        userId: row.user_id,
        points: Number(row.points) || 0,
        displayName: profile.displayName || profile.realName || row.user_id,
        realName: profile.realName || '',
        pronouns: profile.pronouns || '',
        imageUrl: profile.imageUrl || (cachet ? cachet.avatarUrl(row.user_id) : ''),
        profileUrl: cachet ? cachet.profileUrl(row.user_id) : '',
        channelManager: managers.has(row.user_id),
      };
    });
  }

  async function statsFor(session) {
    const key = viewerKey(session);
    const hit = statsCache.get(key);
    if (hit && Date.now() - hit.at < STATS_TTL_MS) {
      return hit.body;
    }
    let build = statsBuilds.get(key);
    if (!build) {
      build = buildDashboardStats({
        store,
        botChannels,
        permissions: session?.permissions || { role: null, isOwner: false, isManager: false, managedChannelIds: [] },
        cachet,
        flaron,
        slack,
        startedAt,
        statusEvents: readStatusEvents(eventsFilePath),
        viewerId: session?.session?.slack_user_id || '',
      });
      statsBuilds.set(key, build);
      build.finally(() => statsBuilds.delete(key)).catch(() => {});
    }
    const body = await build;
    if (statsCache.size > STATS_CACHE_MAX) {
      statsCache.clear();
    }
    statsCache.set(key, { at: Date.now(), body });
    return body;
  }
  // A member can post a recap, but not fifty of them in a minute.
  const recapPosts = new Map();
  const RECAP_LIMIT = 10;
  const RECAP_WINDOW_MS = 60 * 60 * 1000;
  const INFO_TTL_MS = 10 * 60 * 1000;
  const cachedInfo = async (channelId, compute) => {
    const hit = infoCache.get(channelId);
    if (hit && Date.now() - hit.at < INFO_TTL_MS) {
      return hit.value;
    }
    const value = await compute();
    infoCache.set(channelId, { at: Date.now(), value });
    return value;
  };
  const slack = {
    channelSize: async (channelId) =>
      cachedInfo(`${channelId}:size`, async () => {
        const response = await client.conversations.info({ channel: channelId, include_num_members: true });
        const total = Number(response?.channel?.num_members);
        return Number.isFinite(total) ? total : null;
      }),
    // Same endpoint, different question. `is_private` is tri-state on the way
    // out for the same reason the column is: an unanswered lookup must not be
    // read as "public".
    channelPrivacy: async (channelId) =>
      cachedInfo(`${channelId}:privacy`, async () => {
        const response = await client.conversations.info({ channel: channelId });
        if (!response?.channel || response.channel.is_private == null) {
          return null;
        }
        return response.channel.is_private ? 1 : 0;
      }),
    // Who Slack says is in the call right now. The thread message's room payload
    // is the only live source, and it is what makes "in now" truthful instead of
    // a snapshot from the last time the message was updated.
    roomParticipants: async (channelId, threadRootTs) => {
      if (!channelId || !threadRootTs) {
        return null;
      }
      const response = await client.conversations.replies({
        channel: channelId,
        ts: threadRootTs,
        limit: 1,
        inclusive: true,
      });
      const room = (response?.messages || [])[0]?.room;
      return Array.isArray(room?.participants) ? room.participants : null;
    },
    // Is this signed in person actually in that private channel? Only Slack can
    // answer, and it is the whole gate on seeing a private channel's stats.
    // Cached per viewer/channel because /api/stats is polled every few seconds.
    isMember: async (channelId, userId) => {
      const key = `${channelId}:${userId}`;
      const cached = memberCache.get(key);
      if (cached && Date.now() - cached.at < MEMBER_TTL_MS) {
        return cached.member;
      }
      let member = false;
      let cursor = '';
      for (let page = 0; page < 10; page += 1) {
        const response = await client.conversations.members({
          channel: channelId,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        if (response?.error) {
          break;
        }
        if ((response?.members || []).includes(userId)) {
          member = true;
          break;
        }
        cursor = response?.response_metadata?.next_cursor || '';
        if (!cursor) {
          break;
        }
      }
      memberCache.set(key, { at: Date.now(), member });
      return member;
    },
  };
  const auth = createDashboardAuth({
    client,
    store,
    logger,
    slackClientId: process.env.SLACK_CLIENT_ID || '',
    slackClientSecret: process.env.SLACK_CLIENT_SECRET || '',
  });
  // One set of permission rules, shared with App Home. Reading a channel's
  // settings is a per channel question, so it is asked here rather than trusted
  // from whatever list happened to be in the session cookie.
  const permissions = createPermissions({ store });

  function readSession(req) {
    const cookies = parseCookies(req.headers.cookie || '');
    const token = cookies[SESSION_COOKIE];
    if (!token) {
      return null;
    }
    const session = auth.sessionFromToken(token);
    if (!session) {
      return null;
    }
    const permissions = resolvePermissions({ store, slackUserId: session.slack_user_id });
    return { session, permissions };
  }

  function sendJson(res, statusCode, body, extraHeaders = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    });
    res.end(payload);
  }

  function sendHtml(res, statusCode, html) {
    res.writeHead(statusCode, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'same-origin',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src https: data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
    res.end(html);
  }

  function redirect(res, location) {
    res.writeHead(302, { location, 'cache-control': 'no-store' });
    res.end();
  }

  function sessionCookie(token, req) {
    const secure = isSecure(req);
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure ? '; Secure' : ''}`;
  }

  // Anything that changes how the bot behaves is limited to people who already
  // run a channel, or Jacob. Being able to read the dashboard is not the same
  // thing as being allowed to reconfigure it.
  function canManageChannel(session, channelId) {
    if (!session) {
      return false;
    }
    return permissions.mayConfigureChannel(session.session.slack_user_id, channelId);
  }

  function requireManager(res, session) {
    if (!session) {
      sendJson(res, 401, { error: 'Sign in first' });
      return false;
    }
    if (!session.permissions.isManager) {
      sendJson(res, 403, { error: 'You do not manage any channels' });
      return false;
    }
    return true;
  }

  // An admin viewer can open every admin surface, but only the real owner can
  // change anything. A fake admin gets a 403 with `sike: true`, which the client
  // turns into a full screen SIKE.
  function isAdminViewer(session) {
    return Boolean(session?.permissions.isOwner || session?.permissions.fakeAdmin);
  }

  function sike(res) {
    sendJson(res, 403, {
      error: 'SIKE',
      sike: true,
      message: 'You get view, but not real. Nice try though.',
    });
  }

  // Global settings belong to the owner alone. A channel manager runs a
  // channel; they do not get to change the daily question, the timezone, or
  // who the owner is.
  function requireOwner(res, session) {
    if (!session) {
      sendJson(res, 401, { error: 'Sign in first' });
      return false;
    }
    if (!session.permissions.isOwner) {
      sendJson(res, 403, { error: 'Owner only' });
      return false;
    }
    return true;
  }

  /**
   * May this signed in person open this huddle's page?
   *
   * Jacob, or somebody who was actually in the huddle. A channel manager is not
   * automatically allowed: owning a channel is not the same as having been on
   * the call, and these pages carry the per person breakdown.
   */
  // Only ever bounce back to a path on this site. An absolute URL here would
  // turn the sign-in link into an open redirect, so anything that is not a
  // plain single-slash path is refused and treated as "nowhere in particular".
  function safeNextRoute(value) {
    const next = String(value || '');
    if (!next || !next.startsWith('/') || next.startsWith('//')) {
      return '';
    }
    // Browsers treat `/\evil.example` in a Location header as protocol relative,
    // and control characters do not belong in a path at all.
    if (next.includes('\\') || /[\u0000-\u001f\u007f]/.test(next)) {
      return '';
    }
    return next;
  }

  function canViewHuddle(callId, auth_) {
    if (!auth_) {
      return false;
    }
    if (auth_.permissions.isOwner) {
      return true;
    }
    const userId = auth_.session.slack_user_id;
    if (!userId) {
      return false;
    }
    return store.isHuddleParticipant(callId, userId);
  }

  // An anonymous request is told to sign in. A signed in request that is not
  // allowed is told 404, so the response does not confirm the huddle exists.
  function huddleNotFoundStatus(auth_) {
    return auth_ ? 404 : 401;
  }

  function renderHuddleNotFound() {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>Not found · Jacob's Orbit</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(ORBIT_FAVICON)}" type="image/svg+xml">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d1117;color:#c9d1d9;
font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:center;padding:24px}
a{color:#2ea043}h1{color:#f0f6fc;font-size:20px;margin:0 0 8px}p{margin:0;font-size:14px}</style>
</head><body><div><h1>No such huddle</h1>
<p>If this is your huddle, <a href="/login">sign in with Slack</a> and try again.</p>
<p style="margin-top:14px;font-size:13px;color:#8b949e">Huddle pages are only visible to Orbit's owner and to
people who were in the huddle.</p></div></body></html>`;
  }

  /**
   * Assemble everything a huddle page shows.
   *
   * Names come from Cachet, never a Slack mention, so opening this page does not
   * notify anybody who was on the call.
   */
  async function buildHuddlePageView({ store: huddleStore, cachet: cachetDir, flaron: flaronDir, callId }) {
    const huddle = huddleStore.getHuddle(callId);
    const members = huddleStore.listHuddleMembers(callId);
    const awards = huddleStore.listHuddleAwards(callId);
    const awardsByUser = new Map(awards.map((award) => [award.userId, award]));

    // Attendance comes from presence intervals, so a person who left and came
    // back shows the time they actually spent rather than the whole call. The
    // member roster is only a fallback for huddles recorded before intervals.
    const attendance = huddleStore.computeHuddleAttendance(callId, {
      startedAt: huddle.started_at,
      endedAt: huddle.ended_at,
    });
    const attendanceByUser = new Map(attendance.participants.map((entry) => [entry.userId, entry]));

    const membersByUser = new Map(members.map((member) => [member.user_id, member]));
    const participants = [
      ...attendance.participants.map((entry) => ({
        userId: entry.userId,
        // Keep the number. A partial stretch used to render as 0m, which read as
        // "never here" for somebody who was in the call for hours.
        durationSeconds: entry.seconds,
        provableSeconds: entry.seconds,
        partial: entry.partial,
        isIn: Boolean(Number(membersByUser.get(entry.userId)?.is_in)),
        points: awardsByUser.get(entry.userId)?.points ?? 0,
        reasons: awardsByUser.get(entry.userId)?.reasons ?? [],
      })),
      ...members
        .filter((member) => !attendanceByUser.has(member.user_id))
        .map((member) => ({
          userId: member.user_id,
          durationSeconds:
            member.first_seen_at != null && member.last_seen_at != null
              ? Math.max(0, member.last_seen_at - member.first_seen_at)
              : huddle.ended_at && member.first_seen_at
                ? Math.max(0, huddle.ended_at - member.first_seen_at)
                : null,
          provableSeconds: 0,
          partial: true,
          isIn: Boolean(Number(member.is_in)),
          points: awardsByUser.get(member.user_id)?.points ?? 0,
          reasons: awardsByUser.get(member.user_id)?.reasons ?? [],
        })),
    ].sort((a, b) => b.points - a.points || (b.provableSeconds || 0) - (a.provableSeconds || 0));

    // Overlay the live roster so "in now" is not a stale snapshot.
    if (huddle.channel_id && huddle.thread_root_ts && typeof slack.roomParticipants === 'function') {
      const live = await slack.roomParticipants(huddle.channel_id, huddle.thread_root_ts).catch(() => null);
      if (live) {
        const inNow = new Set(live);
        for (const participant of participants) {
          participant.isIn = inNow.has(participant.userId);
        }
      }
    }

    const ids = participants.map((participant) => participant.userId);
    const [profiles, flaronRecord] = await Promise.all([
      cachetDir.list(ids),
      huddle.channel_id ? flaronDir.fetchChannel(huddle.channel_id).catch(() => null) : Promise.resolve(null),
    ]);
    for (const participant of participants) {
      participant.name = profiles[participant.userId]?.displayName || participant.userId;
      participant.avatarUrl = profiles[participant.userId]?.imageUrl || '';
    }

    const timezone = huddleStore.getSettings().timezone || 'UTC';
    const isLive = huddle.status === 'active' && !huddle.ended_at;
    const durationSeconds = huddle.ended_at && huddle.started_at ? Math.max(0, huddle.ended_at - huddle.started_at) : 0;

    return {
      huddle,
      participants,
      channel: {
        // Flaron is the authority on the name. If it cannot answer, fall back to
        // the raw id rather than a Slack channel link, which would render as
        // "#unknown" in some contexts.
        name: flaronRecord?.name || '',
        isPrivate: huddleStore.getHuddleChannel(huddle.channel_id || '')?.is_private ?? -1,
      },
      totalPoints: awards.reduce((sum, award) => sum + award.points, 0),
      startedLabel: huddle.started_at
        ? DateTime.fromSeconds(huddle.started_at, { zone: timezone }).toFormat('d LLL yyyy, HH:mm')
        : 'unknown',
      endedLabel:
        huddle.ended_at && !isLive
          ? DateTime.fromSeconds(huddle.ended_at, { zone: timezone }).toFormat('d LLL yyyy, HH:mm')
          : '',
      durationSeconds: isLive ? Math.max(0, Math.floor(Date.now() / 1000) - (huddle.started_at || 0)) : durationSeconds,
      isLive,
      // Older rows carry the marker as a bare string, newer ones as an item.
      reconstructed: awards.some((award) =>
        award.reasons.some((reason) => reason === 'backfilled' || reason?.label === 'backfilled'),
      ),
      // Some attendance could not be proven, so the page says so rather than
      // presenting a partial record as if it were complete.
      attendancePartial: attendance.partial || participants.every((participant) => participant.partial),
      timezone,
    };
  }

  /**
   * Per channel settings for the huddle customisation tab.
   *
   * A manager sees only the channels they run. The owner sees every configured
   * channel plus every channel the bot is in but has no settings row for, so a
   * new channel can be adopted instead of silently never appearing.
   */
  async function resolveChannelBySlug(slug) {
    const ids = await botChannels.list();
    const names = await botChannels.names(ids);
    const wanted = String(slug || '').toLowerCase();
    if (/^c[a-z0-9]{6,}$/.test(wanted) && ids.includes(slug.toUpperCase())) {
      return { id: slug.toUpperCase(), name: names[slug.toUpperCase()] || slug.toUpperCase() };
    }
    for (const id of ids) {
      const name = names[id] || '';
      if (name && channelSlug(name) === wanted) {
        return { id, name };
      }
    }
    return null;
  }

  async function describeHuddleConfig(session) {
    const { channels, available } = await describeHuddleChannels({
      store,
      botChannels,
      userId: session?.session?.slack_user_id || '',
      isAdminViewer: Boolean(session?.permissions.fakeAdmin),
    });

    const ownerIds = [...new Set(channels.flatMap((c) => c.ownerIds))];
    const profiles = ownerIds.length ? await cachet.list(ownerIds).catch(() => ({})) : {};
    const now = nowEpochSeconds();
    const recapCounts = typeof store.countHuddleRecaps === 'function' ? store.countHuddleRecaps() : {};

    const cards = channels.map((channel) => {
      const pausedUntil = channel.pausedUntil;
      return {
        channelId: channel.channelId,
        name: channel.name || channel.channelId,
        enabled: channel.enabled,
        auto_replies: channel.autoReplies,
        restrict_triggers: channel.restrictTriggers,
        condensed_review: channel.condensed,
        paused: pausedUntil > now,
        pausedUntilLabel:
          pausedUntil > now ? new Date(pausedUntil * 1000).toISOString().slice(0, 16).replace('T', ' ') : 'never',
        recapCount: recapCounts[channel.channelId] || 0,
        owners: channel.ownerIds.map((id) => ({
          id,
          name: profiles[id]?.displayName || profiles[id]?.realName || '',
        })),
      };
    });

    return {
      channels: cards,
      available,
      // Kept so an older open tab keeps working through a deploy.
      unconfigured: available,
    };
  }

  /**
   * The admin tab, which is mostly a list of what the integration cannot do.
   */
  async function describeAdmin() {
    const inBot = await botChannels.list();
    const names = await botChannels.names(inBot);
    const configured = new Set(store.listHuddleChannels().map((c) => c.channel_id));
    const huddles = store.listHuddles();
    const noChannel = huddles.filter((h) => !h.channel_id);
    const noThread = huddles.filter((h) => h.channel_id && !h.thread_root_ts);

    return {
      permissions: [
        {
          label: 'Read who the bot is in',
          granted: true,
          detail: 'users.conversations, so channel scoping works',
        },
        {
          label: 'Read DM and group DM membership',
          granted: false,
          detail:
            'needs im:read and mpim:read. Without it a huddle held in a DM cannot be verified, so it scores nothing. Channel huddles are unaffected.',
        },
        {
          label: 'Read a huddle roster',
          granted: true,
          detail: 'the roster Slack publishes on the huddle thread; no audio is read or stored',
        },
        {
          label: 'Post and update its own messages',
          granted: true,
          detail: 'needed to turn a button press into a confirmation',
        },
      ],
      orphans: {
        total: noChannel.length + noThread.length,
        noChannel: noChannel.length,
        noThread: noThread.length,
        active: [...noChannel, ...noThread].filter((h) => h.status === 'active').length,
        ended: [...noChannel, ...noThread].filter((h) => h.status !== 'active').length,
      },
      membership: {
        'channels the bot is in': String(inBot.length),
        'with settings here': String([...configured].filter((id) => inBot.includes(id)).length),
        'tracked but unconfigured': String([...configured].filter((id) => !inBot.includes(id)).length),
        names: inBot.map((id) => `#${names[id] || id}`).join(', ') || 'none',
      },
    };
  }

  /**
   * Everyone with a relationship to the dashboard. Fake admins are shown as
   * owners on purpose: from the inside this panel is supposed to look real.
   */
  function describeUsers({ viewerIsOwner = false } = {}) {
    const settings = store.getSettings();
    const ownerId = settings.personal_channel_owner_id;
    const fakeIds = store.getFakeAdminIds();
    const managers = new Set(
      store.listHuddleChannels().flatMap((row) => parseOwnerIds(row.owner_ids).filter((id) => id !== ownerId)),
    );
    const seen = new Map(store.listDashboardUsers().map((row) => [row.slack_user_id, row]));
    const ids = new Set([ownerId, ...fakeIds, ...managers, ...seen.keys()].filter(Boolean));
    const users = [...ids].map((id) => {
      const row = seen.get(id) || {};
      const role = id === ownerId || fakeIds.includes(id) ? 'owner' : managers.has(id) ? 'manager' : 'user';
      return {
        id,
        name: row.display_name || '',
        role,
        optedIn: row.leaderboard_opt_in == null ? true : Number(row.leaderboard_opt_in) === 1,
        lastLoginAt: row.last_login_at || '',
        // Only the real owner is told who is a fake admin. A fake admin sees the
        // cosmetic owner label and a toggle that looks live, which is the joke.
        fakeAdmin: viewerIsOwner ? fakeIds.includes(id) : role === 'owner',
      };
    });
    const order = { owner: 0, manager: 1, user: 2 };
    users.sort((a, b) => order[a.role] - order[b.role] || a.id.localeCompare(b.id));
    return {
      users,
      counts: {
        owner: users.filter((u) => u.role === 'owner').length,
        manager: users.filter((u) => u.role === 'manager').length,
        user: users.filter((u) => u.role === 'user').length,
      },
    };
  }

  async function readJsonBody(req, limitBytes = 4096) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limitBytes) {
        throw new Error('Request body too large');
      }
      chunks.push(chunk);
    }
    if (chunks.length === 0) {
      return {};
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new Error('Body must be JSON');
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      logger.error?.('[dashboard] request failed', error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Something broke on our side.' });
      } else {
        res.end();
      }
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const route = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method || 'GET';

    if (route === '/health' || route === '/healthz') {
      const events = readStatusEvents(eventsFilePath);
      const lastEvent = events.at(-1) ?? null;
      sendJson(res, 200, {
        ok: true,
        status: lastEvent?.state ?? 'unknown',
        lastEvent,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        startedAt: new Date(startedAt).toISOString(),
      });
      return;
    }

    if (route === '/rss.xml' || route === '/rss') {
      const events = readStatusEvents(eventsFilePath);
      res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': 'no-store' });
      res.end(buildStatusRss({ events, siteUrl: auth.publicUrl(req) }));
      return;
    }

    // The old host stops being a product and becomes a notice. Health and RSS
    // keep working so a monitor never starts paging during the move, auth
    // callbacks are allowed through so a sign in that started on the old domain
    // finishes, and the API keeps answering so a tab left open does not break.
    if (
      method === 'GET' &&
      isLegacyHost(req.headers.host) &&
      !route.startsWith('/auth/') &&
      !route.startsWith('/api/') &&
      route !== '/avatar'
    ) {
      sendHtml(res, 200, renderRebrandPage({ path: url.pathname, search: url.search }));
      return;
    }

    if (route === '/login') {
      if (!auth.oauthConfigured) {
        // Slack sign-in is the only way in now, so there is nothing to send them to.
        redirect(res, '/');
        return;
      }
      const state = auth.randomState();
      const nonce = auth.randomState();
      const cookieAttrs = `Path=/; HttpOnly; SameSite=Lax; Max-Age=600${isSecure(req) ? '; Secure' : ''}`;
      // Remember where they were going. Without this, following a huddle link
      // while signed out dropped you on the dashboard after signing in, which
      // looks exactly like the link did nothing.
      const next = safeNextRoute(url.searchParams.get('next'));
      res.writeHead(302, {
        location: auth.slackAuthorizeUrl(req, state, nonce),
        // Three cookies, so they have to be an array. Joining them into one header
        // with "; " is parsed inconsistently and silently dropped the nonce, which
        // turned the nonce check in the callback into a no-op.
        'set-cookie': [
          `asteria_oauth_state=${state}; ${cookieAttrs}`,
          `asteria_oauth_nonce=${nonce}; ${cookieAttrs}`,
          `${next ? `asteria_oauth_next=${encodeURIComponent(next)}; ${cookieAttrs}` : ''}`,
        ].filter(Boolean),
        'cache-control': 'no-store',
      });
      res.end();
      return;
    }

    if (route === '/auth/slack/callback') {
      const state = url.searchParams.get('state') || '';
      const cookies = parseCookies(req.headers.cookie || '');
      const expected = cookies.asteria_oauth_state;
      const expectedNonce = cookies.asteria_oauth_nonce || '';
      if (!expected || state !== expected) {
        sendHtml(res, 400, renderLanding({ signedIn: Boolean(readSession(req)) }));
        return;
      }
      try {
        const slackUser = await auth.exchangeSlackCode(req, url.searchParams.get('code') || '', expectedNonce);
        const permissions = resolvePermissions({ store, slackUserId: slackUser.id });
        const token = auth.completeLogin({
          slackUserId: slackUser.id,
          displayName: slackUser.profile?.display_name || '',
          permissions,
        });
        res.writeHead(302, {
          location: safeNextRoute(decodeURIComponent(cookies.asteria_oauth_next || '')) || '/dashboard',
          'set-cookie': [
            sessionCookie(token, req),
            'asteria_oauth_state=; Path=/; Max-Age=0',
            'asteria_oauth_nonce=; Path=/; Max-Age=0',
            'asteria_oauth_next=; Path=/; Max-Age=0',
          ],
          'cache-control': 'no-store',
        });
        res.end();
      } catch (error) {
        logger.warn?.('[dashboard] Slack sign-in failed', error.message);
        redirect(res, '/?error=slack');
      }
      return;
    }

    if (route === '/auth/magic') {
      const result = auth.consumeMagicLink(url.searchParams.get('token') || '');
      if (!result.ok) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end(result.error);
        return;
      }
      const permissions = resolvePermissions({ store, slackUserId: result.slackUserId });
      const token = auth.completeLogin({
        slackUserId: result.slackUserId,
        displayName: store.getDashboardUser?.(result.slackUserId)?.display_name || '',
        permissions,
      });
      // Straight into the dashboard with the session already set, which is the
      // whole point of a link: nothing to copy, nothing to type.
      res.writeHead(302, {
        location: '/dashboard',
        'set-cookie': [sessionCookie(token, req)],
        'cache-control': 'no-store',
      });
      res.end();
      return;
    }

    if (route === '/logout' && method === 'POST') {
      const cookies = parseCookies(req.headers.cookie || '');
      if (cookies[SESSION_COOKIE]) {
        store.deleteDashboardSession(cookies[SESSION_COOKIE]);
      }
      res.writeHead(302, {
        location: '/',
        'set-cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isSecure(req) ? '; Secure' : ''}`,
        'cache-control': 'no-store',
      });
      res.end();
      return;
    }

    if (route === '/api/auth/code' && method === 'POST') {
      const { slackUserId } = await readJsonBody(req);
      try {
        await auth.startDmVerification(slackUserId);
      } catch (error) {
        // A mistyped member id, or a DM Slack will not let the bot start, is
        // the visitor's to fix and the sentence says how, so it must not read
        // like a server fault.
        if (!error.status) {
          throw error;
        }
        sendJson(res, error.status, { error: error.message });
        return;
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (route === '/api/auth/verify' && method === 'POST') {
      const { slackUserId, code } = await readJsonBody(req);
      const result = auth.verifyDmCode(slackUserId, code);
      if (!result.ok) {
        sendJson(res, 400, { error: result.error });
        return;
      }
      const permissions = resolvePermissions({ store, slackUserId });
      const profile = await cachet.fetchProfile(slackUserId).catch(() => null);
      const token = auth.completeLogin({
        slackUserId,
        displayName: profile?.displayName || '',
        permissions,
      });
      sendJson(res, 200, { ok: true, role: permissions.role }, { 'set-cookie': sessionCookie(token, req) });
      return;
    }

    const auth_ = readSession(req);

    if (route === '/api/stats' && method === 'GET') {
      if (!auth_) {
        sendJson(res, 401, { error: 'Sign in with Slack to see the dashboard.' });
        return;
      }
      const stats = await statsFor(auth_);
      sendJson(res, 200, {
        ...stats,
        viewer: {
          ...stats.viewer,
          signedIn: true,
          userId: auth_.session.slack_user_id,
          leaderboardOptIn: store.isLeaderboardOptedIn(auth_.session.slack_user_id),
        },
      });
      return;
    }

    // The dashboard shell renders immediately and asks for these separately, so
    // one slow section never holds up the rest of the page.
    if (route === '/api/overview' && method === 'GET') {
      if (!auth_) {
        sendJson(res, 401, { error: 'Sign in with Slack to see the dashboard.' });
        return;
      }
      const channelIds = await botChannels.list();
      const overview = store.huddleOverview(channelIds);
      const events = readStatusEvents(eventsFilePath);
      sendJson(res, 200, {
        generatedAt: new Date().toISOString(),
        ...overview,
        logs: auth_.permissions.isOwner ? store.listTriggerLog(20, channelIds) : [],
        uptime: {
          startedAt: new Date(startedAt).toISOString(),
          seconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
          state: events.at(-1)?.state || 'unknown',
        },
        viewer: {
          role: auth_.permissions.role,
          isOwner: auth_.permissions.isOwner,
          isManager: auth_.permissions.isManager,
          fakeAdmin: Boolean(auth_.permissions.fakeAdmin),
          signedIn: true,
          userId: auth_.session.slack_user_id,
        },
      });
      return;
    }

    if (route === '/api/leaderboard' && method === 'GET') {
      if (!auth_) {
        sendJson(res, 401, { error: 'Sign in with Slack to see the board.' });
        return;
      }
      const rows = await buildLeaderboard(auth_);
      sendJson(res, 200, {
        generatedAt: new Date().toISOString(),
        rows,
        viewer: {
          role: auth_.permissions.role,
          isOwner: auth_.permissions.isOwner,
          isManager: auth_.permissions.isManager,
          signedIn: true,
          userId: auth_.session.slack_user_id,
          leaderboardOptIn: store.isLeaderboardOptedIn(auth_.session.slack_user_id),
        },
      });
      return;
    }

    if (route === '/api/channels' && method === 'GET') {
      if (!auth_) {
        sendJson(res, 401, { error: 'Sign in with Slack to see the channels.' });
        return;
      }
      const stats = await statsFor(auth_);
      sendJson(res, 200, { generatedAt: stats.generatedAt, channels: stats.channels });
      return;
    }

    if (route === '/api/huddles' && method === 'GET') {
      if (!auth_) {
        sendJson(res, 401, { error: 'Sign in with Slack to see the huddles.' });
        return;
      }
      const channelIds = await botChannels.list();
      // A private channel's huddles are only for its members, its manager and
      // the owner. Public channels are workspace-wide.
      const isOwner = auth_.permissions.isOwner;
      const managed = new Set(
        Array.isArray(auth_.permissions.managedChannelIds) ? auth_.permissions.managedChannelIds : [],
      );
      const visibleChannelIds = [];
      for (const id of channelIds) {
        const row = store.getHuddleChannel(id);
        const isPrivate = row ? Number(row.is_private) !== 0 : false;
        if (!isPrivate || isOwner || managed.has(id)) {
          visibleChannelIds.push(id);
        } else if (
          typeof slack.isMember === 'function' &&
          (await slack.isMember(id, auth_.session.slack_user_id).catch(() => false))
        ) {
          visibleChannelIds.push(id);
        }
      }
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 40));
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      const sort = String(url.searchParams.get('sort') || 'recent');
      const channelId = String(url.searchParams.get('channel') || '');
      const { huddles, total } = store.listHuddleSummaries({
        limit,
        offset,
        channelId,
        channelIds: visibleChannelIds,
        sort,
      });
      const names =
        visibleChannelIds.length && typeof botChannels.names === 'function'
          ? await botChannels.names(visibleChannelIds).catch(() => ({}))
          : {};
      const now = Math.floor(Date.now() / 1000);
      const scoped = huddles.filter((huddle) => visibleChannelIds.includes(huddle.channelId));
      const channels = [...new Set(scoped.map((huddle) => huddle.channelId))].map((id) => ({
        id,
        name: names[id] || id,
      }));
      sendJson(res, 200, {
        total,
        channels,
        huddles: scoped.map((huddle) => ({
          ...huddle,
          channelName: names[huddle.channelId] || huddle.channelId,
          durationSeconds: huddle.endedAt
            ? Math.max(0, huddle.endedAt - huddle.startedAt)
            : Math.max(0, now - huddle.startedAt),
          isLive: huddle.status === 'active' && !huddle.endedAt,
          url: `/${huddle.callId}`,
        })),
      });
      return;
    }

    if (route === '/api/me/points' && method === 'GET') {
      if (!auth_) {
        sendJson(res, 401, { error: 'Sign in first.' });
        return;
      }
      const totals = new Map();
      for (const reasons of store.listUserAwardReasons(auth_.session.slack_user_id)) {
        for (const item of awardItems(reasons)) {
          const entry = totals.get(item.kind) ?? { kind: item.kind, points: 0, count: 0 };
          entry.points += item.points;
          entry.count += 1;
          totals.set(item.kind, entry);
        }
      }
      const items = [...totals.values()]
        .filter((entry) => entry.points !== 0)
        .sort((a, b) => b.points - a.points)
        .map((entry) => ({
          ...entry,
          label: POINT_RULES.find((rule) => rule.kind === entry.kind)?.label || 'Something else',
        }));
      sendJson(res, 200, {
        total: items.reduce((sum, entry) => sum + entry.points, 0),
        items,
        rules: POINT_RULES,
      });
      return;
    }

    if (route === '/api/me/agreement') {
      if (!auth_) {
        sendJson(res, 401, { error: 'Sign in first.' });
        return;
      }
      const userId = auth_.session.slack_user_id;
      if (method === 'POST') {
        const body = await readJsonBody(req);
        if (typeof body.agreed !== 'boolean') {
          sendJson(res, 400, { error: 'agreed must be true or false' });
          return;
        }
        store.setUserAgreement(userId, { version: RECAP_AGREEMENT_VERSION, agreed: body.agreed });
      } else if (method !== 'GET') {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }
      const row = store.getUserAgreement(userId);
      const decided = Boolean(row) && String(row.version || '') === RECAP_AGREEMENT_VERSION;
      sendJson(res, 200, {
        version: RECAP_AGREEMENT_VERSION,
        // `required` is what the page keys off: until this version is answered
        // the question is still open, and an answer to an older wording does
        // not count.
        required: !decided,
        agreed: decided ? Number(row.agreed) === 1 : null,
        decidedAt: decided ? String(row.updated_at || '') : null,
        title: RECAP_AGREEMENT.title,
        body: RECAP_AGREEMENT.body,
        note: RECAP_AGREEMENT.note,
      });
      return;
    }

    if (route === '/api/me/opt-in' && method === 'POST') {
      if (!auth_) {
        sendJson(res, 401, { error: 'Sign in first.' });
        return;
      }
      const { optedIn } = await readJsonBody(req);
      const updated = store.setDashboardLeaderboardOptIn(auth_.session.slack_user_id, Boolean(optedIn));
      invalidateStats();
      sendJson(res, 200, { ok: true, leaderboardOptIn: Number(updated?.leaderboard_opt_in ?? 0) === 1 });
      return;
    }

    if (route === '/avatar' && method === 'GET') {
      const slackUserId = url.searchParams.get('u') || '';
      if (!/^[UW][A-Z0-9]{7,}$/.test(slackUserId)) {
        sendJson(res, 400, { error: 'bad user id' });
        return;
      }
      res.writeHead(302, { location: cachet.avatarUrl(slackUserId), 'cache-control': 'public, max-age=86400' });
      res.end();
      return;
    }

    // A huddle's own page, at /<call id>, and the live feed behind it.
    //
    // These are not linked from anywhere public. The rule is Jacob or somebody
    // who was actually in the huddle. Slack's link unfetcher has no session
    // cookie, so pasting one of these links into a channel shows nothing to
    // anyone who is not already allowed to see it.
    const huddleLiveMatch = /^\/api\/huddle\/([^/]+)\/live$/.exec(route);
    if (huddleLiveMatch && method === 'GET') {
      const callId = decodeURIComponent(huddleLiveMatch[1]);
      if (!canViewHuddle(callId, auth_)) {
        sendJson(res, huddleNotFoundStatus(auth_), { error: 'No such huddle' });
        return;
      }
      const huddle = store.getHuddle(callId);
      if (!huddle) {
        sendJson(res, 404, { error: 'No such huddle' });
        return;
      }
      const isLive = huddle.status === 'active' && !huddle.ended_at;
      const awards = store.listHuddleAwards(callId);
      sendJson(res, 200, {
        callId,
        isLive,
        participants: store.listHuddleMembers(callId).length,
        totalPoints: awards.reduce((sum, award) => sum + award.points, 0),
      });
      return;
    }

    // Early on, huddle links were posted as /huddle/<id>, which no route ever
    // matched, so every one of them is a 404 sitting in somebody's channel
    // history right now. The page has always lived at /<id>. Send the old shape
    // to the new one rather than leaving those links dead, and rather than
    // having to recall and repost each summary.
    const legacyHuddleMatch = /^\/huddle\/(R[0-9A-Z]{6,20})$/.exec(route);
    if (legacyHuddleMatch && method === 'GET') {
      redirect(res, `/${legacyHuddleMatch[1]}`);
      return;
    }

    const huddlePageMatch = /^\/(R[0-9A-Z]{6,20})$/.exec(route);
    if (huddlePageMatch && method === 'GET') {
      const callId = huddlePageMatch[1];
      if (!canViewHuddle(callId, auth_)) {
        // Not signed in goes to sign in, which is also what makes a Slack
        // unfurl harmless. Signed in but not allowed gets a 404 rather than a
        // 403, so the page does not confirm that the huddle exists.
        if (!auth_) {
          redirect(res, `/login?next=${encodeURIComponent(route)}`);
          return;
        }
        sendHtml(res, 404, renderHuddleNotFound());
        return;
      }
      const huddle = store.getHuddle(callId);
      if (!huddle) {
        sendHtml(res, 404, renderHuddleNotFound());
        return;
      }
      const page = await buildHuddlePageView({ store, cachet, flaron, callId });
      sendHtml(res, 200, renderHuddlePage(page));
      return;
    }

    if (route === '/' && method === 'GET') {
      sendHtml(res, 200, renderLanding({ signedIn: Boolean(auth_) }));
      return;
    }

    if (route === '/api/recaps' && method === 'GET') {
      const channelId = String(url.searchParams.get('channelId') || '');
      const canView =
        isAdminViewer(auth_) || (auth_ && permissions.mayConfigureChannel(auth_.session.slack_user_id, channelId));
      if (!canView) {
        sendJson(res, 403, { error: 'Not your channel' });
        return;
      }
      sendJson(res, 200, { recaps: store.listHuddleRecaps(channelId) });
      return;
    }

    if (route === '/api/recaps' && method === 'POST') {
      if (!auth_) {
        sendJson(res, 401, { error: 'Sign in first' });
        return;
      }
      const body = await readJsonBody(req, 16384);
      const channelId = String(body?.channelId || '');
      const text = String(body?.body || '').trim();
      const accepted = Boolean(body?.accepted);
      if (!store.hasHuddleMemberInChannel(auth_.session.slack_user_id, channelId)) {
        sendJson(res, 403, { error: 'Join a huddle in this channel first' });
        return;
      }
      if (!accepted) {
        sendJson(res, 400, { error: 'Tick the policy box first' });
        return;
      }
      const recapKey = `${auth_.session.slack_user_id}:${channelId}`;
      const nowMs = Date.now();
      const recent = (recapPosts.get(recapKey) || []).filter((at) => nowMs - at < RECAP_WINDOW_MS);
      if (recent.length >= RECAP_LIMIT) {
        sendJson(res, 429, { error: 'That is a lot of recaps. Try again later.' });
        return;
      }
      recent.push(nowMs);
      recapPosts.set(recapKey, recent);
      if (!text) {
        sendJson(res, 400, { error: 'Write something first' });
        return;
      }
      if (text.length > 2000) {
        sendJson(res, 400, { error: 'Keep it under 2000 characters' });
        return;
      }
      const rawLinks = Array.isArray(body?.links) ? body.links.slice(0, 5) : [];
      const links = [];
      for (const raw of rawLinks) {
        const parsed = parseRecapLink(raw, channelId);
        if (!parsed) {
          sendJson(res, 400, { error: 'Links must be Slack permalinks from this channel' });
          return;
        }
        links.push(parsed);
      }
      store.addHuddleRecap({
        channelId,
        userId: auth_.session.slack_user_id,
        body: text,
        links,
        policyAcceptedAt: new Date().toISOString(),
      });
      store.recordTriggerLog({
        userId: auth_.session.slack_user_id,
        action: 'recap_submitted',
        detail: channelId,
        channelId,
      });
      sendJson(res, 200, { ok: true });
      return;
    }

    // A channel's recap collection page: /<channel-name>/recaps.
    const recapPageMatch = /^\/([a-z0-9][a-z0-9-]{0,59})\/recaps$/.exec(route);
    if (recapPageMatch && method === 'GET') {
      const channel = await resolveChannelBySlug(recapPageMatch[1]);
      if (!channel) {
        sendHtml(
          res,
          404,
          `<!doctype html><meta charset="utf-8"><title>No such channel</title><body style="font-family:system-ui;background:#1e1e2e;color:#cdd6f4;padding:40px">No channel called ${encodeURIComponent(recapPageMatch[1])}.</body>`,
        );
        return;
      }
      if (!auth_) {
        redirect(res, `/login?next=${encodeURIComponent(route)}`);
        return;
      }
      const userId = auth_.session.slack_user_id;
      const allowed = store.hasHuddleMemberInChannel(userId, channel.id);
      const submissions = store.listHuddleRecaps(channel.id, { userId });
      sendHtml(
        res,
        200,
        renderRecapPage({
          channel,
          viewer: auth_.permissions,
          submissions,
          error: allowed ? '' : `You can submit once you have joined a huddle in #${channel.name} at least once.`,
        }),
      );
      return;
    }

    // The tabbed pages. All three are signed-in only: they are settings, not a
    // public readout. The admin panel and the j-log manager are owner only; the
    // huddle tab belongs to whoever manages at least one channel.
    if (PAGES[route] && method === 'GET') {
      if (!auth_) {
        redirect(res, `/login?next=${encodeURIComponent(route)}`);
        return;
      }
      const needsOwner = route === '/admin' || route === '/j-log' || route === '/users' || route === '/messages';
      const needsManager = route === '/huddles' || route === '/channels' || route === '/recaps';
      const allowedOwnerPage = auth_.permissions.isOwner || auth_.permissions.fakeAdmin;
      if ((needsOwner && !allowedOwnerPage) || (needsManager && !auth_.permissions.isManager)) {
        sendHtml(
          res,
          403,
          renderApp({
            oauthConfigured: auth.oauthConfigured,
            signedIn: true,
            role: auth_.permissions.role,
            displayRole: auth_.permissions.fakeAdmin ? 'owner' : auth_.permissions.role,
            isAdminViewer: isAdminViewer(auth_),
            baseUrl: '',
            view: 'home',
          }),
        );
        return;
      }
      sendHtml(
        res,
        200,
        renderApp({
          oauthConfigured: auth.oauthConfigured,
          signedIn: true,
          role: auth_.permissions.role,
          displayRole: auth_.permissions.fakeAdmin ? 'owner' : auth_.permissions.role,
          isAdminViewer: isAdminViewer(auth_),
          baseUrl: '',
          view: PAGES[route],
        }),
      );
      return;
    }

    if (route === '/api/j-log' && method === 'GET') {
      // Readable by an admin viewer, so the fake admin sees a real looking page.
      if (!isAdminViewer(auth_)) {
        if (!auth_) {
          sendJson(res, 401, { error: 'Sign in first' });
          return;
        }
        return sike(res);
      }
      sendJson(res, 200, {
        settings: store.getSettings(),
        draft: store.getDraft() || null,
        recentQuestions: store.getRecentDailyQuestionTexts(5) || [],
      });
      return;
    }

    if (route === '/api/j-log/draft' && method === 'POST') {
      if (auth_?.permissions.fakeAdmin) return sike(res);
      if (!requireOwner(res, auth_)) return;
      const body = await readJsonBody(req, 16384);
      if (body?.clear) {
        store.clearDraft();
        sendJson(res, 200, { ok: true, draft: null });
        return;
      }
      const saved = store.saveDraft({
        main_update_text: String(body?.main_update_text ?? ''),
        song_text: String(body?.song_text ?? ''),
        event_text: String(body?.event_text ?? ''),
      });
      sendJson(res, 200, { ok: true, draft: saved || null });
      return;
    }

    if (route === '/api/j-log/settings' && method === 'POST') {
      if (auth_?.permissions.fakeAdmin) return sike(res);
      if (!requireOwner(res, auth_)) return;
      const body = await readJsonBody(req);
      // The App Home and the dashboard share one settings row. Only the fields
      // this page actually edits may be written, so a stray key cannot reach
      // personal_channel_owner_id and hand the caller the whole bot.
      const patch = {};
      for (const key of [
        'daily_question_enabled',
        'daily_question_include_in_daily_update',
        'daily_question_prompt',
        'daily_question_send_time',
        'daily_question_reply_text',
        'daily_update_thread_enabled',
        'daily_update_reminder_enabled',
        'daily_update_reminder_time',
        'timezone',
        'bot_display_name',
      ]) {
        if (key in (body || {})) {
          patch[key] = body[key];
        }
      }
      const merged = store.updateSettings(patch);
      sendJson(res, 200, { ok: true, settings: merged });
      return;
    }

    if (route === '/api/huddles/config' && method === 'GET') {
      if (!requireManager(res, auth_)) return;
      sendJson(res, 200, await describeHuddleConfig(auth_));
      return;
    }

    if (route === '/api/huddles/config' && method === 'POST') {
      if (auth_?.permissions.fakeAdmin) return sike(res);
      if (!requireManager(res, auth_)) return;
      const body = await readJsonBody(req);
      const channelId = String(body?.channelId || '');
      if (!channelId || !canManageChannel(auth_, channelId)) {
        sendJson(res, 403, { error: 'Not your channel' });
        return;
      }
      // A channel with no row has to exist before its flags can be set, but this
      // used to call upsertHuddleChannel with only an id, which writes the whole
      // row. Every toggle therefore reset the name, the owner list and every
      // other flag to its default, which is how a manager turned one switch on
      // and lost their own channel. Create the row only when it is missing.
      store.ensureHuddleChannel(channelId);
      const allowed = ['enabled', 'auto_replies', 'restrict_triggers', 'condensed_review'];
      for (const field of allowed) {
        if (field in (body || {})) {
          store.setHuddleChannelFlag(channelId, field, body[field] ? 1 : 0);
        }
      }
      if ('paused' in (body || {})) {
        store.setHuddleChannelFlag(channelId, 'paused_until', body.paused ? nowEpochSeconds() + PAUSE_SECONDS : 0);
      }
      invalidateStats();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (route === '/api/huddles/owners' && method === 'POST') {
      if (auth_?.permissions.fakeAdmin) return sike(res);
      if (!requireManager(res, auth_)) return;
      const body = await readJsonBody(req);
      const channelId = String(body?.channelId || '');
      if (!channelId || !canManageChannel(auth_, channelId)) {
        sendJson(res, 403, { error: 'Not your channel' });
        return;
      }
      const row = store.getHuddleChannel(channelId);
      const current = [...parseOwnerIds(row?.owner_ids)];
      const add = String(body?.add || '')
        .trim()
        .toUpperCase();
      const remove = String(body?.remove || '')
        .trim()
        .toUpperCase();
      if (add && !isSlackUserId(add)) {
        sendJson(res, 400, { error: 'That does not look like a Slack user id' });
        return;
      }
      const next = remove ? current.filter((id) => id !== remove) : add ? [...new Set([...current, add])] : current;
      // Narrow write: the whole-row upsert here would reset the name and every
      // toggle just because somebody added a manager.
      store.setHuddleChannelOwners(channelId, next);
      invalidateStats();
      sendJson(res, 200, { ok: true, ownerIds: next });
      return;
    }

    if (route === '/api/admin' && method === 'GET') {
      if (!isAdminViewer(auth_)) {
        sendJson(res, 403, { error: 'Owner only' });
        return;
      }
      sendJson(res, 200, await describeAdmin());
      return;
    }

    // Who has a way in, and what they are. Admin viewers can read this; only the
    // owner can act on it, and there is no write endpoint here at all.
    // The owner can DM anyone as the bot. A fake admin sees the form and gets the
    // joke when they press send.
    if (route === '/api/admin/messages' && method === 'POST') {
      if (auth_?.permissions.fakeAdmin) return sike(res);
      if (!requireOwner(res, auth_)) return;
      const body = await readJsonBody(req, 8192);
      const userId = String(body?.userId || '')
        .trim()
        .toUpperCase();
      const text = String(body?.text || '').trim();
      if (!isSlackUserId(userId)) {
        sendJson(res, 400, { error: 'That does not look like a Slack user id' });
        return;
      }
      if (!text) {
        sendJson(res, 400, { error: 'Write something first' });
        return;
      }
      if (text.length > 3000) {
        sendJson(res, 400, { error: 'Keep it under 3000 characters' });
        return;
      }
      try {
        const response = await client.chat.postMessage({
          channel: userId,
          text: `${text}\n\nfrom @jacob`,
        });
        store.recordTriggerLog({
          userId: auth_.session.slack_user_id,
          action: 'admin_dm_sent',
          detail: userId,
          channelId: userId,
        });
        sendJson(res, 200, { ok: true, ts: response?.ts || '' });
      } catch (error) {
        logger.warn?.('[dashboard] admin DM failed', error?.data?.error || error?.message || error);
        sendJson(res, 502, {
          error: 'Slack would not deliver that message',
          detail: String(error?.data?.error || error?.message || error),
        });
      }
      return;
    }

    if (route === '/api/admin/users' && method === 'GET') {
      if (!isAdminViewer(auth_)) {
        sendJson(res, 403, { error: 'Owner only' });
        return;
      }
      sendJson(res, 200, describeUsers({ viewerIsOwner: Boolean(auth_?.permissions.isOwner) }));
      return;
    }

    // Grant or revoke the fake admin role. Real for the owner, SIKE for anyone
    // who only has the view.
    if (route === '/api/admin/fake-admins' && method === 'POST') {
      if (auth_?.permissions.fakeAdmin) return sike(res);
      if (!requireOwner(res, auth_)) return;
      const body = await readJsonBody(req);
      const userId = String(body?.userId || '')
        .trim()
        .toUpperCase();
      if (!isSlackUserId(userId)) {
        sendJson(res, 400, { error: 'That does not look like a Slack user id' });
        return;
      }
      const current = store.getFakeAdminIds();
      const next = body?.enabled ? [...new Set([...current, userId])] : current.filter((id) => id !== userId);
      store.setFakeAdminIds(next);
      sendJson(res, 200, { ok: true, fakeAdminIds: next });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  }

  return {
    server,
    // Exposed so the bot can mint sign in links for DMs without reaching into
    // module internals. Callers only get what the public sign in path uses.
    auth,
    publicUrl: (req) => auth.publicUrl(req),
    listen(port, host = '0.0.0.0') {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          logger.info?.(`[dashboard] listening on ${host}:${port}`);
          resolve(server);
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index === -1) {
      continue;
    }
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function isSecure(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim();
  return proto === 'https' || Boolean(req.socket.encrypted);
}
