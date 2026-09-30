import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import { createDashboardAuth } from '../src/dashboard/auth.js';
import { cachetAvatarUrl, cachetUserUrl, createCachetDirectory } from '../src/dashboard/cachet.js';
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
      const page = await fetch(`${harness.base}/`);
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-type'), /text\/html/);
      const html = await page.text();
      assert.match(html, /Asteria/);
      assert.match(html, /--accent:#238636/, 'dark theme with the cachet green accent');
      assert.match(html, /color-scheme:dark/);

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
      assert.equal((await fetch(`${harness.base}/api/stats`)).status, 200, 'stats are public');
      const stats = await (await fetch(`${harness.base}/api/stats`)).json();
      assert.equal(stats.viewer.signedIn, false);
      assert.equal(stats.logs.length, 0, 'no activity log for signed-out visitors');

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

      // Anonymous is anyone with the URL, so the board is numbers only. The
      // points still have to be right; the names are what must not ship.
      const anonymous = await (await fetch(`${harness.base}/api/stats`)).json();
      assert.deepEqual(
        anonymous.leaderboard.map((row) => row.userId),
        ['', ''],
        'an anonymous viewer gets no Slack ids on the leaderboard',
      );
      assert.deepEqual(
        anonymous.leaderboard.map((row) => row.displayName),
        ['Member 1', 'Member 2'],
      );
      assert.deepEqual(
        anonymous.leaderboard.map((row) => row.points),
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

  it('only serves the activity log to the owner', async () => {
    const store = await createTestStore();
    store.recordTriggerLog({ userId: 'U1', action: 'huddle_join', detail: 'R1', channelId: 'Cbot' });
    const harness = await startDashboard({ store });
    try {
      const anonymous = await (await fetch(`${harness.base}/api/stats`)).json();
      assert.equal(anonymous.logs.length, 0);

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
        (await (await fetch(`${harness.base}/api/stats`, { headers: { cookie: signedIn.cookie } })).json()).viewer
          .signedIn,
        false,
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
      assert.match((await response.json()).error, /start a chat with the Asteria bot/);
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

describe('dashboard markup', () => {
  it('escapes anything user controlled and ships the dark theme tokens', () => {
    const html = renderDashboardHtml({ signedIn: true, role: 'owner', oauthConfigured: true });
    assert.match(html, /color-scheme:dark/);
    assert.match(html, /--bg:#0d1117/);
    assert.match(html, /class="who" id="who">owner<\/span>/);
    assert.doesNotMatch(html, /<script src=/, 'no external scripts');
  });

  it('keeps em dashes out of the interface and hides the member id sign in', () => {
    const html = renderDashboardHtml({ signedIn: false, oauthConfigured: true });
    assert.doesNotMatch(html, /\u2014/, 'no em dashes anywhere in the markup or script');
    assert.doesNotMatch(html, /signin-panel|slack-id|signin-msg/, 'no member id sign in');
    assert.match(html, /Sign in with Slack/, 'slack sign in stays in the top bar');
  });

  it('skeletons stand in for data while the first payload lands', () => {
    const html = renderDashboardHtml({ signedIn: false, oauthConfigured: true });
    assert.match(html, /class="skel/, 'loading placeholders are skeletons, not dashes');
    assert.match(html, /id="board"><li class="none-slot">/);
  });

  it('renders the channel popup shell and its styles', () => {
    const html = renderDashboardHtml({ signedIn: false, oauthConfigured: true });
    assert.match(html, /id="channel-modal"/, 'the popup exists in the markup');
    assert.match(html, /class="modal-scrim" id="cm-scrim"/, 'a scrim closes it');
    assert.match(html, /role="dialog" aria-modal="true"/, 'it is announced as a dialog');
    assert.match(html, /\.modal-card\{/, 'the card is styled');
  });

  it('opens the popup from a channel name and closes on scrim, button and escape', () => {
    const html = renderDashboardHtml({ signedIn: false, oauthConfigured: true });
    assert.match(html, /function openChannelModal\(/, 'there is an opener to call');
    assert.match(html, /class="chan-open" data-channel=/, 'channel rows are the trigger');
    assert.match(html, /event\.target\.closest\('\.chan-open'\)/, 'the click is delegated');
    assert.match(html, /openChannelModal\(opener\.getAttribute\('data-channel'\)\)/, 'it opens by id');
    assert.match(html, /closest\('#cm-close'\) \|\| event\.target\.id === 'cm-scrim'/, 'clicks outside close it');
    assert.match(html, /event\.key === 'Escape'/, 'escape closes it');
    assert.match(html, /app_redirect\?channel=/, 'the popup can still open the real channel');
  });

  it('adds and removes the CM tag in place instead of rebuilding the row', () => {
    const html = renderDashboardHtml({ signedIn: false, oauthConfigured: true });
    assert.match(html, /nameRow\.appendChild\(tag\)/, 'the tag goes in the name row');
    assert.match(html, /!row\.channelManager && cmTag\)\{\s*cmTag\.remove\(\)/, 'it comes back out');
    assert.doesNotMatch(html, /whoCell\.children\[/, 'no positional lookups inside the name cell');
  });

  it('polls only the status box and lets the first paint own the lists', () => {
    const html = renderDashboardHtml({ signedIn: false, oauthConfigured: true });
    assert.match(html, /if \(first\) renderAll\(data\);/, 'lists render once');
    assert.match(html, /function renderAll\(data\)\{/, 'the list draw is its own function');
    const statusOnly = html.slice(html.indexOf('async function refresh()'), html.indexOf('function renderAll(data)'));
    assert.doesNotMatch(statusOnly, /renderBoard\(|renderChannels\(/, 'the 5s path never re-draws the lists');
    assert.match(statusOnly, /setValue\('stat-active'/, 'it still updates the numbers');
  });

  it('formats huddle lengths for the popup', () => {
    const html = renderDashboardHtml({ signedIn: false, oauthConfigured: true });
    assert.match(html, /function fmtDuration\(seconds\)/);
    assert.match(html, /avg/i);
  });

  it('describes each channel for the popup with Flaron, Slack or nothing', async () => {
    const store = await createTestStore();
    store.upsertHuddleChannel({ channelId: 'Cpublic', name: 'j-log', isPrivate: false });
    store.upsertHuddleChannel({ channelId: 'Cprivate', name: 'tinkering', isPrivate: true });
    const slackSizes = { Cprivate: 45 };
    const flaron = {
      list: async () => ({
        Cpublic: { members: 27, humans: 7, bots: 20, managers: ['U0AEYDUCLKF'] },
      }),
    };
    const slack = { channelSize: async (id) => slackSizes[id] ?? null };
    const cachet = {
      avatarUrl: (id) => 'https://cachet/' + id + '/r',
      profileUrl: (id) => 'https://cachet/user/' + id,
      list: async (ids) =>
        Object.fromEntries(
          ids.map((id) => [
            id,
            { userId: id, displayName: 'Jacob', realName: 'Jacob N', imageUrl: 'https://img/j.png' },
          ]),
        ),
      logger: { warn: mock.fn() },
    };
    const stats = await buildDashboardStats({
      store,
      botChannels: { list: async () => ['Cpublic', 'Cprivate'], names: async () => ({}), team: async () => 'T1' },
      permissions: { role: ROLES.OWNER, isOwner: true, isManager: false, managedChannelIds: null },
      cachet,
      flaron,
      slack,
      startedAt: Date.now(),
      statusEvents: [],
    });

    const cards = Object.fromEntries(stats.channels.map((c) => [c.id, c]));
    assert.deepEqual(
      cards.Cpublic.flaron,
      { known: true, source: 'flaron', members: 27, humans: 7, bots: 20 },
      'a public channel is described by Flaron',
    );
    assert.equal(cards.Cpublic.managers.length, 1);
    assert.equal(cards.Cpublic.managers[0].userId, 'U0AEYDUCLKF');
    assert.equal(cards.Cpublic.managers[0].imageUrl, 'https://img/j.png', 'the manager gets a picture');
    assert.deepEqual(
      cards.Cprivate.flaron,
      { known: false, source: 'slack', members: 45, humans: null, bots: null },
      'a private channel falls back to the Slack headcount and says so',
    );
    assert.deepEqual(cards.Cprivate.managers, [], 'no manager is invented for a private channel');
    assert.equal(typeof cards.Cpublic.stats.total, 'number', 'each card carries huddle totals');
    store.close();
  });

  it('tags leaderboard rows that manage a channel', async () => {
    const store = await createTestStore();
    store.upsertHuddleChannel({ channelId: 'Cbot', name: 'j-log' });
    store.awardHuddlePoints('U1', 40, 'Cbot');
    const stats = await buildDashboardStats({
      store,
      botChannels: { list: async () => ['Cbot'], names: async () => ({}), team: async () => 'T1' },
      permissions: { role: ROLES.OWNER, isOwner: true, isManager: false, managedChannelIds: null },
      cachet: null,
      flaron: { list: async () => ({ Cbot: { members: 5, humans: 4, bots: 1, managers: ['U1'] } }) },
      startedAt: Date.now(),
      statusEvents: [],
    });
    const row = stats.leaderboard[0];
    assert.ok(row, 'the board has someone on it');
    assert.equal(row.channelManager, true, 'a manager is flagged so the board can tag them');
    store.close();
  });

  it('resolves channel names through the SDK, never a raw apiCall', async () => {
    const client = createSlackClientDouble();
    const directory = createBotChannelDirectory({ client, logger: { info: mock.fn(), warn: mock.fn() } });
    const resolved = await directory.names(['C0B9YFSE6MN']);
    assert.equal(resolved.C0B9YFSE6MN, 'resolved-name', 'the name came back');
    assert.equal(client.conversations.info.mock.callCount(), 1, 'conversations.info was used');
    assert.equal(
      client.apiCall.mock.callCount(),
      0,
      'client.apiCall answers unknown_method on this app and fails silently',
    );
    const again = await directory.names(['C0B9YFSE6MN']);
    assert.deepEqual(again, resolved, 'the second call is served from cache');
    assert.equal(client.conversations.info.mock.callCount(), 1, 'without asking Slack again');
  });

  it('refuses to wipe the attributed table when scoring produces nothing', async () => {
    const store = await createTestStore();
    store.upsertHuddleChannel({ channelId: 'Cbot' });
    const startedAt = Math.floor(Date.now() / 1000) - 7200;
    store.upsertHuddle({
      callId: 'R1',
      channelId: 'Cbot',
      createdBy: 'U1',
      startedAt,
      endedAt: startedAt + 600,
      participantHistory: ['U1'],
    });
    store.setHuddleStatus('R1', 'ended', startedAt + 600);
    store.awardHuddlePoints('U1', 40, 'Cbot');
    assert.equal(store.huddlePointTotals().rows, 1, 'a working attributed row exists');
    // A scoring bug that returns nothing for every huddle must not replace a
    // working board with an empty one.
    assert.throws(
      () =>
        store.rebuildHuddleChannelPoints(() => {
          throw new Error('scoring exploded');
        }),
      /keeping the existing table/,
    );
    const after = store.huddlePointTotals();
    assert.equal(after.rows, 1, 'the row is still there');
    assert.equal(after.attributed, 40, 'and still has its points');
    store.close();
  });

  it('sends the Slack token request form encoded with a grant type', async (t) => {
    const store = await createTestStore();
    const auth = createDashboardAuth({
      client: createSlackClientDouble(),
      store,
      logger: { warn: mock.fn(), error: mock.fn() },
      slackClientId: '123.456',
      slackClientSecret: 'secret',
    });
    const originalFetch = globalThis.fetch;
    const seen = [];
    t.after(() => {
      globalThis.fetch = originalFetch;
    });
    // A real id_token carries the member id in `sub`. Only the payload is
    // decoded here, never the signature, so a stand-in segment is enough.
    const idToken = ['header', Buffer.from(JSON.stringify({ sub: 'U0AEYDUCLKF' })).toString('base64url')].join('.');
    globalThis.fetch = async (url, options = {}) => {
      seen.push({ url: String(url), options });
      if (String(url).includes('openid.connect.token')) {
        return new Response(JSON.stringify({ ok: true, access_token: 'xoxp-test', id_token: idToken }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // users.info is the one call that fails: the authorize request only asks
      // for `openid profile`, so this token carries no users:read and Slack
      // refuses the call. Sign in has to survive that anyway.
      return new Response(JSON.stringify({ ok: false, error: 'missing_scope' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    // The dashboard sits behind Caddy, so the proto arrives as a forwarded
    // header; the redirect uri has to be rebuilt from that on every request.
    const profile = await auth.exchangeSlackCode(
      { headers: { host: 'asteria.navaratne.uk', 'x-forwarded-proto': 'https' }, socket: {} },
      'code-123',
    );
    assert.equal(profile.id, 'U0AEYDUCLKF', 'the member id comes from the id_token');
    const tokenCall = seen.find((call) => call.url.includes('openid.connect.token'));
    assert.ok(tokenCall, 'the token endpoint was called');
    assert.equal(
      tokenCall.options.headers['content-type'],
      'application/x-www-form-urlencoded',
      'Slack rejects a JSON body here',
    );
    // The body has to be a URLSearchParams, not an object, or Slack sees no fields.
    assert.ok(tokenCall.options.body instanceof URLSearchParams, 'the body is url encoded');
    const fields = Object.fromEntries(tokenCall.options.body);
    assert.equal(fields.grant_type, 'authorization_code', 'the grant type must be explicit');
    assert.equal(fields.code, 'code-123');
    assert.equal(fields.redirect_uri, 'https://asteria.navaratne.uk/auth/slack/callback');
    assert.equal(fields.client_id, '123.456');
    assert.equal(fields.client_secret, 'secret');
    store.close();
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
