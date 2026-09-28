import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStatusRss, readStatusEvents } from '../status/status-core.js';
import { createDashboardAuth } from './auth.js';
import { createCachetDirectory } from './cachet.js';
import { createFlaronDirectory } from './flaron.js';
import { renderDashboardHtml } from './html.js';
import { resolvePermissions } from './permissions.js';
import { buildDashboardStats } from './stats.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SESSION_COOKIE = 'asteria_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export function createDashboardServer({ store, client, botChannels, logger = console, startedAt = Date.now() }) {
  const eventsFilePath = process.env.ASTERIA_STATUS_FILE || path.join(repoRoot, 'data', 'status-events.json');
  const cachet = createCachetDirectory({ logger });
  const flaron = createFlaronDirectory({ logger });
  // Flaron will not describe a private channel, so Slack supplies the headcount
  // for those. conversations.info answers with form encoding here, same as the
  // rest of this workspace's API calls.
  const slack = {
    channelSize: async (channelId) => {
      const response = await client.apiCall('conversations.info', {
        method: 'POST',
        body: new URLSearchParams({ channel: channelId, include_num_members: 'true' }),
      });
      const total = Number(response?.channel?.num_members);
      return Number.isFinite(total) ? total : null;
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
      const cookie = `asteria_oauth_state=${state}; ${cookieAttrs}; asteria_oauth_nonce=${nonce}; ${cookieAttrs}`;
      res.writeHead(302, {
        location: auth.slackAuthorizeUrl(req, state, nonce),
        'set-cookie': cookie,
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
          location: '/',
          'set-cookie': [
            `${sessionCookie(token, req)}`,
            'asteria_oauth_state=; Path=/; Max-Age=0',
            'asteria_oauth_nonce=; Path=/; Max-Age=0',
          ].join('; '),
          'cache-control': 'no-store',
        });
        res.end();
      } catch (error) {
        logger.warn?.('[dashboard] Slack sign-in failed', error.message);
        redirect(res, '/?error=slack');
      }
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

    sendJson(res, 404, { error: 'Not found' });
  }

  return {
    server,
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
