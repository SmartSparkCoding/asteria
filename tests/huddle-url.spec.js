import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createDashboardServer } from '../src/dashboard/server.js';
import { createStore } from '../src/database/store.js';
import { huddlePageUrl } from '../src/huddles/urls.js';

const CALL = 'R0URLCHECK';
const CHANNEL = 'C0URLCHAN';
const OWNER = 'U0AEYDUCLKF';

const created = [];
let harness;
let store;

after(async () => {
  if (oauth) {
    await oauth.close();
  }
  if (savedEnv.id === undefined) delete process.env.SLACK_CLIENT_ID;
  else process.env.SLACK_CLIENT_ID = savedEnv.id;
  if (savedEnv.secret === undefined) delete process.env.SLACK_CLIENT_SECRET;
  else process.env.SLACK_CLIENT_SECRET = savedEnv.secret;
  if (harness) {
    await harness.close();
  }
  // Close before removing the directory: sql.js writes the file on close, so
  // deleting the directory first fails with ENOENT.
  if (store) {
    store.close();
  }
  for (const dir of created) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The bug this file exists for: the bot posted `/huddle/<id>` into real Slack
 * channels while the server routes `/<id>`, so every link it ever sent was a
 * hard 404. The old tests asserted the string the code produced, which is why
 * they passed for as long as the link was wrong.
 *
 * So these tests resolve the URL against a real server instead of comparing it
 * to another string.
 */
describe('a huddle link the bot posts actually resolves', () => {
  before(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-huddleurl-'));
    created.push(dir);
    store = await createStore(path.join(dir, 'asteria.sqlite'));
    store.upsertHuddle({
      callId: CALL,
      channelId: CHANNEL,
      channelName: 'url-check',
      createdBy: OWNER,
      startedAt: 1_700_000_000,
      endedAt: 1_700_000_600,
      threadRootTs: '1.1',
      status: 'ended',
    });
    store.upsertHuddleMember({
      callId: CALL,
      userId: OWNER,
      firstSeenAt: 1_700_000_000,
      lastSeenAt: 1_700_000_600,
      isIn: false,
    });
    store.upsertHuddleChannel({ channelId: CHANNEL, name: 'url-check', ownerIds: [OWNER], isPrivate: false });
    harness = createDashboardServer({
      store,
      client: {},
      botChannels: { list: async () => [CHANNEL], names: async () => ({}) },
      logger: { warn() {}, info() {}, error() {} },
    });
    await harness.listen(0, '127.0.0.1');
    harness.base = `http://127.0.0.1:${harness.server.address().port}`;

    // Built here rather than in a top level hook: the store is created in this
    // hook, and a server constructed before that captures an undefined store.
    savedEnv.id = process.env.SLACK_CLIENT_ID;
    savedEnv.secret = process.env.SLACK_CLIENT_SECRET;
    process.env.SLACK_CLIENT_ID = 'test-client';
    process.env.SLACK_CLIENT_SECRET = 'test-secret';
    oauthWarnings = [];
    oauth = createDashboardServer({
      store,
      client: {},
      botChannels: { list: async () => [CHANNEL], names: async () => ({}) },
      logger: {
        warn: (...args) => oauthWarnings.push(args.map(String).join(' ')),
        info() {},
        error() {},
      },
    });
    await oauth.listen(0, '127.0.0.1');
    oauth.base = `http://127.0.0.1:${oauth.server.address().port}`;
  });

  test('the URL the bot builds resolves on the server, not just as a string', async () => {
    const url = huddlePageUrl(harness.base, CALL);
    const path = new URL(url).pathname;

    assert.equal(path, `/${CALL}`, 'the page is served from the root of the host');
    assert.ok(
      !path.startsWith('/huddle/'),
      'the old /huddle/ prefix is not routed, so it was a hard 404 in every channel',
    );

    // The whole point: ask the server, do not pattern match a string.
    const response = await fetch(harness.base + path, { redirect: 'manual' });
    assert.equal(
      response.status,
      302,
      'anonymous is redirected to sign in, which is what a live route does; a dead route is a 404',
    );
    assert.match(response.headers.get('location') || '', /\/login/);
  });

  test('the old /huddle/<id> shape redirects to the real page, not a 404', async () => {
    // Every link posted before the fix is in somebody's channel history, so the
    // old shape has to land somewhere rather than stay broken.
    const old = await fetch(`${harness.base}/huddle/${CALL}`, { redirect: 'manual' });
    assert.equal(old.status, 302);
    assert.equal(old.headers.get('location'), `/${CALL}`);
  });

  test('a /huddle/ path that is not a call id is still a 404', async () => {
    const notACall = await fetch(`${harness.base}/huddle/nonsense`, { redirect: 'manual' });
    assert.equal(notACall.status, 404);
  });

  test('signing in from a huddle link returns you to that huddle', async () => {
    // The other half of the bug: /login was given ?next= but never read it, so
    // following a link while signed out dumped you on the dashboard afterwards
    // and the link looked broken even once the URL itself was right.
    const jar = await oauthLogin(`?next=${encodeURIComponent(`/${CALL}`)}`);
    assert.match(jar.cookies, /asteria_oauth_next=/, 'the destination has to survive the trip to Slack');

    const state = /asteria_oauth_state=([^;]+)/.exec(jar.cookies)?.[1];
    const nonce = /asteria_oauth_nonce=([^;]+)/.exec(jar.cookies)?.[1];
    const callback = await withStubbedSlack(nonce, async () => {
      const response = await fetch(`${oauth.base}/auth/slack/callback?code=fake&state=${encodeURIComponent(state)}`, {
        redirect: 'manual',
        headers: { cookie: jar.cookies },
      });
      assert.equal(response.status, 302);
      return response;
    });

    assert.equal(
      callback.headers.get('location'),
      `/${CALL}`,
      'after signing in you land back on the huddle you asked for',
    );
  });

  test('an off-site "next" is refused, so sign-in cannot be used as an open redirect', async () => {
    for (const attempt of ['https://evil.test/steal', '//evil.test/steal', 'javascript:alert(1)']) {
      const jar = await oauthLogin(`?next=${encodeURIComponent(attempt)}`, { setNext: false });
      assert.ok(!jar.cookies.includes('evil.test') && !jar.cookies.includes('javascript'), `refused: ${attempt}`);
      assert.ok(!/asteria_oauth_next=/.test(jar.cookies), `no next cookie at all for: ${attempt}`);
    }
  });

  test('a plain sign-in with no next still lands on the dashboard', async () => {
    const jar = await oauthLogin('');
    const state = /asteria_oauth_state=([^;]+)/.exec(jar.cookies)?.[1];
    const nonce = /asteria_oauth_nonce=([^;]+)/.exec(jar.cookies)?.[1];
    const callback = await withStubbedSlack(nonce, async () =>
      fetch(`${oauth.base}/auth/slack/callback?code=fake&state=${encodeURIComponent(state)}`, {
        redirect: 'manual',
        headers: { cookie: jar.cookies },
      }),
    );
    assert.equal(callback.headers.get('location'), '/');
  });

  test('no base URL means no link, rather than a link to nowhere', () => {
    assert.equal(huddlePageUrl('', CALL), '');
    assert.equal(huddlePageUrl('https://x.test', ''), '');
    assert.equal(huddlePageUrl(null, CALL), '');
  });
});

/** A second server with Slack sign-in switched on, built once the store exists. */
let oauth;
let oauthWarnings = [];
const savedEnv = {};

/** Kick off a sign-in and hand back the cookies Slack's redirect would carry. */
async function oauthLogin(next, { setNext = true } = {}) {
  const query = setNext ? next : '';
  const response = await fetch(`${oauth.base}/login${query}`, { redirect: 'manual' });
  assert.equal(response.status, 302, 'oauth is configured, so /login must go to Slack');
  return {
    cookies: (response.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; '),
  };
}

/**
 * Answer Slack's token endpoint locally. The id_token is unsigned on purpose:
 * the server only base64-decodes the claims, and this test is about where the
 * browser is sent afterwards, not about signature verification.
 */
async function withStubbedSlack(nonce, run) {
  const seen = [];
  const claims = Buffer.from(JSON.stringify({ nonce, aud: 'test-client', sub: OWNER })).toString('base64url');
  const idToken = `header.${claims}.signature`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    seen.push(String(input));
    if (String(input).startsWith('https://slack.com/api/openid.connect.token')) {
      return new Response(JSON.stringify({ access_token: 'xoxb-test', id_token: idToken }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return realFetch(input, init);
  };
  try {
    const result = await run();
    if (result.headers.get('location')?.includes('error=')) {
      throw new Error(
        `sign-in failed: ${result.headers.get('location')} / ${oauthWarnings.join(' | ')} (slack calls: ${seen.join(', ')})`,
      );
    }
    return result;
  } finally {
    globalThis.fetch = realFetch;
  }
}
