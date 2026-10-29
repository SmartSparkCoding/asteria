import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import { createDashboardAuth } from '../src/dashboard/auth.js';
import { cachetAvatarUrl, cachetUserUrl, createCachetDirectory } from '../src/dashboard/cachet.js';
import { renderApp, renderLanding } from '../src/dashboard/site.js';
import { renderDashboardHtml } from '../src/dashboard/html.js';
import { ROLES, resolvePermissions } from '../src/dashboard/permissions.js';
import { createDashboardServer } from '../src/dashboard/server.js';
import { buildDashboardStats } from '../src/dashboard/stats.js';
import { backfillChannelPoints } from '../src/database/backfill-channel-points.js';
import { createStore } from '../src/database/store.js';
import { createBotChannelDirectory } from '../src/services/bot-channels.js';

let createdPaths = [];

afterEach(() => {
  for (const databasePath of createdPaths) {
    fs.rmSync(path.dirname(databasePath), { recursive: true, force: true });
  }
  createdPaths = [];
});

async function createTestStore() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-dashboard-'));
  const databasePath = path.join(tempDir, 'asteria.sqlite');
  createdPaths.push(databasePath);
  return createStore(databasePath, { ownerId: 'U0AEYDUCLKF' });
}

function createSlackClientDouble() {
  return {
    conversations: {
      open: mock.fn(async ({ user }) => ({ channel: { id: `D${user}` } })),
      // The real client answers `unknown_method` when this is reached through
      // client.apiCall instead, so the double only has the SDK shape to offer.
      info: mock.fn(async ({ channel }) => ({ ok: true, channel: { id: channel, name: 'resolved-name' } })),
    },
    apiCall: mock.fn(async () => {
      throw new Error('unknown_method');
    }),
    auth: { test: mock.fn(async () => ({ user_id: 'U0BOT', team_id: 'T0266FRGM' })) },
    chat: {
      postMessage: mock.fn(async () => ({ ts: '1.1' })),
    },
  };
}

async function startDashboard(overrides = {}) {
  const store = overrides.store || (await createTestStore());
  const client = overrides.client || createSlackClientDouble();
  const botChannels = overrides.botChannels || { list: mock.fn(async () => ['Cbot']), invalidate: () => {} };
  const dashboard = createDashboardServer({
    store,
    client,
    botChannels,
    logger: { info: mock.fn(), warn: mock.fn(), error: mock.fn() },
    startedAt: Date.now() - 90 * 60 * 1000,
  });
  await dashboard.listen(0, '127.0.0.1');
  const { port } = dashboard.server.address();
  return {
    store,
    client,
    dashboard,
    base: `http://127.0.0.1:${port}`,
    async stop() {
      await dashboard.close();
      store.close();
    },
  };
}

async function signIn(harness, { slackUserId = 'U0AEYDUCLKF' } = {}) {
  const send = await fetch(`${harness.base}/api/auth/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slackUserId }),
  });
  assert.equal(send.status, 200, 'code request accepted');
  // Read the real code out of the DM the bot just sent, the way a person would.
  const dm = harness.client.chat.postMessage.mock.calls.at(-1).arguments[0].text;
  const code = dm.match(/\*(\d{6})\*/)[1];
  const body = await fetch(`${harness.base}/api/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slackUserId, code }),
  });
  assert.equal(body.status, 200, 'verification accepted');
  const cookie = body.headers.get('set-cookie').split(';')[0];
  return { cookie, role: (await body.json()).role };
}

describe('cachet directory', () => {
  it('builds profile and avatar urls, with /r for the picture', () => {
    assert.equal(cachetUserUrl('U123'), 'https://cachet.hackclub.com/users/U123');
    assert.equal(cachetAvatarUrl('U123'), 'https://cachet.hackclub.com/users/U123/r');
  });

  it('caches profiles and survives a Cachet outage', async () => {
    let calls = 0;
    const fetchImpl = mock.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          JSON.stringify({
            userId: 'U123',
            displayName: 'Sam',
            realName: 'Sam Rivera',
            pronouns: 'they/them',
            imageUrl: 'https://example.com/sam.png',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('nope', { status: 500 });
    });
    const cachet = createCachetDirectory({ fetchImpl, logger: { warn: mock.fn() } });

    const first = await cachet.fetchProfile('U123');
    assert.equal(first.displayName, 'Sam');
    assert.equal(first.pronouns, 'they/them');
    await cachet.fetchProfile('U123');
    assert.equal(calls, 1, 'second lookup served from cache');

    const missing = await cachet.fetchProfile('U999');
    assert.equal(missing, null, 'an unknown profile is null, not a crash');
  });
});

describe('dashboard permissions', () => {
  it('gives the owner everything, managers their channels, everyone else nothing special', async () => {
    const store = await createTestStore();
    store.upsertHuddleChannel({ channelId: 'Cmine', name: 'mine', ownerIds: ['UMANAGER'] });

    const owner = resolvePermissions({ store, slackUserId: 'U0AEYDUCLKF' });
    assert.equal(owner.role, ROLES.OWNER);
    assert.equal(owner.isOwner, true);
    assert.equal(owner.managedChannelIds, null, 'owners are not scoped to a list');

    const manager = resolvePermissions({ store, slackUserId: 'UMANAGER' });
    assert.equal(manager.role, ROLES.MANAGER);
    assert.deepEqual(manager.managedChannelIds, ['Cmine']);

    const user = resolvePermissions({ store, slackUserId: 'URANDOM' });
    assert.equal(user.role, ROLES.USER);
    assert.deepEqual(user.managedChannelIds, []);
    assert.equal(resolvePermissions({ store, slackUserId: '' }).role, null, 'signed out is nobody');

    store.close();
  });
});

