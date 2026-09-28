import crypto from 'node:crypto';
import { ensureDirectMessageChannel } from '../services/slack.js';

const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_LENGTH = 6;

// Anything the visitor can act on. The status code travels with the error so
// the route can answer 400 with the sentence instead of 500 with a shrug.
class UserFacingError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'UserFacingError';
    this.status = status;
  }
}

export function createDashboardAuth({ client, store, logger = console, slackClientId = '', slackClientSecret = '' }) {
  const oauthConfigured = Boolean(slackClientId && slackClientSecret);
  const codes = new Map();

  function randomToken(bytes = 32) {
    return crypto.randomBytes(bytes).toString('base64url');
  }

  function publicUrl(req) {
    const configured = process.env.PUBLIC_URL || process.env.ASTERIA_PUBLIC_URL || '';
    if (configured) {
      return configured.replace(/\/+$/, '');
    }
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim();
    const proto = forwardedProto || (req.socket.encrypted ? 'https' : 'http');
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost')
      .split(',')[0]
      .trim();
    return `${proto}://${host}`;
  }

  /**
   * Slack "Sign in with Slack" (OIDC user token). Needs the app's client id and
   * secret plus the redirect url registered on the app.
   */
  function slackAuthorizeUrl(req, state, nonce) {
    const redirectUri = `${publicUrl(req)}/auth/slack/callback`;
    const params = new URLSearchParams({
      client_id: slackClientId,
      scope: 'openid profile',
      // Slack rejects the authorize request outright without this ("response_type
      // must be \"code\""), and the openid scope additionally forces a nonce that
      // has to come back in the id_token.
      response_type: 'code',
      redirect_uri: redirectUri,
      state,
    });
    if (nonce) {
      params.set('nonce', nonce);
    }
    return `https://slack.com/openid/connect/authorize?${params}`;
  }

  /** Claims out of a JWT we got straight from Slack over TLS. No signature re-check here. */
  function idTokenClaims(idToken) {
    const segment = String(idToken || '').split('.')[1];
    if (!segment) {
      return null;
    }
    try {
      return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
  }

  async function exchangeSlackCode(req, code, expectedNonce) {
    const redirectUri = `${publicUrl(req)}/auth/slack/callback`;
    // Slack's token endpoint wants a form encoded body with an explicit grant type.
    // Sending JSON without it came back as `invalid_code` on a code that was fine.
    const response = await fetch('https://slack.com/api/openid.connect.token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: slackClientId,
        client_secret: slackClientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!body.access_token) {
      throw new Error(body.error || 'openid.connect.token failed');
    }
    if (expectedNonce) {
      const claims = idTokenClaims(body.id_token);
      if (!claims || claims.nonce !== expectedNonce) {
        throw new Error('id_token nonce did not match the authorize request');
      }
      if (claims.aud && claims.aud !== slackClientId) {
        throw new Error('id_token audience did not match this app');
      }
    }
    const userResponse = await fetch('https://slack.com/api/user.info', {
      headers: { authorization: `Bearer ${body.access_token}` },
    });
    const user = await userResponse.json();
    if (!user.ok || !user.user?.id) {
      throw new Error(user.error || 'user.info failed');
    }
    return user.user;
  }

  /**
   * Fallback that needs no new app configuration: the visitor gives their Slack
   * member id, the bot DMs them a one-time code, and only whoever can read that DM
   * can finish signing in. Proves control of the account without any OAuth app edit.
   */
  async function startDmVerification(slackUserId) {
    if (!/^[UW][A-Z0-9]{7,}$/.test(String(slackUserId || ''))) {
      throw new UserFacingError('That does not look like a Slack member ID. It starts with U or W, like U0123456789.');
    }
    const code = String(crypto.randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
    codes.set(slackUserId, { code, createdAt: Date.now() });
    let channelId;
    try {
      // conversations.open wants `users`, not `user`. Passing `user` came back
      // channel_not_found for everybody, which is why sign-in could never deliver
      // a code even with im:write granted.
      channelId = await ensureDirectMessageChannel(client, slackUserId);
    } catch (error) {
      codes.delete(slackUserId);
      // Slack refuses to start a DM the bot has no permission to start.
      if (
        /^(channel_not_found|missing_scope|not_in_channel|user_not_visible|account_inactive)$/.test(
          error?.data?.error || '',
        )
      ) {
        throw new UserFacingError(
          'I could not open a DM with you on Slack. Open Slack, start a chat with the Asteria bot and send anything, then try this again.',
        );
      }
      throw error;
    }
    try {
      await client.chat.postMessage({
        channel: channelId,
        text: `Your Asteria dashboard sign-in code is *${code}*. It expires in 10 minutes. If this wasn't you, ignore this message.`,
      });
    } catch (error) {
      codes.delete(slackUserId);
      if (/^(channel_not_found|not_in_channel|channel_not_found)$/.test(error?.data?.error || '')) {
        throw new UserFacingError(
          'Your DM went through but I could not post to it. Check that the Asteria bot is not blocked.',
        );
      }
      throw error;
    }
    return { slackUserId, channelId };
  }

  function verifyDmCode(slackUserId, code) {
    const pending = codes.get(slackUserId);
    if (!pending) {
      return { ok: false, error: 'Request a new code first.' };
    }
    if (Date.now() - pending.createdAt > CODE_TTL_MS) {
      codes.delete(slackUserId);
      return { ok: false, error: 'That code expired. Request a new one.' };
    }
    if (pending.code !== String(code || '').trim()) {
      return { ok: false, error: 'That code is not right.' };
    }
    codes.delete(slackUserId);
    return { ok: true };
  }

  /** Creates the session row and returns the cookie value to hand back. */
  function completeLogin({ slackUserId, displayName, permissions }) {
    const token = randomToken();
    store.createDashboardSession({ token, slackUserId, role: permissions.role });
    store.upsertDashboardUser({ slackUserId, displayName });
    return token;
  }

  function sessionFromToken(token) {
    const session = store.getDashboardSession(token);
    if (!session) {
      return null;
    }
    store.touchDashboardSession(token);
    return session;
  }

  return {
    oauthConfigured,
    publicUrl,
    slackAuthorizeUrl,
    exchangeSlackCode,
    startDmVerification,
    verifyDmCode,
    completeLogin,
    sessionFromToken,
    randomState: () => randomToken(16),
    randomToken,
    pendingCodeCount: () => codes.size,
    logger,
  };
}
