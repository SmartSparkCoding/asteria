import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DateTime } from 'luxon';
import { buildStatusRss, readStatusEvents } from '../status/status-core.js';
import { createDashboardAuth } from './auth.js';
import { createCachetDirectory } from './cachet.js';
import { createFlaronDirectory } from './flaron.js';
import { renderDashboardHtml } from './html.js';
import { renderHuddlePage } from './huddle-page.js';
import { resolvePermissions } from './permissions.js';
import { buildDashboardStats } from './stats.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SESSION_COOKIE = 'asteria_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const PAGES = { '/j-log': 'j-log', '/huddles': 'huddles', '/admin': 'admin' };
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
  const slack = {
    channelSize: async (channelId) => {
      const response = await client.conversations.info({ channel: channelId, include_num_members: true });
      const total = Number(response?.channel?.num_members);
      return Number.isFinite(total) ? total : null;
    },
    // Same endpoint, different question. `is_private` is tri-state on the way
    // out for the same reason the column is: an unanswered lookup must not be
    // read as "public".
    channelPrivacy: async (channelId) => {
      const response = await client.conversations.info({ channel: channelId });
      if (!response?.channel || response.channel.is_private == null) {
        return null;
      }
      return response.channel.is_private ? 1 : 0;
    },
  };
  const auth = createDashboardAuth({
    client,
    store,
    logger,
    slackClientId: process.env.SLACK_CLIENT_ID || '',
    slackClientSecret: process.env.SLACK_CLIENT_SECRET || '',
  });

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
      ...extraHeaders,
    });
    res.end(payload);
  }

  function sendHtml(res, statusCode, html) {
    res.writeHead(statusCode, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src https: data:; connect-src 'self'; form-action 'self'; base-uri 'none'",
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
    const { isOwner, managedChannelIds } = session.permissions;
    if (isOwner) {
      return true;
    }
    return Array.isArray(managedChannelIds) && managedChannelIds.includes(channelId);
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
<title>Not found · Asteria</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d1117;color:#c9d1d9;
font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:center;padding:24px}
a{color:#2ea043}h1{color:#f0f6fc;font-size:20px;margin:0 0 8px}p{margin:0;font-size:14px}</style>
</head><body><div><h1>No such huddle</h1>
<p>If this is your huddle, <a href="/login">sign in with Slack</a> and try again.</p>
<p style="margin-top:14px;font-size:13px;color:#8b949e">Huddle pages are only visible to Asteria's owner and to
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

    const participants = [
      ...attendance.participants.map((entry) => ({
        userId: entry.userId,
        durationSeconds: entry.partial ? null : entry.seconds,
        provableSeconds: entry.seconds,
        partial: entry.partial,
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
          points: awardsByUser.get(member.user_id)?.points ?? 0,
          reasons: awardsByUser.get(member.user_id)?.reasons ?? [],
        })),
    ].sort((a, b) => b.points - a.points || (b.provableSeconds || 0) - (a.provableSeconds || 0));

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
      reconstructed: awards.some((award) => award.reasons.some((reason) => reason === 'backfilled')),
      // Some attendance could not be proven, so the page says so rather than
      // presenting a partial record as if it were complete.
      attendancePartial: attendance.partial || participants.every((participant) => participant.partial),
      timezone,
    };
  }

  function parseOwnerIds(raw) {
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

  /**
   * Per channel settings for the huddle customisation tab, plus any channel the
   * bot is in but has no settings row for. Those still get tracked and still
   * announce, because an unconfigured channel falls back to the defaults, so
   * saying so out loud is the only way it is visible.
   */
  async function describeHuddleConfig() {
    const inBot = await botChannels.list();
    const inBotSet = new Set(inBot);
    const configured = store.listHuddleChannels();
    const configuredIds = new Set(configured.map((c) => c.channel_id));
    const now = nowEpochSeconds();
    const names = await botChannels.names([...inBotSet]);

    const channels = configured
      .filter((c) => inBotSet.has(c.channel_id))
      .map((c) => {
        const pausedUntil = Number(c.paused_until) || 0;
        const owners = parseOwnerIds(c.owner_ids);
        return {
          channelId: c.channel_id,
          name: c.name || names[c.channel_id] || c.channel_id,
          enabled: Number(c.enabled) === 1,
          auto_replies: Number(c.auto_replies) === 1,
          restrict_triggers: Number(c.restrict_triggers) === 1,
          condensed_review: Number(c.condensed_review) === 1,
          paused: pausedUntil > now,
          pausedUntilLabel:
            pausedUntil > now ? new Date(pausedUntil * 1000).toISOString().slice(0, 16).replace('T', ' ') : 'never',
          owners: owners.map((id) => ({ id, name: '' })),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      channels,
      unconfigured: inBot
        .filter((id) => !configuredIds.has(id))
        .map((id) => ({ channelId: id, name: names[id] || '' })),
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
        sendHtml(res, 400, renderDashboardHtml({ signedIn: false, baseUrl: auth.publicUrl(req) }));
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
          location: safeNextRoute(decodeURIComponent(cookies.asteria_oauth_next || '')) || '/',
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
        location: '/',
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
      const stats = await buildDashboardStats({
        store,
        botChannels,
        permissions: auth_?.permissions || { role: null, isOwner: false, isManager: false, managedChannelIds: [] },
        cachet,
        flaron,
        slack,
        startedAt,
        statusEvents: readStatusEvents(eventsFilePath),
      });
      sendJson(res, 200, {
        ...stats,
        viewer: {
          ...stats.viewer,
          signedIn: Boolean(auth_),
          userId: auth_?.session.slack_user_id || null,
          leaderboardOptIn: auth_ ? store.isLeaderboardOptedIn(auth_.session.slack_user_id) : true,
        },
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
      sendHtml(
        res,
        200,
        renderDashboardHtml({
          oauthConfigured: auth.oauthConfigured,
          signedIn: Boolean(auth_),
          role: auth_?.permissions.role || null,
          baseUrl: '',
        }),
      );
      return;
    }

    // The tabbed pages. All three are signed-in only: they are settings, not a
    // public readout, and the admin one additionally has to be the owner.
    if (PAGES[route] && method === 'GET') {
      if (!auth_) {
        redirect(res, '/login');
        return;
      }
      const needsOwner = route === '/admin';
      if (needsOwner && !auth_.permissions.isOwner) {
        sendHtml(
          res,
          403,
          renderDashboardHtml({
            oauthConfigured: auth.oauthConfigured,
            signedIn: true,
            role: auth_.permissions.role,
            baseUrl: '',
            view: 'home',
          }),
        );
        return;
      }
      sendHtml(
        res,
        200,
        renderDashboardHtml({
          oauthConfigured: auth.oauthConfigured,
          signedIn: true,
          role: auth_.permissions.role,
          baseUrl: '',
          view: PAGES[route],
        }),
      );
      return;
    }

    if (route === '/api/j-log' && method === 'GET') {
      if (!requireManager(res, auth_)) return;
      sendJson(res, 200, {
        settings: store.getSettings(),
        draft: store.getDraft() || null,
        recentQuestions: store.getRecentDailyQuestionTexts(5) || [],
      });
      return;
    }

    if (route === '/api/j-log/draft' && method === 'POST') {
      if (!requireManager(res, auth_)) return;
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
      if (!requireManager(res, auth_)) return;
      const body = await readJsonBody(req);
      const merged = store.updateSettings(body || {});
      sendJson(res, 200, { ok: true, settings: merged });
      return;
    }

    if (route === '/api/huddles/config' && method === 'GET') {
      if (!requireManager(res, auth_)) return;
      sendJson(res, 200, await describeHuddleConfig());
      return;
    }

    if (route === '/api/huddles/config' && method === 'POST') {
      if (!requireManager(res, auth_)) return;
      const body = await readJsonBody(req);
      const channelId = String(body?.channelId || '');
      if (!channelId || !canManageChannel(auth_, channelId)) {
        sendJson(res, 403, { error: 'Not your channel' });
        return;
      }
      // A channel with no row yet has to exist before its flags can be set.
      store.upsertHuddleChannel({ channelId });
      const allowed = ['enabled', 'auto_replies', 'restrict_triggers', 'condensed_review'];
      for (const field of allowed) {
        if (field in (body || {})) {
          store.setHuddleChannelFlag(channelId, field, body[field] ? 1 : 0);
        }
      }
      if ('paused' in (body || {})) {
        store.setHuddleChannelFlag(channelId, 'paused_until', body.paused ? nowEpochSeconds() + PAUSE_SECONDS : 0);
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (route === '/api/huddles/owners' && method === 'POST') {
      if (!requireManager(res, auth_)) return;
      const body = await readJsonBody(req);
      const channelId = String(body?.channelId || '');
      if (!channelId || !canManageChannel(auth_, channelId)) {
        sendJson(res, 403, { error: 'Not your channel' });
        return;
      }
      const row = store.getHuddleChannel(channelId);
      const current = [...(parseOwnerIds(row?.owner_ids) || [])];
      const add = String(body?.add || '')
        .trim()
        .toUpperCase();
      const remove = String(body?.remove || '')
        .trim()
        .toUpperCase();
      if (add && !/^[UW][A-Z0-9]{7,}$/.test(add)) {
        sendJson(res, 400, { error: 'That does not look like a Slack user id' });
        return;
      }
      const next = remove ? current.filter((id) => id !== remove) : add ? [...new Set([...current, add])] : current;
      store.upsertHuddleChannel({ channelId, ownerIds: next });
      sendJson(res, 200, { ok: true, ownerIds: next });
      return;
    }

    if (route === '/api/admin' && method === 'GET') {
      if (!auth_?.permissions.isOwner) {
        sendJson(res, 403, { error: 'Owner only' });
        return;
      }
      sendJson(res, 200, await describeAdmin());
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