describe('dashboard server', () => {
  it('serves the dashboard, and health as json', async () => {
    const harness = await startDashboard();
    try {
      const landing = await fetch(`${harness.base}/`);
      assert.equal(landing.status, 200);
      assert.match(landing.headers.get('content-type'), /text\/html/);
      const landingHtml = await landing.text();
      assert.match(landingHtml, /Orbit/);
      assert.match(landingHtml, /scored<\/em> and remembered/, 'the public page explains the product');
      assert.match(landingHtml, /--accent:#cba6f7/, 'Catppuccin Mocha mauve is the product accent');
      assert.match(landingHtml, /color-scheme:dark/);

      const anonymous = await fetch(`${harness.base}/dashboard`, { redirect: 'manual' });
      assert.equal(anonymous.status, 302, 'the dashboard needs a session');
      assert.match(anonymous.headers.get('location'), /^\/login\?next=%2Fdashboard$/);

      const owner = await signIn(harness);
      const page = await fetch(`${harness.base}/dashboard`, { headers: { cookie: owner.cookie } });
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /Overview/, 'the dashboard is behind sign in');

      const health = await fetch(`${harness.base}/health`);
      assert.equal(health.status, 200);
      const body = await health.json();
      assert.equal(body.ok, true);
      assert.equal(typeof body.uptimeSeconds, 'number');
      assert.equal(typeof body.startedAt, 'string');
    } finally {
      await harness.stop();
    }
  });

  it('keeps rss working and 404s anything else', async () => {
    const harness = await startDashboard();
    try {
      const rss = await fetch(`${harness.base}/rss.xml`);
      assert.equal(rss.status, 200);
      assert.match(await rss.text(), /<rss/);
      assert.equal((await fetch(`${harness.base}/nope`)).status, 404);
    } finally {
      await harness.stop();
    }
  });

  it('verifies a Slack member id by DM code before creating a session', async () => {
    const harness = await startDashboard();
    try {
      assert.equal((await fetch(`${harness.base}/api/stats`)).status, 401, 'stats need a session');

      const bad = await fetch(`${harness.base}/api/auth/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slackUserId: 'U0AEYDUCLKF', code: '999999' }),
      });
      assert.equal(bad.status, 400, 'a wrong code is rejected');
      assert.equal(harness.client.conversations.open.mock.callCount(), 0, 'and no DM was needed');

      const signedIn = await signIn(harness);
      assert.equal(signedIn.role, ROLES.OWNER);
      assert.equal(harness.client.chat.postMessage.mock.callCount(), 1, 'the code was DMd once');
      assert.match(harness.client.chat.postMessage.mock.calls[0].arguments[0].text, /sign-in code is \*\d{6}\*/);

      const mine = await fetch(`${harness.base}/api/stats`, { headers: { cookie: signedIn.cookie } });
      const body = await mine.json();
      assert.equal(body.viewer.signedIn, true);
      assert.equal(body.viewer.isOwner, true);
    } finally {
      await harness.stop();
    }
  });

  it('rejects a Slack id that does not look like one before messaging anyone', async () => {
    const harness = await startDashboard();
    try {
      const response = await fetch(`${harness.base}/api/auth/code`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slackUserId: 'not-an-id' }),
      });
      // A typo is the visitor's to fix, so it gets a 400 that says what to
      // type rather than a 500 that blames us.
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /Slack member ID/);
      assert.equal(harness.client.conversations.open.mock.callCount(), 0);
    } finally {
      await harness.stop();
    }
  });

  it('lets a normal user hide themselves from the leaderboard, and only themselves', async () => {
    const store = await createTestStore();
    // The board is scoped to the tracked channels, so the points have to live in
    // one that is actually being tracked.
    store.setHuddleChannelName('Cbot', 'bot-channel');
    store.awardHuddlePoints('U0AEYDUCLKF', 50, 'Cbot');
    store.awardHuddlePoints('U0PLAIN01', 30, 'Cbot');
    const harness = await startDashboard({ store });
    try {
      const owner = await signIn(harness);
      const user = await signIn(harness, { slackUserId: 'U0PLAIN01' });

      // Everyone signed in sees who scored, subject to each person's opt-out.
      const signedInView = await (await fetch(`${harness.base}/api/stats`, { headers: { cookie: user.cookie } })).json();
      assert.deepEqual(
        signedInView.leaderboard.map((row) => row.userId).sort(),
        ['U0AEYDUCLKF', 'U0PLAIN01'],
        'signed-in viewers see who scored',
      );
      assert(
        signedInView.leaderboard.every((row) => row.displayName && row.displayName.length),
        'with a name on each row',
      );
      assert(
        signedInView.leaderboard.every((row) => row.key === row.userId),
        'and a stable row key',
      );
      assert.deepEqual(
        signedInView.leaderboard.map((row) => row.points),
        [50, 30],
        'and the points themselves are unchanged',
      );

      const optOut = await fetch(`${harness.base}/api/me/opt-in`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: user.cookie },
        body: JSON.stringify({ optedIn: false }),
      });
      assert.equal(optOut.status, 200);
      assert.equal((await optOut.json()).leaderboardOptIn, false);

      const after = await (await fetch(`${harness.base}/api/stats`, { headers: { cookie: user.cookie } })).json();
      assert.deepEqual(
        after.leaderboard.map((row) => row.userId),
        ['U0AEYDUCLKF'],
        'the opt-out is respected',
      );
      assert.equal(after.viewer.leaderboardOptIn, false);
      assert.equal(after.viewer.role, ROLES.USER);

      const denied = await fetch(`${harness.base}/api/me/opt-in`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ optedIn: true }),
      });
      assert.equal(denied.status, 401, 'signed-out visitors cannot flip it');

      const ownerView = await (await fetch(`${harness.base}/api/stats`, { headers: { cookie: owner.cookie } })).json();
      assert.equal(ownerView.viewer.isOwner, true);
    } finally {
      await harness.stop();
    }
  });

  it('breaks a person\'s points down by where they came from', async () => {
    const store = await createTestStore();
    const harness = await startDashboard({ store });
    try {
      const anon = await fetch(`${harness.base}/api/me/points`);
      assert.equal(anon.status, 401, 'the breakdown is not public either');

      const user = await signIn(harness, { slackUserId: 'U0PLAIN01' });
      store.saveHuddleAwards(
        'Rbreak01',
        'Cbot',
        new Map([
          [
            'U0PLAIN01',
            {
              points: 40,
              reasons: [
                { kind: 'minutes', label: '30m in the call', points: 30 },
                { kind: 'rank', label: 'rank 1', points: 5 },
                { kind: 'starter', label: 'started the huddle', points: 5 },
              ],
            },
          ],
        ]),
      );
      // One row from before the breakdown existed, stored as bare strings.
      store.saveHuddleAwards('Rbreak02', 'Cbot', new Map([['U0PLAIN01', { points: 12, reasons: ['12m'] }]]));

      const data = await (await fetch(`${harness.base}/api/me/points`, { headers: { cookie: user.cookie } })).json();
      assert.equal(data.total, 52);
      const byKind = Object.fromEntries(data.items.map((item) => [item.kind, item]));
      assert.equal(byKind.minutes.points, 42, 'the old bare "12m" row still counts as minutes');
      assert.equal(byKind.minutes.count, 2, 'two awards make up that total');
      assert.equal(byKind.rank.points, 5);
      assert.equal(byKind.starter.points, 5);
      assert.equal(data.items[0].kind, 'minutes', 'biggest first');
      assert.equal(data.rules.length, 4, 'the rules ship with the numbers the page prints');

      const other = await signIn(harness, { slackUserId: 'U0PLAIN02' });
      const empty = await (await fetch(`${harness.base}/api/me/points`, { headers: { cookie: other.cookie } })).json();
      assert.deepEqual(empty.items, [], 'somebody with no awards gets an empty breakdown, not a borrowed one');
      assert.equal(empty.total, 0);
    } finally {
      await harness.stop();
    }
  });

  it('asks the recap agreement once per person and keeps the answer', async () => {
    const store = await createTestStore();
    const harness = await startDashboard({ store });
    try {
      const anon = await fetch(`${harness.base}/api/me/agreement`);
      assert.equal(anon.status, 401, 'signed-out visitors are not asked');

      const user = await signIn(harness, { slackUserId: 'U0PLAIN01' });
      const first = await (await fetch(`${harness.base}/api/me/agreement`, { headers: { cookie: user.cookie } })).json();
      assert.equal(first.required, true, 'the question is open on the first visit');
      assert.equal(first.agreed, null, 'no answer is invented for them');
      assert.match(first.body, /huddle history/, 'it says what the answer covers');
      assert.match(first.note, /never reads or stores your messages/, 'and what it does not');

      const bad = await fetch(`${harness.base}/api/me/agreement`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: user.cookie },
        body: JSON.stringify({ agreed: 'yes please' }),
      });
      assert.equal(bad.status, 400, 'only a real answer is stored');

      const allow = await fetch(`${harness.base}/api/me/agreement`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: user.cookie },
        body: JSON.stringify({ agreed: true }),
      });
      assert.equal(allow.status, 200);
      const allowed = await allow.json();
      assert.equal(allowed.required, false);
      assert.equal(allowed.agreed, true);

      const again = await (await fetch(`${harness.base}/api/me/agreement`, { headers: { cookie: user.cookie } })).json();
      assert.equal(again.required, false, 'answered once, asked no more');
      assert.equal(again.agreed, true);

      const off = await (
        await fetch(`${harness.base}/api/me/agreement`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: user.cookie },
          body: JSON.stringify({ agreed: false }),
        })
      ).json();
      assert.equal(off.agreed, false, 'and it can be changed later');
      assert.equal(off.required, false);

      const other = await signIn(harness, { slackUserId: 'U0PLAIN02' });
      const otherView = await (
        await fetch(`${harness.base}/api/me/agreement`, { headers: { cookie: other.cookie } })
      ).json();
      assert.equal(otherView.required, true, 'one person answering does not answer for anyone else');
    } finally {
      await harness.stop();
    }
  });

  it('lets the owner send a DM as the bot, signed off from @jacob', async () => {
    const store = await createTestStore();
    const harness = await startDashboard({ store });
    try {
      const owner = await signIn(harness);
      const res = await fetch(`${harness.base}/api/admin/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: owner.cookie },
        body: JSON.stringify({ userId: 'U0PLAIN01', text: 'hello there' }),
      });
      assert.equal(res.status, 200);
      const sent = harness.client.chat.postMessage.mock.calls.at(-1).arguments[0];
      assert.equal(sent.channel, 'U0PLAIN01', 'the DM goes to the person, not a channel');
      assert(sent.text.startsWith('hello there'));
      assert(sent.text.trim().endsWith('from @jacob'), 'the sign off is always appended');

      const user = await signIn(harness, { slackUserId: 'U0PLAIN01' });
      const denied = await fetch(`${harness.base}/api/admin/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: user.cookie },
        body: JSON.stringify({ userId: 'U0PLAIN01', text: 'nope' }),
      });
      assert.equal(denied.status, 403, 'a normal user cannot message as the bot');
    } finally {
      await harness.stop();
    }
  });

  it('keeps private channel huddles out of the list for non-members', async () => {
    const store = await createTestStore();
    const now = Math.floor(Date.now() / 1000);
    store.upsertHuddleChannel({ channelId: 'Cbot', name: 'public', isPrivate: false });
    store.upsertHuddleChannel({ channelId: 'Cpriv', name: 'secret', isPrivate: true });
    store.upsertHuddle({ callId: 'Rpub', channelId: 'Cbot', startedAt: now - 200, endedAt: now - 100, status: 'ended' });
    store.upsertHuddle({ callId: 'Rpriv', channelId: 'Cpriv', startedAt: now - 200, endedAt: now - 100, status: 'ended' });
    const harness = await startDashboard({
      store,
      botChannels: { list: async () => ['Cbot', 'Cpriv'], invalidate() {} },
    });
    try {
      const user = await signIn(harness, { slackUserId: 'U0PLAIN01' });
      const userList = await (
        await fetch(`${harness.base}/api/huddles`, { headers: { cookie: user.cookie } })
      ).json();
      assert(userList.huddles.some((huddle) => huddle.callId === 'Rpub'), 'public huddles are listed');
      assert(!userList.huddles.some((huddle) => huddle.callId === 'Rpriv'), 'private huddles are not');

      const owner = await signIn(harness);
      const ownerList = await (
        await fetch(`${harness.base}/api/huddles`, { headers: { cookie: owner.cookie } })
      ).json();
      assert(ownerList.huddles.some((huddle) => huddle.callId === 'Rpriv'), 'the owner sees both');
    } finally {
      await harness.stop();
    }
  });

  it('only serves the activity log to the owner', async () => {
    const store = await createTestStore();
    store.recordTriggerLog({ userId: 'U1', action: 'huddle_join', detail: 'R1', channelId: 'Cbot' });
    const harness = await startDashboard({ store });
    try {
      assert.equal((await fetch(`${harness.base}/api/stats`)).status, 401, 'no stats without a session');

      const user = await signIn(harness, { slackUserId: 'U0PLAIN01' });
      const asUser = await (await fetch(`${harness.base}/api/stats`, { headers: { cookie: user.cookie } })).json();
      assert.equal(asUser.logs.length, 0, 'a normal user gets no log');

      const owner = await signIn(harness);
      const asOwner = await (await fetch(`${harness.base}/api/stats`, { headers: { cookie: owner.cookie } })).json();
      assert.equal(asOwner.logs.length, 1, 'the owner sees the log');
      assert.equal(asOwner.logs[0].action, 'huddle_join');
    } finally {
      await harness.stop();
    }
  });

  it('signs a visitor out and forgets the session', async () => {
    const harness = await startDashboard();
    try {
      const signedIn = await signIn(harness);
      const out = await fetch(`${harness.base}/logout`, {
        method: 'POST',
        headers: { cookie: signedIn.cookie },
        redirect: 'manual',
      });
      assert.equal(out.status, 302);
      assert.equal(
        (await fetch(`${harness.base}/api/stats`, { headers: { cookie: signedIn.cookie } })).status,
        401,
        'the old cookie no longer works',
      );
    } finally {
      await harness.stop();
    }
  });

  it('explains itself when Slack will not let the bot open a DM', async () => {
    const client = createSlackClientDouble();
    client.conversations.open = mock.fn(async () => {
      throw Object.assign(new Error('An API error occurred: channel_not_found'), {
        data: { error: 'channel_not_found' },
      });
    });
    const harness = await startDashboard({ client });
    try {
      const response = await fetch(`${harness.base}/api/auth/code`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slackUserId: 'U0AEYDUCLKF' }),
      });
      assert.equal(response.status, 400, 'the visitor can fix this, so it is not a 500');
      assert.match((await response.json()).error, /start a chat with the Orbit bot/);
      // A code that was never delivered must not sit in memory waiting to be
      // guessed for ten minutes.
      const verify = await fetch(`${harness.base}/api/auth/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slackUserId: 'U0AEYDUCLKF', code: '424242' }),
      });
      assert.equal(verify.status, 400);
      assert.match((await verify.json()).error, /Request a new code first/);
    } finally {
      await harness.stop();
    }
  });

  it('sends /login home when the app has no oauth client', async () => {
    const harness = await startDashboard();
    try {
      const response = await fetch(`${harness.base}/login`, { redirect: 'manual' });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), '/');
    } finally {
      await harness.stop();
    }
  });

  it('rejects a forged Slack callback state', async () => {
    const harness = await startDashboard();
    try {
      const response = await fetch(`${harness.base}/auth/slack/callback?code=x&state=forged`);
      assert.equal(response.status, 400);
    } finally {
      await harness.stop();
    }
  });
});

describe('dashboard stats', () => {
  it('summarises huddles, uptime and the leaderboard with Cachet profiles', async () => {
    const store = await createTestStore();
    store.upsertHuddle({
      callId: 'R1',
      channelId: 'Cbot',
      createdBy: 'U1',
      startedAt: Math.floor(Date.now() / 1000) - 3600,
      endedAt: Math.floor(Date.now() / 1000) - 60,
      threadRootTs: '1.1',
      participantHistory: ['U1', 'U2'],
    });
    store.setHuddleStatus('R1', 'ended', Math.floor(Date.now() / 1000) - 60);
    store.awardHuddlePoints('U1', 40, 'Cbot');
    store.awardHuddlePoints('U2', 10, 'Cbot');

    const cachet = createCachetDirectory({
      fetchImpl: async (url) =>
        new Response(
          JSON.stringify({
            userId: url.split('/').pop(),
            displayName: 'Sam',
            realName: 'Sam Rivera',
            imageUrl: 'https://img/sam.png',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      logger: { warn: mock.fn() },
    });

    const stats = await buildDashboardStats({
      store,
      botChannels: { list: async () => ['Cbot'] },
      permissions: { role: ROLES.OWNER, isOwner: true, isManager: true, managedChannelIds: null },
      cachet,
      startedAt: Date.now() - 60000,
      statusEvents: [{ state: 'ok', at: new Date().toISOString() }],
    });

    assert.equal(stats.huddles.ended, 1);
    assert.equal(stats.huddles.members, 2);
    // A scoped board is built from the attributed copy only, so it can only show
    // points we can prove landed in the scope.
    store.awardHuddlePoints('U3', 120, 'Celsewhere');
    store.awardHuddlePoints('U4', 90);
    const scoped = store.listHuddleLeaderboard(25, ['Cbot']);
    assert(
      !scoped.some((row) => row.user_id === 'U3'),
      'points from a channel outside the scope stay off the scoped board',
    );
    assert(!scoped.some((row) => row.user_id === 'U4'), 'points with no channel at all stay off the scoped board');
    assert.deepEqual(
      scoped.map((row) => [row.user_id, row.points]),
      [
        ['U1', 40],
        ['U2', 10],
      ],
      'the scoped board is exactly the in-scope channels',
    );
    assert.equal(stats.uptime.seconds >= 59, true);
    assert.equal(stats.uptime.state, 'ok');
    assert.equal(stats.leaderboard[0].userId, 'U1');
    assert.equal(stats.leaderboard[0].points, 40);
    assert.equal(stats.leaderboard[0].displayName, 'Sam');
    assert.equal(stats.leaderboard[0].imageUrl, 'https://img/sam.png');
    assert.equal(stats.botChannels.count, 1);
    store.close();
  });

  it('resolves and remembers a channel name Slack knows and the database does not', async () => {
    const store = await createTestStore();
    // A channel configured from its id has no name anywhere, which is the
    // production case that made the dashboard print a raw C... id.
    // Positively public. An unseeded channel is 'unknown', which the privacy
    // rules treat as private, so a public fixture has to actually claim to be one.
    store.upsertHuddleChannel({ channelId: 'Cunknown', isPrivate: false });
    store.upsertHuddleChannel({ channelId: 'Cnamed', name: 'already-known', isPrivate: false });
    const seen = [];
    const botChannels = {
      list: async () => ['Cunknown', 'Cnamed'],
      names: async (ids) => {
        seen.push([...ids]);
        return { Cunknown: 'j-log' };
      },
      team: async () => 'T0266FRGM',
    };
    const stats = await buildDashboardStats({
      store,
      botChannels,
      permissions: { role: ROLES.OWNER, isOwner: true, isManager: false, managedChannelIds: null },
      cachet: null,
      startedAt: Date.now(),
      statusEvents: [],
    });

    assert.deepEqual(seen, [['Cunknown']], 'only the nameless channel is looked up');
    const channels = Object.fromEntries(stats.channels.map((c) => [c.id, c.name]));
    assert.equal(channels.Cunknown, 'j-log', 'the raw id is replaced by a real name');
    assert.equal(channels.Cnamed, 'already-known', 'a known name is left alone');
    assert.equal(stats.teamId, 'T0266FRGM', 'the team id is exposed for profile links');

    // Second load must not need Slack again.
    seen.length = 0;
    const again = await buildDashboardStats({
      store,
      botChannels: {
        ...botChannels,
        names: async (ids) => {
          seen.push(ids);
          return {};
        },
      },
      permissions: { role: ROLES.OWNER, isOwner: true, isManager: false, managedChannelIds: null },
      cachet: null,
      startedAt: Date.now(),
      statusEvents: [],
    });
    assert.deepEqual(seen, [], 'the resolved name was persisted, so no lookup is needed');
    assert.equal(Object.fromEntries(again.channels.map((c) => [c.id, c.name])).Cunknown, 'j-log');
    store.close();
  });

  it('counts a channel only when it is tracked and the bot is in it', async () => {
    const store = await createTestStore();
    store.upsertHuddleChannel({ channelId: 'Cinbot' });
    store.upsertHuddleChannel({ channelId: 'Cnotbot' });
    store.awardHuddlePoints('U1', 500, 'Cinbot');
    store.awardHuddlePoints('U2', 400, 'Cnotbot');
    store.awardHuddlePoints('U3', 300, 'Cuntracked');
    const stats = await buildDashboardStats({
      store,
      botChannels: { list: async () => ['Cinbot', 'Cuntracked'] },
      permissions: { role: ROLES.OWNER, isOwner: true, isManager: false, managedChannelIds: null },
      cachet: null,
      startedAt: Date.now(),
      statusEvents: [],
    });
    assert.equal(stats.botChannels.count, 2, 'the bot is in two channels');
    assert.deepEqual(
      stats.leaderboard.map((row) => [row.userId, row.points]),
      [['U1', 500]],
      'only the tracked channel the bot is also in scores',
    );
    store.close();
  });

  it('gives a signed in viewer a card for every channel the bot is in', async () => {
    const store = await createTestStore();
    store.upsertHuddleChannel({ channelId: 'Cknown', name: 'known' });
    const botChannels = {
      list: async () => ['Cknown', 'Cwaveland'],
      names: async (ids) => Object.fromEntries((ids || []).map((id) => [id, id === 'Cwaveland' ? 'waveland' : ''])),
    };

    // Signed in: a channel the bot was just invited to is on the page as an empty
    // card, instead of being invisible until somebody huddles there.
    const signedIn = await buildDashboardStats({
      store,
      botChannels,
      permissions: { role: ROLES.USER, isOwner: false, isManager: false, managedChannelIds: [] },
      cachet: null,
      startedAt: Date.now(),
      statusEvents: [],
    });
    assert(
      signedIn.channels.some((c) => c.id === 'Cwaveland'),
      'every channel the bot is in has a card',
    );

    // Anonymous: the public page does not publish channels it has no history for.
    const anonymous = await buildDashboardStats({
      store,
      botChannels,
      permissions: { role: null, isOwner: false, isManager: false, managedChannelIds: [] },
      cachet: null,
      startedAt: Date.now(),
      statusEvents: [],
    });
    assert(!anonymous.channels.some((c) => c.id === 'Cwaveland'), 'no extra channels for the public page');
    store.close();
  });

  it('re-attributes pre-attribution huddles so a scoped board is not empty', async () => {
    const store = await createTestStore();
    // A huddle that ended before huddle_channel_points existed: it has a lifetime
    // score and no attributed copy, which is what used to leave the scoped board
    // showing nothing (or, worse, everything).
    const startedAt = Math.floor(Date.now() / 1000) - 7200;
    store.upsertHuddle({
      callId: 'R1',
      channelId: 'Cbot',
      createdBy: 'U1',
      startedAt,
      endedAt: startedAt + 600,
      participantHistory: ['U1', 'U2'],
    });
    store.setHuddleStatus('R1', 'ended', startedAt + 600);
    store.upsertHuddleMember({
      callId: 'R1',
      userId: 'U1',
      firstSeenAt: startedAt,
      lastSeenAt: startedAt + 600,
      isIn: false,
    });
    store.upsertHuddleMember({
      callId: 'R1',
      userId: 'U2',
      firstSeenAt: startedAt,
      lastSeenAt: startedAt + 300,
      isIn: false,
    });
    // Awarded before attribution existed: a lifetime score with no channel, which
    // is exactly the shape of history the rebuild has to recover.
    store.awardHuddlePoints('U1', 10);

    assert.deepEqual(store.huddlePointTotals(), { lifetime: 10, attributed: 0, rows: 0 });
    assert.equal(store.listHuddleLeaderboard(25, ['Cbot']).length, 0, 'nothing attributed yet');

    const result = backfillChannelPoints(store, { logger: { info: () => {} } });
    assert.equal(result.huddles, 1, 'the one ended huddle is rescored');
    assert.equal(result.rows, 2, 'one row per participant in the channel');
    assert.equal(store.huddlePointTotals().attributed > 10, true, 'rank and starter points come back too');
    assert.equal(backfillChannelPoints(store, { logger: { info: () => {} } }), null, 'a second run is a no-op');

    const scoped = store.listHuddleLeaderboard(25, ['Cbot']);
    assert.deepEqual(
      scoped.map((row) => row.user_id),
      ['U1', 'U2'],
      'both participants are back on the board',
    );
    assert.equal(scoped[0].points > scoped[1].points, true, 'U1 stayed in for twice as long');
    assert(store.listHuddleLeaderboard(25, ['Cother']).length === 0, 'a different scope still sees nothing');
    store.close();
  });

  it('rebuilds the attributed copy from the huddles it was given', async () => {
    const store = await createTestStore();
    const startedAt = Math.floor(Date.now() / 1000) - 3600;
    store.upsertHuddle({
      callId: 'R1',
      channelId: 'Cone',
      createdBy: 'U1',
      startedAt,
      endedAt: startedAt + 120,
      participantHistory: ['U1'],
    });
    store.setHuddleStatus('R1', 'ended', startedAt + 120);
    store.upsertHuddleMember({
      callId: 'R1',
      userId: 'U1',
      firstSeenAt: startedAt,
      lastSeenAt: startedAt + 120,
      isIn: false,
    });
    // A still-running huddle has no score yet and must not be counted.
    store.upsertHuddle({
      callId: 'R2',
      channelId: 'Cone',
      createdBy: 'U1',
      startedAt: startedAt + 200,
      participantHistory: ['U1'],
    });

    const awarded = new Map([['U1', { points: 7 }]]);
    const result = store.rebuildHuddleChannelPoints(() => awarded);
    assert.equal(result.huddles, 1, 'only ended huddles are scored');
    assert.equal(result.rows, 1);
    assert.deepEqual(store.listHuddleLeaderboard(25, ['Cone']), [{ user_id: 'U1', points: 7 }]);

    // A rebuild replaces rather than accumulates, so running it twice is safe.
    store.rebuildHuddleChannelPoints(() => awarded);
    assert.deepEqual(store.listHuddleLeaderboard(25, ['Cone']), [{ user_id: 'U1', points: 7 }]);
    assert.throws(() => store.rebuildHuddleChannelPoints(), TypeError);
    store.close();
  });
});

describe('the rebuilt site', () => {
  it('renders a landing page that asks for no data', () => {
    const landing = renderLanding({ signedIn: false });
    assert.match(landing, /Huddles, <em>scored<\/em> and remembered/);
    assert.doesNotMatch(landing, /api\/overview|api\/leaderboard|api\/huddles/, 'the public page fetches nothing');
    assert.doesNotMatch(landing, /U0[A-Z0-9]{7,}/, 'no real account ids on the public page');
    assert.match(landing, /Sign in with Slack/);
  });

  it('keeps the app behind a session and renders one page at a time', () => {
    const app = renderApp({ signedIn: true, role: 'owner', view: 'dashboard' });
    assert.match(app, /id="k-active"/);
    assert.match(app, /\/api\/overview/, 'the shell asks for its own sections');
    assert.match(app, /\/api\/leaderboard/);
    assert.match(app, /\/api\/huddles\?limit=8/);
    assert.doesNotMatch(app, /member id/i, 'no member-id sign in form');
  });

  it('ships the design tokens and no em dashes', () => {
    const html = renderLanding({}) + renderApp({ signedIn: true, role: 'owner', view: 'dashboard' });
    assert.match(html, /--accent:#cba6f7/);
    assert.match(html, /color-scheme:dark/);
    assert.doesNotMatch(html, /\u2014/, 'no em dashes');
  });

  it('shows each person exactly the sections they can use', () => {
    const owner = renderApp({ signedIn: true, role: 'owner', view: 'dashboard' });
    for (const label of ['Dashboard', 'Huddles', 'Channels', 'Recaps', 'Daily update', 'Users', 'Messages', 'Admin']) {
      assert(owner.includes('>' + label + '<'), `owner sees ${label}`);
    }
    const manager = renderApp({ signedIn: true, role: 'manager', view: 'dashboard' });
    assert(manager.includes('>Channels<'));
    assert(!manager.includes('>Users<'), 'a manager has no user administration');
    assert(!manager.includes('>Daily update<'), 'no daily update for a manager');
  });

  it('has skeletons only inside the sections that are loading', () => {
    const html = renderApp({ signedIn: true, role: 'owner', view: 'dashboard' });
    assert.match(html, /id="recent-body"[^>]*>[^<]*<tr><td[^>]*><span class="skel"/);
    assert.match(html, /id="board"[^>]*><li><span class="skel"/);
  });

  it('shows the viewer where their own points came from', () => {
    const html = renderApp({ signedIn: true, role: 'owner', view: 'dashboard' });
    assert.match(html, /id="my-points"/);
    assert.match(html, /\/api\/me\/points/);
  });

  it('has one place on the dashboard for the agreement', () => {
    const html = renderApp({ signedIn: true, role: 'owner', view: 'dashboard' });
    assert.match(html, /id="agreement"/);
    assert.match(html, /\/api\/me\/agreement/);
    assert.match(html, /data-agree/);
  });

  it('carries the duration helper the tables use', () => {
    const html = renderApp({ signedIn: true, role: 'owner', view: 'huddles' });
    assert.match(html, /function dur\(seconds\)/);
    assert.match(html, /function huddleRows\(rows\)/);
  });
});

describe('dashboard scoping and channel owners', () => {
  function seedHuddle(store, callId, channelId, startedAgoSeconds, durationSeconds) {
    const startedAt = Math.floor(Date.now() / 1000) - startedAgoSeconds;
    store.upsertHuddle({
      callId,
      channelId,
      createdBy: 'U1',
      startedAt,
      endedAt: startedAt + durationSeconds,
      participantHistory: ['U1'],
      threadRootTs: '170000.000000',
    });
    store.setHuddleStatus(callId, 'ended', startedAt + durationSeconds);
    store.upsertHuddleMember({
      callId,
      userId: 'U1',
      firstSeenAt: startedAt,
      lastSeenAt: startedAt + durationSeconds,
      isIn: false,
    });
  }

  it('counts only channels the bot is actually in', async () => {
    const store = await createTestStore();
    // Two huddles in channels the bot can see, one in a channel it cannot. The
    // third could never have scored, so counting it inflates the homepage.
    seedHuddle(store, 'Rin1', 'Cbot', 3600, 600);
    seedHuddle(store, 'Rin2', 'Cbot', 7200, 300);
    seedHuddle(store, 'Rout', 'Celsewhere', 3600, 900);
    store.upsertHuddleChannel({ channelId: 'Cbot', name: 'bot' });
    store.upsertHuddleChannel({ channelId: 'Celsewhere', name: 'elsewhere' });

    const stats = await buildDashboardStats({
      store,
      botChannels: { list: async () => ['Cbot'] },
      permissions: { role: ROLES.OWNER, isOwner: true, isManager: true, managedChannelIds: null },
      cachet: null,
      startedAt: Date.now() - 60000,
    });

    assert.equal(stats.huddles.ended, 2, 'the out-of-bot huddle is not counted');
    assert.deepEqual(
      stats.channels.map((channel) => channel.id),
      ['Cbot'],
      'and its channel is not offered as a card',
    );
    assert.equal(stats.channels[0].inBot, true);
    store.close();
  });

  it('adopts the Flaron creator as the first owner, then leaves App Home edits alone', async () => {
    const store = await createTestStore();
    store.upsertHuddleChannel({ channelId: 'Cjlog', name: 'j-log', isPrivate: false });
    // Flaron already makes the channel creator its owner, so that is who the
    // website should show as the CM without anyone touching App Home.
    const flaron = {
      list: async () => ({
        Cjlog: {
          channelId: 'Cjlog',
          name: 'j-log',
          members: 27,
          managers: ['U0AEYDUCLKF'],
          creator: 'U0AEYDUCLKF',
        },
      }),
    };

    const first = await buildDashboardStats({
      store,
      botChannels: { list: async () => ['Cjlog'] },
      permissions: { role: ROLES.OWNER, isOwner: true, isManager: true, managedChannelIds: null },
      cachet: null,
      flaron,
      startedAt: Date.now() - 60000,
    });

    assert.deepEqual(
      first.channels[0].managers.map((manager) => manager.userId),
      ['U0AEYDUCLKF'],
      'the creator is the channel manager on the site',
    );
    assert.deepEqual(
      JSON.parse(store.getHuddleChannel('Cjlog').owner_ids),
      ['U0AEYDUCLKF'],
      'and it is written down, so App Home shows the same thing',
    );
    assert.equal(first.leaderboard.length >= 0, true);

    // Jacob then swaps the owner list over in App Home. That is the source of
    // truth from here, so a later Flaron sync must not drag the old owner back.
    store.upsertHuddleChannel({ channelId: 'Cjlog', name: 'j-log', ownerIds: ['UOTHER'] });
    seedHuddle(store, 'Rjlog', 'Cjlog', 3600, 600);
    store.awardHuddlePoints('UOTHER', 40, 'Cjlog');
    const second = await buildDashboardStats({
      store,
      botChannels: { list: async () => ['Cjlog'] },
      permissions: { role: ROLES.OWNER, isOwner: true, isManager: true, managedChannelIds: null },
      cachet: null,
      flaron,
      startedAt: Date.now() - 60000,
    });

    assert.deepEqual(
      second.channels[0].managers.map((manager) => manager.userId),
      ['UOTHER'],
      'the hand edited owner list wins over the Flaron creator',
    );
    assert.equal(
      second.leaderboard.some((row) => row.userId === 'UOTHER' && row.channelManager),
      true,
      'and the new owner gets a CM tag on the board',
    );
    store.close();
  });
});

describe('bot delivered sign in link', () => {
  it('signs someone in from a link the bot DMs, once, and only to them', async () => {
    const store = await createTestStore();
    const auth = createDashboardAuth({
      client: createSlackClientDouble(),
      store,
      logger: { warn: mock.fn(), error: mock.fn() },
    });

    const link = auth.issueMagicLink('U0AEYDUCLKF', 'https://asteria.navaratne.uk/');
    assert.match(link, /^https:\/\/asteria\.navaratne\.uk\/auth\/magic\?token=/, 'a link, not a bare code');

    const token = new URL(link).searchParams.get('token');
    const redeemed = auth.consumeMagicLink(token);
    assert.deepEqual(redeemed, { ok: true, slackUserId: 'U0AEYDUCLKF' });

    assert.equal(auth.consumeMagicLink(token).ok, false, 'a link only works once, so a forwarded copy is worthless');
    assert.equal(auth.consumeMagicLink('').ok, false);
    assert.equal(auth.consumeMagicLink('nonsense').ok, false);
    store.close();
  });
});

describe('placeholder duration repair', () => {
  it('rewrites huddles left at the 12h placeholder and leaves real ones alone', async () => {
    const store = await createTestStore();
    const startedAt = 1700000000;
    // The sweep gave up on this one and wrote start-plus-twelve-hours.
    store.upsertHuddle({ callId: 'Rfake', channelId: 'C1', startedAt, endedAt: startedAt + 43200 });
    store.setHuddleStatus('Rfake', 'ended', startedAt + 43200);
    store.upsertHuddleMember({
      callId: 'Rfake',
      userId: 'U1',
      firstSeenAt: startedAt,
      lastSeenAt: startedAt + 540,
      isIn: false,
    });
    // This one ended normally, 10 minutes in.
    store.upsertHuddle({ callId: 'Rreal', channelId: 'C1', startedAt, endedAt: startedAt + 600 });
    store.setHuddleStatus('Rreal', 'ended', startedAt + 600);
    store.upsertHuddleMember({
      callId: 'Rreal',
      userId: 'U1',
      firstSeenAt: startedAt,
      lastSeenAt: startedAt + 600,
      isIn: false,
    });

    const result = store.repairPlaceholderHuddleEnds();

    assert.equal(result.rows, 1, 'only the placeholder row is touched');
    assert.equal(
      store.getHuddle('Rfake').ended_at,
      startedAt + 540,
      'closed at the last moment a member was recorded present',
    );
    assert.equal(store.getHuddle('Rreal').ended_at, startedAt + 600, 'a real duration is left alone');
    assert.equal(store.repairPlaceholderHuddleEnds().rows, 0, 'safe to run again');
    store.close();
  });
});
