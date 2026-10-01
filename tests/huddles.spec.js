import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import { buildHuddlesView } from '../src/app-home/views.js';
import { createStore } from '../src/database/store.js';
import { computeHuddlePoints } from '../src/huddles/points.js';
import {
  computeHuddleStats,
  extractMessageText,
  formatDuration,
  formatHuddleReviewMessage,
  resolveHuddleThreadMessageStats,
} from '../src/huddles/review.js';
import { nextUserHuddleAction } from '../src/huddles/state.js';
import { createHuddleTracker } from '../src/huddles/tracker.js';

let createdPaths = [];

afterEach(() => {
  for (const databasePath of createdPaths) {
    fs.rmSync(path.dirname(databasePath), { recursive: true, force: true });
  }
  createdPaths = [];
});

async function createTestStore() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-huddles-'));
  const databasePath = path.join(tempDir, 'asteria.sqlite');
  createdPaths.push(databasePath);
  return createStore(databasePath);
}

// Every channel the huddle tests use. The tracker refuses to consider a huddle in
// a channel the bot is not in, so the harness has to report membership for them.
const ALL_TEST_CHANNELS = [
  'Celsewhere',
  'Chippo',
  'Cmine',
  'Cmute',
  'Cpress',
  'Cquiet',
  'Crandom',
  'Creview',
  'Cthr',
  'Cbot',
  'Dquiet',
];

function createTrackerHarness({
  store,
  client,
  ownerId,
  botChannelIds,
  botChannels,
  baseUrl = 'https://asteria.test',
}) {
  const handlers = {};
  const app = {
    event: (eventName, handler) => {
      handlers[`event:${eventName}`] = handler;
    },
    message: (handler) => {
      handlers.message = handler;
    },
    action: (actionId, handler) => {
      handlers[`action:${actionId}`] = handler;
    },
    error: mock.fn(),
  };
  const tracker = createHuddleTracker({
    app,
    store,
    client,
    logger: { error: mock.fn(), info: mock.fn() },
    ownerId,
    botChannels: botChannels ?? { list: mock.fn(async () => botChannelIds ?? ALL_TEST_CHANNELS) },
    baseUrl,
  });
  return { handlers, tracker };
}

// Count only posts that carry a Slack action button. A huddle thread now also
// carries a link notice and a summary, which have no buttons, so a raw
// callCount would be asserting the wrong thing the moment either is added.
function countButtonPosts(client, actionId) {
  return client.chat.postMessage.mock.calls.filter((call) => {
    const arg = call.arguments[0];
    return (arg.blocks ?? []).some((block) =>
      (block.elements ?? []).some((element) => (actionId ? element.action_id === actionId : true)),
    );
  }).length;
}

function buttonPosts(client, actionId) {
  return client.chat.postMessage.mock.calls
    .map((call) => call.arguments[0])
    .filter((arg) =>
      (arg.blocks ?? []).some((block) => (block.elements ?? []).some((element) => element.action_id === actionId)),
    );
}

function textsPosted(client) {
  return client.chat.postMessage.mock.calls.map((call) => call.arguments[0].text ?? '');
}

function createBasicClient() {
  return {
    auth: {
      test: mock.fn(async () => ({ user_id: 'BOTUSER', bot_id: 'BOT123' })),
    },
    users: {
      // Huddle reviews name people instead of mentioning them, which needs a
      // display name per Slack id.
      info: mock.fn(async ({ user }) => ({
        user: { id: user, profile: { display_name: `name-${user}` } },
      })),
    },
    chat: {
      postMessage: mock.fn(async () => ({ ts: '111.222' })),
      getPermalink: mock.fn(async (args) => ({
        permalink: `https://example.slack.com/archives/C/p${args.message_ts}`,
      })),
      update: mock.fn(async () => ({ ts: '111.222' })),
      postEphemeral: mock.fn(async () => ({ ok: true })),
    },
    conversations: {
      open: mock.fn(async () => ({ channel: { id: 'Dquiet' } })),
      history: mock.fn(async () => ({ messages: [] })),
      replies: mock.fn(async () => ({ messages: [] })),
    },
  };
}

async function flush(times = 10) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

describe('huddle state reducer', () => {
  it('joins when a user enters a huddle', () => {
    const actions = nextUserHuddleAction(null, {
      huddleState: 'in_a_huddle',
      callId: 'R1',
    });
    assert.deepEqual(actions, [{ type: 'join', callId: 'R1' }]);
  });

  it('leaves when a huddled user leaves, falling back to the previous call id', () => {
    const actions = nextUserHuddleAction(
      { user_id: 'U1', call_id: 'R1', is_in: 1 },
      { huddleState: 'not_in_a_huddle', callId: '' },
    );
    assert.deepEqual(actions, [{ type: 'leave', callId: 'R1' }]);
  });

  it('emits leave + join when switching straight into another huddle', () => {
    const actions = nextUserHuddleAction(
      { user_id: 'U1', call_id: 'R1', is_in: 1 },
      { huddleState: 'in_a_huddle', callId: 'R2' },
    );
    assert.deepEqual(actions, [
      { type: 'leave', callId: 'R1' },
      { type: 'join', callId: 'R2' },
    ]);
  });

  it('ignores a stray leave after restart and unknown states', () => {
    assert.deepEqual(nextUserHuddleAction(null, { huddleState: 'not_in_a_huddle', callId: '' }), []);
    assert.deepEqual(nextUserHuddleAction(null, { huddleState: 'in_a_huddle', callId: '' }), []);
  });

  it('refreshes a join when the same huddle is reported twice', () => {
    const actions = nextUserHuddleAction(
      { user_id: 'U1', call_id: 'R1', is_in: 1 },
      { huddleState: 'in_a_huddle', callId: 'R1' },
    );
    assert.deepEqual(actions, [{ type: 'join', callId: 'R1' }]);
  });
});

describe('huddle review stats', () => {
  const huddle = {
    call_id: 'R1',
    channel_id: 'C123',
    channel_name: 'random',
    created_by: 'U1',
    started_at: 1000,
    ended_at: 1300,
    thread_root_ts: '1000.000000',
    participant_json: '[]',
  };
  const members = [
    { call_id: 'R1', user_id: 'U1', first_seen_at: 1000, last_seen_at: 1300, is_in: 0 },
    { call_id: 'R1', user_id: 'U2', first_seen_at: 1100, last_seen_at: 1200, is_in: 0 },
  ];

  it('computes durations and picks the longest attendee', () => {
    const stats = computeHuddleStats({ huddle, members });
    assert.equal(stats.durationSeconds, 300);
    assert.equal(stats.longestParticipantId, 'U1');
    assert.deepEqual(
      stats.participants.map((participant) => participant.userId),
      ['U1', 'U2'],
    );
    assert.equal(stats.participants[0].durationSeconds, 300);
    assert.equal(stats.participants[1].durationSeconds, 100);
  });

  it('folds in attendance history entries with unknown durations', () => {
    const stats = computeHuddleStats({
      huddle,
      members,
      participantHistory: ['U1', 'U2', 'U3'],
    });
    assert.equal(stats.participants.length, 3);
    const third = stats.participants[2];
    assert.equal(third.userId, 'U3');
    assert.equal(third.durationSeconds, null);
  });

  it('formats a review message with attendance and chat stats', () => {
    const stats = computeHuddleStats({ huddle, members });
    stats.messageStats = {
      longest: {
        userId: 'U2',
        text: 'hello world this is a long message',
        length: 34,
        ts: '1000.1',
        permalink: 'https://p',
      },
      shortest: { userId: 'U1', text: 'yo', length: 2, ts: '1000.2', permalink: 'https://p2' },
    };
    const message = formatHuddleReviewMessage(stats, {
      timezone: 'UTC',
      displayNames: { U1: 'Olive', U2: 'Wallace' },
    });
    assert(message.includes('Huddle review'));
    assert(message.includes('#random'));
    assert(message.includes('Olive — 5m'));
    assert(message.includes('Wallace — 1m 40s'));
    assert(message.includes('longest in the huddle'));
    assert(message.includes('34 chars by Wallace'));
    assert(message.includes('2 chars by Olive'));
    assert(message.includes('https://p'));
  });

  it('names people in a review without ever mentioning them', () => {
    const stats = computeHuddleStats({
      huddle: {
        call_id: 'R9',
        channel_id: 'C1',
        created_by: 'U1',
        started_at: 1000,
        ended_at: 1300,
        thread_root_ts: '1000.1',
      },
      members: [
        { user_id: 'U1', first_seen_at: 1000, last_seen_at: 1300 },
        { user_id: 'U2', first_seen_at: 1000, last_seen_at: 1100 },
      ],
    });
    stats.channelName = 'random';
    stats.messageStats = {
      longest: { userId: 'U2', text: 'hi', length: 2, ts: '1', permalink: 'https://p' },
      shortest: { userId: 'U1', text: 'yo', length: 2, ts: '2', permalink: 'https://p2' },
    };

    // A review is read by whoever asks for it, and everyone on the call is
    // listed in it. Mentioning them made reading the stats notify the whole
    // call, so there must be no mention syntax anywhere in the output.
    const message = formatHuddleReviewMessage(stats, {
      timezone: 'UTC',
      displayNames: { U1: 'Olive', U2: 'Wallace' },
    });
    assert.equal(message.match(/<@[A-Z0-9]+>/g), null, 'no mentions in a huddle review');
    assert(!message.includes('@U1') && !message.includes('@U2'), 'not even a bare user id');
    assert(message.includes('*Started by:* Olive'), 'the host is named in plain text');

    // A name we could not resolve must still not become a ping.
    const unknown = formatHuddleReviewMessage(stats, { timezone: 'UTC', displayNames: {} });
    assert.equal(unknown.match(/<@[A-Z0-9]+>/g), null, 'still no mentions when names are missing');
    assert(unknown.includes('*Started by:* U1'), 'falls back to the raw id instead of a mention');
  });

  it('formats durations human-readably', () => {
    assert.equal(formatDuration(45), '45s');
    assert.equal(formatDuration(120), '2m');
    assert.equal(formatDuration(320), '5m 20s');
    assert.equal(formatDuration(null), 'unknown');
  });
});

describe('huddle thread message stats', () => {
  it('extracts text from rich text blocks', () => {
    const message = {
      blocks: [
        {
          type: 'rich_text',
          elements: [
            {
              type: 'rich_text_section',
              elements: [
                { type: 'text', text: 'hello ' },
                { type: 'text', text: 'world' },
              ],
            },
          ],
        },
      ],
    };
    assert.equal(extractMessageText(message), 'hello world');
  });

  it('finds the longest and shortest participant messages in the window', async () => {
    const client = {
      conversations: {
        replies: mock.fn(async () => ({
          messages: [
            { type: 'message', user: 'U1', ts: '1000.000001', text: 'hi' },
            { type: 'message', subtype: 'huddle_thread', user: 'USLACKBOT', ts: '1000.000000', text: '' },
            { type: 'message', subtype: 'bot_message', user: 'U1', ts: '1010', text: 'bot stuff' },
            { type: 'message', user: 'U2', ts: '1100', text: 'hello world this is long' },
            { type: 'message', user: 'U2', ts: '2000', text: 'after the huddle' },
            { type: 'message', user: 'U3', ts: '1050', text: 'outsider' },
          ],
        })),
      },
      chat: {
        getPermalink: mock.fn(async (args) => ({ permalink: `https://p/${args.message_ts}` })),
      },
    };

    const result = await resolveHuddleThreadMessageStats({
      client,
      channelId: 'C123',
      threadRootTs: '1000.000000',
      startedAt: 1000,
      endedAt: 1300,
      memberIds: ['U1', 'U2'],
    });

    assert(result);
    assert.equal(result.longest.userId, 'U2');
    assert.equal(result.longest.length, 24);
    assert.equal(result.shortest.userId, 'U1');
    assert.equal(result.shortest.length, 2);
    assert.equal(result.longest.permalink, 'https://p/1100');
    assert.equal(result.shortest.permalink, 'https://p/1000.000001');
  });

  it('returns null when the thread is unavailable', async () => {
    const result = await resolveHuddleThreadMessageStats({
      client: createBasicClient(),
      channelId: '',
      threadRootTs: '',
      startedAt: 1000,
      endedAt: 1300,
      memberIds: [],
    });
    assert.equal(result, null);
  });
});

describe('huddles app home tab', () => {
  it('lists huddles with channel and local date, most recent first', () => {
    const view = buildHuddlesView({
      timezone: 'UTC',
      notice: '',
      huddles: [
        {
          call_id: 'R1',
          channel_id: 'C123',
          started_at: 1754300000,
          status: 'ended',
        },
        {
          call_id: 'R2',
          channel_id: '',
          started_at: 1754213600,
          status: 'active',
        },
      ],
    });

    assert.equal(view.type, 'home');
    assert(view.blocks.some((block) => block.text?.text.includes('<#C123>')));
    assert(view.blocks.some((block) => block.text?.text.includes('Aug 2025')));
    assert(view.blocks.some((block) => block.text?.text.includes('active now')));
    assert(view.blocks.some((block) => block.text?.text.includes('unknown channel')));
  });

  it('shows an empty state when no huddles exist', () => {
    const view = buildHuddlesView({ timezone: 'UTC', notice: '', huddles: [] });
    assert(view.blocks.some((block) => block.text?.text.includes('No huddles recorded yet')));
  });
});

describe('huddle tracker integration', () => {
  it('tracks a huddle, prompts once when it ends, and generates a review', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    await handlers['event:user_huddle_changed']({
      event: {
        user: {
          id: 'UOWNER',
          profile: { huddle_state: 'in_a_huddle', huddle_state_call_id: 'R1' },
        },
      },
    });

    // A join arrives before the thread message that names the channel, so the
    // huddle is held unverified: nothing may be scored, reviewed or shown until a
    // thread message proves the bot is in that channel.
    const liveHuddle = store.getHuddle('R1');
    assert.equal(liveHuddle.status, 'unverified');
    assert.equal(store.listHuddleMembers('R1').length, 0, 'no attendance until the channel is known');

    await handlers.message({
      message: {
        subtype: 'huddle_thread',
        channel: 'Crandom',
        ts: '172000.000000',
        room: {
          id: 'R1',
          call_family: 'huddle',
          created_by: 'UOWNER',
          date_start: 172000,
          date_end: 0,
          thread_root_ts: '172000.000000',
          channels: ['Crandom'],
          participant_history: ['UOWNER'],
        },
      },
    });
    assert.equal(store.getHuddle('R1').channel_id, 'Crandom');
    assert.equal(store.getHuddle('R1').created_by, 'UOWNER');
    assert.equal(store.getHuddle('R1').thread_root_ts, '172000.000000');
    // The thread message proved the channel, so the placeholder is promoted and
    // attendance can be recorded from here on.
    assert.equal(store.getHuddle('R1').status, 'active');
    assert.equal(store.listHuddleMembers('R1').length, 1, 'the join is applied once the channel is known');

    await handlers['event:user_huddle_changed']({
      event: {
        user: {
          id: 'UOWNER',
          profile: { huddle_state: 'not_in_a_huddle', huddle_state_call_id: 'R1' },
        },
      },
    });
    await flush();

    assert.equal(store.getHuddle('R1').status, 'active', 'a leave does not end the huddle');
    assert.equal(client.chat.postMessage.mock.callCount(), 0, 'no prompt from a plain leave');

    await handlers.message({
      message: {
        subtype: 'huddle_thread',
        channel: 'Crandom',
        ts: '172100.000000',
        room: {
          id: 'R1',
          call_family: 'huddle',
          created_by: 'UOWNER',
          date_start: 172000,
          date_end: 172100,
          thread_root_ts: '172000.000000',
          channels: ['Crandom'],
          participant_history: ['UOWNER'],
        },
      },
    });
    await flush();
    assert.equal(store.getHuddle('R1').status, 'ended', 'the closing huddle_thread message ends it');
    const prompt = buttonPosts(client, 'generate_huddle_review')[0];
    assert.ok(prompt, 'the review prompt went out');
    assert.equal(prompt.channel, 'Crandom');
    assert.equal(prompt.thread_ts, '172000.000000');
    assert(prompt.blocks.some((block) => block.type === 'actions'));
    assert.equal(prompt.blocks.find((block) => block.type === 'actions').elements[0].value, 'R1');

    await handlers.message({
      message: {
        subtype: 'huddle_thread',
        channel: 'Crandom',
        ts: '172100.000000',
        room: {
          id: 'R1',
          call_family: 'huddle',
          created_by: 'UOWNER',
          date_start: 172000,
          date_end: 172100,
          thread_root_ts: '172000.000000',
          channels: ['Crandom'],
          participant_history: ['UOWNER'],
        },
      },
    });
    await flush();
    assert.equal(countButtonPosts(client, 'generate_huddle_review'), 1, 'no duplicate prompts');

    store.upsertHuddle({
      callId: 'R9',
      channelId: 'Creview',
      channelName: 'reviews',
      createdBy: 'UOWNER',
      startedAt: 1000,
      endedAt: 1300,
      threadRootTs: '1000.000000',
      participantHistory: ['UOWNER', 'U9'],
    });
    store.upsertHuddleMember({ callId: 'R9', userId: 'UOWNER', firstSeenAt: 1000, lastSeenAt: 1300, isIn: false });
    store.upsertHuddleMember({ callId: 'R9', userId: 'U9', firstSeenAt: 1100, lastSeenAt: 1200, isIn: false });

    await handlers['action:generate_huddle_review']({
      ack: mock.fn(),
      body: {
        user: { id: 'UOWNER' },
        actions: [{ value: 'R9' }],
      },
      client,
    });
    await flush();

    const review = client.chat.postMessage.mock.calls
      .map((call) => call.arguments[0])
      .filter((arg) => arg.channel === 'Creview')
      .at(-1);
    assert.ok(review, 'the review went to the channel');
    assert.equal(review.thread_ts, '1000.000000');
    assert.equal(review.thread_ts, '1000.000000');
    assert(review.text.includes('Huddle review'));
    assert(review.text.includes('#reviews'));
    // Named, not mentioned: reading the review must not notify everyone on the call.
    assert(review.text.includes('name-UOWNER — 5m *— longest in the huddle*'));
    assert(review.text.includes('name-U9 — 1m 40s'));
    assert.equal(review.text.match(/<@[A-Z0-9]+>/g), null, 'the review mentions nobody');
    assert(review.text.includes('No huddle chat messages were recorded.'));

    tracker.stop();
  });

  it('lets any member generate a review, not just a channel owner', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    // restrict_triggers is on and the owner list is empty, which used to mean
    // "nobody may ask". It now means the button is not owner-gated at all.
    store.setHuddleChannelFlag('Crandom', 'restrict_triggers', 1);
    const { handlers, tracker } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    store.upsertHuddle({
      callId: 'Rshared',
      channelId: 'Crandom',
      channelName: 'random',
      createdBy: 'UOWNER',
      startedAt: 1000,
      endedAt: 1300,
      threadRootTs: '1000.000000',
      participantHistory: ['UOWNER', 'U9'],
    });
    for (const [userId, seen] of [
      ['UOWNER', 1000],
      ['U9', 1100],
    ]) {
      store.upsertHuddleMember({
        callId: 'Rshared',
        userId,
        firstSeenAt: seen,
        lastSeenAt: 1300,
        isIn: false,
      });
    }

    await handlers['action:generate_huddle_review']({
      ack: mock.fn(),
      body: { user: { id: 'U9' }, actions: [{ value: 'Rshared' }] },
      client,
    });
    await flush();

    const review = client.chat.postMessage.mock.calls
      .map((call) => call.arguments[0])
      .filter((arg) => arg.channel === 'Crandom' && (arg.text ?? '').includes('Huddle review'));
    assert.equal(review.length, 1, 'a non-owner got their review');
    const denied = store.listTriggerLog().filter((row) => row.action === 'huddle_review_denied');
    assert.equal(denied.length, 0, 'and was not denied for not owning the channel');

    tracker.stop();
  });

  it('still refuses a review for a channel the bot is not in', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createTrackerHarness({
      store,
      client,
      ownerId: 'UOWNER',
      botChannelIds: ['Crandom'],
    });

    store.upsertHuddle({
      callId: 'Rout',
      channelId: 'Celsewhere',
      channelName: 'elsewhere',
      createdBy: 'UOWNER',
      startedAt: 1000,
      endedAt: 1300,
      threadRootTs: '1000.000000',
      participantHistory: ['UOWNER'],
    });
    store.upsertHuddleMember({
      callId: 'Rout',
      userId: 'UOWNER',
      firstSeenAt: 1000,
      lastSeenAt: 1300,
      isIn: false,
    });

    await handlers['action:generate_huddle_review']({
      ack: mock.fn(),
      body: { user: { id: 'UOWNER' }, actions: [{ value: 'Rout' }] },
      client,
    });
    await flush();

    const leaked = client.chat.postMessage.mock.calls
      .map((call) => call.arguments[0])
      .filter((arg) => (arg.text ?? '').includes('Huddle review'));
    assert.equal(leaked.length, 0, 'no stats from a channel we are not in');
    const denied = store.listTriggerLog().filter((row) => row.action === 'huddle_review_denied');
    assert.equal(denied.length, 1, 'and it was recorded as denied');

    tracker.stop();
  });

  it('posts the huddle link when a huddle starts and a summary when it ends', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    await handlers.message({
      message: {
        subtype: 'huddle_thread',
        channel: 'Crandom',
        ts: '172000.000000',
        room: {
          id: 'Rlink',
          call_family: 'huddle',
          created_by: 'UOWNER',
          date_start: 172000,
          date_end: 0,
          thread_root_ts: '172000.000000',
          channels: ['Crandom'],
          participant_history: ['UOWNER', 'U9'],
        },
      },
    });
    await handlers['event:user_huddle_changed']({
      event: {
        user: {
          id: 'UOWNER',
          profile: { huddle_state: 'in_a_huddle', huddle_state_call_id: 'Rlink' },
        },
      },
    });
    await handlers['event:user_huddle_changed']({
      event: {
        user: {
          id: 'U9',
          profile: { huddle_state: 'in_a_huddle', huddle_state_call_id: 'Rlink' },
        },
      },
    });
    await flush();

    const started = textsPosted(client).find((text) => text.includes('Huddle started'));
    assert.ok(started, 'the start notice went out');
    assert(
      started.includes('https://asteria.test/Rlink'),
      'and it links to the huddle page, not to some guessed host',
    );

    await handlers.message({
      message: {
        subtype: 'huddle_thread',
        channel: 'Crandom',
        ts: '172100.000000',
        room: {
          id: 'Rlink',
          call_family: 'huddle',
          created_by: 'UOWNER',
          date_start: 172000,
          date_end: 172100,
          thread_root_ts: '172000.000000',
          channels: ['Crandom'],
          participant_history: ['UOWNER', 'U9'],
        },
      },
    });
    await flush();

    const summary = textsPosted(client).find((text) => text.startsWith('! '));
    assert.ok(summary, 'a one-line summary went out at the end');
    assert(summary.includes('awarded for the 1 min huddle'), 'it states how long it was');
    assert(summary.includes('started by name-UOWNER'), 'who started it, by name not mention');
    assert(!summary.includes('<@'), 'and it pings nobody');
    assert(summary.includes('https://asteria.test/Rlink'), 'with the link');

    tracker.stop();
  });

  it('summarises without asking when the channel is condensed', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    store.setHuddleChannelFlag('Crandom', 'condensed_review', 1);
    const { handlers, tracker } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    store.upsertHuddle({
      callId: 'Rcond',
      channelId: 'Crandom',
      channelName: 'random',
      createdBy: 'UOWNER',
      startedAt: 1000,
      endedAt: 1300,
      threadRootTs: '1000.000000',
      participantHistory: ['UOWNER'],
    });
    store.upsertHuddleMember({
      callId: 'Rcond',
      userId: 'UOWNER',
      firstSeenAt: 1000,
      lastSeenAt: 1300,
      isIn: false,
    });

    await handlers.message({
      message: {
        subtype: 'huddle_thread',
        channel: 'Crandom',
        ts: '1000.000000',
        room: {
          id: 'Rcond',
          call_family: 'huddle',
          created_by: 'UOWNER',
          date_start: 1000,
          date_end: 1300,
          thread_root_ts: '1000.000000',
          channels: ['Crandom'],
          participant_history: ['UOWNER'],
        },
      },
    });
    await flush();

    assert.equal(countButtonPosts(client, 'generate_huddle_review'), 0, 'condensed: no review button at all');
    const summary = textsPosted(client).find((text) => text.startsWith('! '));
    assert.ok(summary, 'condensed still posts the summary and the link');
    assert(summary.includes('https://asteria.test/Rcond'));

    tracker.stop();
  });

  it('posts no link or summary when there is no public host configured', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    // A missing PUBLIC_URL must not be guessed into a link that 404s in public.
    const { handlers, tracker } = createTrackerHarness({
      store,
      client,
      ownerId: 'UOWNER',
      baseUrl: '',
    });

    store.upsertHuddle({
      callId: 'Rnourl',
      channelId: 'Crandom',
      channelName: 'random',
      createdBy: 'UOWNER',
      startedAt: 1000,
      endedAt: 1300,
      threadRootTs: '1000.000000',
      participantHistory: ['UOWNER'],
    });
    store.upsertHuddleMember({
      callId: 'Rnourl',
      userId: 'UOWNER',
      firstSeenAt: 1000,
      lastSeenAt: 1300,
      isIn: false,
    });
    await handlers.message({
      message: {
        subtype: 'huddle_thread',
        channel: 'Crandom',
        ts: '1000.000000',
        room: {
          id: 'Rnourl',
          call_family: 'huddle',
          created_by: 'UOWNER',
          date_start: 1000,
          date_end: 1300,
          thread_root_ts: '1000.000000',
          channels: ['Crandom'],
          participant_history: ['UOWNER'],
        },
      },
    });
    await flush();

    const texts = textsPosted(client);
    assert(!texts.some((text) => text.includes('Huddle started')), 'no start link without a host');
    assert(!texts.some((text) => text.includes('/huddle/')), 'and no link anywhere');
    assert(
      texts.some((text) => text.startsWith('! ') && text.includes('awarded for')),
      'but the summary still states the total',
    );

    tracker.stop();
  });

  it('answers a stale review button ephemerally instead of DMing', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    client.chat.postEphemeral = mock.fn(async () => ({ ts: '1.1' }));
    const { handlers, tracker } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    await handlers['action:generate_huddle_review']({
      ack: mock.fn(),
      body: {
        user: { id: 'U9' },
        container: { channel_id: 'Cpress' },
        actions: [{ value: 'Rmissing' }],
      },
      client,
    });
    await flush();

    assert.deepEqual(
      client.chat.postMessage.mock.calls.map((c) => ({
        channel: c.arguments[0].channel,
        ts: c.arguments[0].thread_ts,
      })),
      [],
      'no post at all: there is no thread to ask in and we never fall back to the channel',
    );
    assert.equal(client.conversations.open.mock.callCount(), 0, 'and no DM');
    assert.equal(client.chat.postEphemeral.mock.callCount(), 1);
    assert.deepEqual(client.chat.postEphemeral.mock.calls[0].arguments[0], {
      channel: 'Cpress',
      user: 'U9',
      text: 'Sorry, I could not find that huddle anymore.',
    });

    tracker.stop();
  });

  it('never DMs anybody when there is no thread to ask in', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    await handlers['event:user_huddle_changed']({
      event: {
        user: {
          id: 'U5',
          profile: { huddle_state: 'in_a_huddle', huddle_state_call_id: 'R2' },
        },
      },
    });
    await handlers.message({
      message: {
        subtype: 'huddle_thread',
        // A real channel, so the huddle is ours to track, but no thread_root_ts,
        // which is the case under test: there is nowhere to ask in.
        channel: 'Cquiet',
        ts: '172800.000000',
        room: {
          id: 'R2',
          call_family: 'huddle',
          created_by: '',
          date_start: 172000,
          date_end: 172800,
          thread_root_ts: '',
          channels: ['Cquiet'],
          participant_history: ['U5'],
        },
      },
    });
    await flush();

    assert.deepEqual(
      client.chat.postMessage.mock.calls.map((c) => ({
        channel: c.arguments[0].channel,
        ts: c.arguments[0].thread_ts,
      })),
      [],
      'no post at all: there is no thread to ask in and we never fall back to the channel',
    );
    assert.equal(client.conversations.open.mock.callCount(), 0, 'and no DM');
    const skipped = store.listTriggerLog(50).filter((row) => row.action === 'huddle_review_prompt_skipped');
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].user_id, 'U5');

    tracker.stop();
  });

  it('records the skipped prompt when the thread prompt cannot be posted', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    await handlers['event:user_huddle_changed']({
      event: {
        user: {
          id: 'U5',
          profile: { huddle_state: 'in_a_huddle', huddle_state_call_id: 'R2' },
        },
      },
    });
    await handlers.message({
      message: {
        subtype: 'huddle_thread',
        // A real channel, so the huddle is ours to track, but no thread_root_ts,
        // which is the case under test: there is nowhere to ask in.
        channel: 'Cquiet',
        ts: '172800.000000',
        room: {
          id: 'R2',
          call_family: 'huddle',
          created_by: '',
          date_start: 172000,
          date_end: 172800,
          thread_root_ts: '',
          channels: ['Cquiet'],
          participant_history: ['U5'],
        },
      },
    });
    await flush();

    assert.equal(client.chat.postMessage.mock.callCount(), 0);
    assert.equal(client.chat.postMessage.mock.calls.length, 0);

    tracker.stop();
  });

  it('records the skipped prompt when the thread prompt cannot be posted', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    // Fail only the review prompt. Throwing on "the first post" used to work
    // and silently changed meaning the moment another post was added to the
    // thread, because it then failed the wrong message.
    client.chat.postMessage = mock.fn(async (arg) => {
      const carriesPrompt = (arg.blocks ?? []).some((block) =>
        (block.elements ?? []).some((element) => element.action_id === 'generate_huddle_review'),
      );
      if (carriesPrompt) {
        throw new Error('cannot reply to a huddle thread');
      }
      return { ts: '111.222' };
    });
    const { handlers, tracker } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    await handlers['event:user_huddle_changed']({
      event: {
        user: {
          id: 'UOWNER',
          profile: { huddle_state: 'in_a_huddle', huddle_state_call_id: 'R3' },
        },
      },
    });
    await handlers.message({
      message: {
        subtype: 'huddle_thread',
        channel: 'Cthr',
        ts: '173000.000000',
        room: {
          id: 'R3',
          call_family: 'huddle',
          created_by: 'UOWNER',
          date_start: 173000,
          date_end: 0,
          thread_root_ts: '173000.000000',
          channels: ['Cthr'],
          participant_history: ['UOWNER'],
        },
      },
    });
    await handlers['event:user_huddle_changed']({
      event: {
        user: {
          id: 'UOWNER',
          profile: { huddle_state: 'in_a_huddle', huddle_state_call_id: 'R3' },
        },
      },
    });
    await handlers.message({
      message: {
        subtype: 'huddle_thread',
        channel: 'Cthr',
        ts: '173500.000000',
        room: {
          id: 'R3',
          call_family: 'huddle',
          created_by: 'UOWNER',
          date_start: 173000,
          date_end: 173500,
          thread_root_ts: '173000.000000',
          channels: ['Cthr'],
          participant_history: ['UOWNER'],
        },
      },
    });
    await flush();

    const threadAttempt = buttonPosts(client, 'generate_huddle_review')[0];
    assert.ok(threadAttempt, 'it tried the thread first');
    assert.equal(threadAttempt.channel, 'Cthr');
    assert.equal(threadAttempt.thread_ts, '173000.000000');
    // The thread post failed, and the owner must not be DMed about it.
    assert.equal(client.conversations.open.mock.callCount(), 0);
    const skipped = store.listTriggerLog(50).filter((row) => row.action === 'huddle_review_prompt_skipped');
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].user_id, 'UOWNER');

    tracker.stop();
  });

  it('backfills a running huddle when the bot is added to a channel mid-huddle', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    client.conversations.history = mock.fn(async () => ({
      messages: [
        {
          subtype: 'huddle_thread',
          channel: 'Chippo',
          ts: '175000.000000',
          room: {
            id: 'Rhippo',
            call_family: 'huddle',
            created_by: 'UFRED',
            date_start: 174900,
            date_end: 0,
            thread_root_ts: '175000.000000',
            channels: ['Chippo'],
            participant_history: ['UFRED'],
          },
        },
      ],
    }));
    const { handlers, tracker } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    await handlers['event:member_joined_channel']({ event: { user: 'BOTUSER', channel: 'Chippo' }, client });
    await flush();

    assert.equal(client.conversations.history.mock.callCount(), 1);
    assert.deepEqual(client.conversations.history.mock.calls[0].arguments[0], { channel: 'Chippo', limit: 50 });
    const huddle = store.getHuddle('Rhippo');
    assert.equal(huddle.channel_id, 'Chippo');
    assert.equal(huddle.created_by, 'UFRED');
    assert.equal(huddle.thread_root_ts, '175000.000000');
    assert.equal(huddle.status, 'active');

    tracker.stop();
  });

  it('announces tracking with an opt-out button when a new huddle appears', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    await handlers.message({
      message: {
        subtype: 'huddle_thread',
        channel: 'Crandom',
        ts: '172000.000000',
        room: {
          id: 'Rnew',
          call_family: 'huddle',
          created_by: 'UOWNER',
          date_start: 172000,
          date_end: 0,
          thread_root_ts: '172000.000000',
          channels: ['Crandom'],
          participant_history: ['UOWNER'],
        },
      },
    });
    await flush();

    const notice = buttonPosts(client, 'huddle_opt_out')[0];
    assert.ok(notice, 'the opt-out notice went out');
    assert.equal(notice.channel, 'Crandom');
    assert.equal(notice.thread_ts, '172000.000000');
    assert(notice.blocks.some((block) => block.text?.text.includes("i'm tracking your huddle for stats")));
    const noticeAction = notice.blocks.find((block) => block.type === 'actions').elements[0];
    assert.equal(noticeAction.action_id, 'huddle_opt_out');
    assert.equal(noticeAction.value, 'Rnew');

    await handlers.message({
      message: {
        subtype: 'huddle_thread',
        channel: 'Crandom',
        ts: '172100.000000',
        room: {
          id: 'Rnew',
          call_family: 'huddle',
          created_by: 'UOWNER',
          date_start: 172000,
          date_end: 172100,
          thread_root_ts: '172000.000000',
          channels: ['Crandom'],
          participant_history: ['UOWNER'],
        },
      },
    });
    await flush();

    assert.equal(
      countButtonPosts(client, 'generate_huddle_review'),
      1,
      'closing sends the review prompt exactly once, not another notice',
    );
    const closing = buttonPosts(client, 'generate_huddle_review')[0];
    assert.equal(closing.channel, 'Crandom');
    assert.equal(closing.thread_ts, '172000.000000');

    tracker.stop();
  });

  it('stops tracking a huddle when opted out, even if it ends later', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    await handlers['event:user_huddle_changed']({
      event: {
        user: {
          id: 'UOWNER',
          profile: { huddle_state: 'in_a_huddle', huddle_state_call_id: 'R5' },
        },
      },
    });
    // No thread message has named a channel yet, so the huddle is held
    // unverified rather than tracked. Opting out still works from there.
    assert.equal(store.getHuddle('R5').status, 'unverified');

    await handlers['action:huddle_opt_out']({
      ack: mock.fn(),
      body: {
        user: { id: 'UOWNER' },
        actions: [{ value: 'R5' }],
        message: { ts: '777.888' },
        container: { channel_id: 'Crandom' },
        channel: { id: 'Crandom' },
      },
      client,
    });
    await flush();

    assert.equal(store.getHuddle('R5').status, 'opted_out');
    assert.equal(client.chat.update.mock.callCount(), 1);
    assert.equal(client.chat.update.mock.calls[0].arguments[0].ts, '777.888');
    assert(
      client.chat.update.mock.calls[0].arguments[0].blocks.some((block) =>
        block.text?.text.includes('stopped tracking'),
      ),
    );

    await handlers['event:user_huddle_changed']({
      event: {
        user: {
          id: 'UOWNER',
          profile: { huddle_state: 'not_in_a_huddle', huddle_state_call_id: 'R5' },
        },
      },
    });
    await flush();

    assert.equal(client.chat.postMessage.mock.callCount(), 0, 'no review prompt for an opted-out huddle');
    assert.equal(store.getHuddle('R5').status, 'opted_out', 'a plain leave does not end an opted-out huddle');

    await handlers.message({
      message: {
        subtype: 'huddle_thread',
        channel: 'Crandom',
        ts: '172400.000000',
        room: {
          id: 'R5',
          call_family: 'huddle',
          created_by: 'UOWNER',
          date_start: 172000,
          date_end: 172400,
          thread_root_ts: '172000.000000',
          channels: ['Crandom'],
          participant_history: ['UOWNER'],
        },
      },
    });
    await flush();

    assert.equal(store.getHuddle('R5').status, 'ended', 'opted-out huddle still ends silently on the closing message');
    assert.equal(client.chat.postMessage.mock.callCount(), 0, 'still no review prompt for an opted-out huddle');

    await handlers['event:user_huddle_changed']({
      event: {
        user: {
          id: 'UOWNER',
          profile: { huddle_state: 'in_a_huddle', huddle_state_call_id: 'R5' },
        },
      },
    });
    const members = store.listHuddleMembers('R5');
    assert.equal(members.length, 1);
    assert.equal(members[0].is_in, true, 'presence still recorded while opted out, for later re-enabling');

    tracker.stop();
  });

  it('only ends when the closing huddle_thread message arrives, never on member leaves', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    for (const user of ['U1', 'U2']) {
      await handlers['event:user_huddle_changed']({
        event: { user: { id: user, profile: { huddle_state: 'in_a_huddle', huddle_state_call_id: 'Rmulti' } } },
      });
    }
    for (const user of ['U1', 'U2']) {
      await handlers['event:user_huddle_changed']({
        event: { user: { id: user, profile: { huddle_state: 'not_in_a_huddle', huddle_state_call_id: 'Rmulti' } } },
      });
    }
    await flush();

    // No channel is known yet, so nobody is attributed to the huddle: the bot
    // does not record attendance in a channel it cannot prove it is inside.
    assert.equal(store.listHuddleMembers('Rmulti').length, 0);
    assert.equal(store.listHuddleAttendance('Rmulti').length, 0, 'no attendance without a channel');
    assert.equal(store.getHuddle('Rmulti').status, 'unverified', 'held, not active');
    assert.equal(client.chat.postMessage.mock.callCount(), 0, 'no prompt from leaves');

    await handlers.message({
      message: {
        subtype: 'huddle_thread',
        channel: 'Crandom',
        ts: '172500.000000',
        room: {
          id: 'Rmulti',
          call_family: 'huddle',
          created_by: 'UOWNER',
          date_start: 172000,
          date_end: 172500,
          thread_root_ts: '172000.000000',
          channels: ['Crandom'],
          participant_history: ['U1', 'U2'],
        },
      },
    });
    await flush();

    assert.equal(store.getHuddle('Rmulti').status, 'ended', 'ends only on the closing message');
    assert.equal(countButtonPosts(client, 'generate_huddle_review'), 1, 'prompt only from the closing message');

    tracker.stop();
  });

  it('re-tracks an ended huddle via the track-again button', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    store.upsertHuddle({
      callId: 'Rold',
      channelId: 'Crandom',
      createdBy: 'UOWNER',
      startedAt: 172000,
      endedAt: 173000,
      threadRootTs: '172000.000000',
      participantHistory: ['UOWNER'],
    });
    store.setHuddleStatus('Rold', 'ended', 173000);
    assert.equal(store.getHuddle('Rold').status, 'ended');

    await handlers['action:huddle_track_again']({
      ack: mock.fn(),
      body: { user: { id: 'UOWNER' }, actions: [{ value: 'Rold' }] },
      client,
    });
    await flush();

    const revived = store.getHuddle('Rold');
    assert.equal(revived.status, 'active');
    assert.equal(revived.ended_at, null);

    tracker.stop();
  });

  it('never roasts somebody about a huddle they are not in', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    // Somebody else's huddle, in another channel, started long ago. It is still
    // marked active, which is what used to leak into unrelated replies.
    store.upsertHuddle({
      callId: 'Rother',
      channelId: 'Celsewhere',
      createdBy: 'USOMEONEELSE',
      startedAt: Math.floor(Date.now() / 1000) - 4 * 3600,
      endedAt: null,
      threadRootTs: '999000.000000',
      participantHistory: ['USOMEONEELSE'],
    });
    store.setUserHuddleState({ userId: 'USOMEONEELSE', callId: 'Rother', isIn: true });

    // UOWNER pings the bot in an ordinary channel, not a thread, not in a huddle.
    await handlers.message({
      message: {
        type: 'message',
        channel: 'Cquiet',
        user: 'UOWNER',
        text: 'hey <@BOTUSER> how are you',
      },
    });
    await flush();

    assert.equal(client.chat.postMessage.mock.callCount(), 1);
    const reply = JSON.stringify(client.chat.postMessage.mock.calls[0].arguments[0]);
    assert(!/4h|3h|\d+h\b/.test(reply), `no borrowed duration: ${reply}`);
    assert(!/huddling for|still in your|huddle and counting/i.test(reply), `no roast: ${reply}`);
    assert.equal(store.getUserHuddleState('UOWNER').is_in, 0, 'UOWNER is not in a huddle');

    tracker.stop();
  });

  it('roasts the pinger about their own huddle', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    store.upsertHuddle({
      callId: 'Rmine',
      channelId: 'Cmine',
      createdBy: 'UOWNER',
      startedAt: Math.floor(Date.now() / 1000) - 3 * 3600,
      endedAt: null,
      threadRootTs: '',
      participantHistory: ['UOWNER'],
    });
    store.setUserHuddleState({ userId: 'UOWNER', callId: 'Rmine', isIn: true });

    // The reply mixes four roasts with a pile of 6/7 jokes, so ask a few times
    // and require that any duration offered is the pinger's own.
    for (let i = 0; i < 30; i += 1) {
      await handlers.message({
        message: { type: 'message', channel: 'Cmine', user: 'UOWNER', text: '<@BOTUSER> hi' },
      });
    }
    await flush();

    const replies = client.chat.postMessage.mock.calls.map((call) => String(call.arguments[0].text));
    assert.equal(replies.length, 30);
    assert(
      replies.some((text) => /3h/.test(text)),
      'their own duration is fair game',
    );
    for (const text of replies) {
      const duration = text.match(/(\d+h)/);
      assert(!duration || duration[1] === '3h', `no foreign duration: ${text}`);
    }

    tracker.stop();
  });

  it('does not offer a track again button that tracking rules would decline', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    // Tracking turned off for this channel, and the pinger is not an owner.
    store.upsertHuddleChannel({ channelId: 'Cquiet', enabled: false, ownerIds: ['USOMEONEELSE'] });
    store.upsertHuddle({
      callId: 'Ropt',
      channelId: 'Cquiet',
      createdBy: 'UOWNER',
      startedAt: 172000,
      endedAt: 172600,
      threadRootTs: '172000.000000',
      participantHistory: ['UOWNER'],
    });
    store.setHuddleStatus('Ropt', 'opted_out', 172600);

    await handlers.message({
      message: {
        type: 'message',
        channel: 'Cquiet',
        user: 'UOWNER',
        thread_ts: '172000.000000',
        text: '<@BOTUSER> track this one again?',
      },
    });
    await flush();

    const reply = JSON.stringify(client.chat.postMessage.mock.calls[0].arguments[0]);
    assert(!reply.includes('huddle_track_again'), 'no dead button is advertised');
    assert(!reply.includes('"type":"actions"'), 'no action block at all');
    assert(/turned off|paused/.test(reply), `it says why: ${reply}`);

    tracker.stop();
  });

  it('replies playfully to a bot mention in a tracked huddle thread', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    store.upsertHuddle({
      callId: 'Ract',
      channelId: 'Crandom',
      createdBy: 'UOWNER',
      startedAt: 172000,
      endedAt: null,
      threadRootTs: '172000.000000',
      participantHistory: ['UOWNER'],
    });

    await handlers.message({
      message: {
        type: 'message',
        subtype: undefined,
        channel: 'Crandom',
        user: 'UOWNER',
        thread_ts: '172000.000000',
        text: 'hey <@BOTUSER> watch this huddle for me?',
      },
    });
    await flush();

    assert.equal(client.chat.postMessage.mock.callCount(), 1);
    const reply = client.chat.postMessage.mock.calls[0].arguments[0];
    assert(!reply.text.includes('\n\n'), 'single punchline, not a stack');
    assert(/7|huddle|clanker|freddie/.test(reply.text), 'silly content present');

    tracker.stop();
  });

  it('offers to track again when mentioned in an opted-out huddle thread', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    store.upsertHuddle({
      callId: 'Ropt',
      channelId: 'Crandom',
      createdBy: 'UOWNER',
      startedAt: 172000,
      endedAt: null,
      threadRootTs: '172000.000000',
      participantHistory: ['UOWNER'],
    });
    store.setHuddleOptedOut('Ropt');

    await handlers.message({
      message: {
        type: 'message',
        channel: 'Crandom',
        user: 'UOWNER',
        thread_ts: '172000.000000',
        text: 'hmm okay <@BOTUSER> can you track now?',
      },
    });
    await flush();

    assert.equal(client.chat.postMessage.mock.callCount(), 1);
    const offer = client.chat.postMessage.mock.calls[0].arguments[0];
    assert(offer.text.includes('want me to track again'));
    const button = offer.blocks.find((block) => block.type === 'actions').elements[0];
    assert.equal(button.action_id, 'huddle_track_again');
    assert.equal(button.value, 'Ropt');
    assert.equal(store.getHuddle('Ropt').status, 'opted_out', 'offer alone does not re-enable');

    tracker.stop();
  });

  it('re-enables tracking when the track-again button is pressed', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    store.upsertHuddle({
      callId: 'Ropt',
      channelId: 'Crandom',
      createdBy: 'UOWNER',
      startedAt: 172000,
      endedAt: null,
      threadRootTs: '172000.000000',
      participantHistory: ['UOWNER'],
    });
    store.setHuddleOptedOut('Ropt');

    await handlers['action:huddle_track_again']({
      ack: mock.fn(),
      body: {
        user: { id: 'UOWNER' },
        actions: [{ value: 'Ropt' }],
        message: { ts: '172000.000000', thread_ts: '172000.000000' },
        container: { channel_id: 'Crandom' },
        channel: { id: 'Crandom' },
      },
      client,
    });
    await flush();

    assert.equal(store.getHuddle('Ropt').status, 'active');
    assert.equal(client.chat.postMessage.mock.callCount(), 0, 'confirmation replaces the button message');
    const confirmation = client.chat.update.mock.calls[0];
    assert(confirmation, 'confirmation sent via chat.update');
    assert.equal(confirmation.arguments[0].ts, '172000.000000');
    assert(confirmation.arguments[0].text.includes('thanks <@UOWNER>'), 'thanks the clicker by name');
    assert(confirmation.arguments[0].text.includes('tracking again'));
    assert(
      store.listTriggerLog().some((entry) => entry.action === 'huddle_track_again' && entry.user_id === 'UOWNER'),
      'logs the track-again trigger',
    );

    tracker.stop();
  });

  it('tells you the huddle is over when mentioned in an ended huddle thread', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    store.upsertHuddle({
      callId: 'Rend',
      channelId: 'Crandom',
      createdBy: 'UOWNER',
      startedAt: 172000,
      endedAt: 173000,
      threadRootTs: '172000.000000',
      participantHistory: ['UOWNER'],
    });
    store.setHuddleStatus('Rend', 'ended', 173000);

    await handlers.message({
      message: {
        type: 'message',
        channel: 'Crandom',
        user: 'UOWNER',
        thread_ts: '172000.000000',
        text: '<@BOTUSER> is this over?',
      },
    });
    await flush();

    assert.equal(client.chat.postMessage.mock.callCount(), 1);
    assert(client.chat.postMessage.mock.calls[0].arguments[0].text.includes('already over'));

    tracker.stop();
  });

  it('goads with jokes when mentioned in an unknown thread', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    await handlers.message({
      message: {
        type: 'message',
        channel: 'Crandom',
        user: 'UOWNER',
        thread_ts: '999999.000000',
        text: '<@BOTUSER> hi are you here?',
      },
    });
    await flush();

    assert.equal(client.chat.postMessage.mock.callCount(), 1);
    const reply = client.chat.postMessage.mock.calls[0].arguments[0];
    assert.equal(reply.thread_ts, '999999.000000');
    assert(!reply.text.includes('\n\n'), 'single punchline');
    assert(/7|clanker|freddie/.test(reply.text), 'silly content present');

    tracker.stop();
  });

  it('jokes rather than shames when mentioned in a normal channel', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    store.upsertHuddle({
      callId: 'Ract2',
      channelId: 'Chuddle',
      createdBy: 'UOWNER',
      startedAt: 172000,
      endedAt: null,
      threadRootTs: '172000.000000',
      participantHistory: ['UOWNER'],
    });

    await handlers.message({
      message: {
        type: 'message',
        channel: 'Crandom',
        user: 'UOWNER',
        text: '<@BOTUSER> are you tracking?',
      },
    });
    await flush();

    assert.equal(client.chat.postMessage.mock.callCount(), 1);
    const reply = client.chat.postMessage.mock.calls[0].arguments[0];
    assert.equal(reply.channel, 'Crandom');
    assert.equal(reply.thread_ts, undefined, 'no thread_ts for channel message');
    assert(!reply.text.includes('\n\n'), 'single punchline');
    assert(/7|huddle|clanker|freddie/.test(reply.text), 'silly content present');
    // The pinger is not a participant, so there is no duration to throw at them.
    assert(!/huddling for|still in your|huddle and counting/i.test(reply.text), 'no roast for a bystander');

    tracker.stop();
  });

  it('ignores messages that do not mention the bot', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    await handlers.message({
      message: {
        type: 'message',
        channel: 'Crandom',
        user: 'UOWNER',
        thread_ts: '999999.000000',
        text: 'hello everyone',
      },
    });
    await flush();

    assert.equal(client.chat.postMessage.mock.callCount(), 0);

    tracker.stop();
  });

  it('refuses to re-track when Slack says the huddle is over', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    client.conversations.replies = mock.fn(async () => ({
      messages: [{ room: { id: 'Rend', date_end: 200000 } }],
    }));
    const { handlers, tracker } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    store.upsertHuddle({
      callId: 'Rend',
      channelId: 'Crandom',
      createdBy: 'UOWNER',
      startedAt: 172000,
      endedAt: 200000,
      threadRootTs: '172000.000000',
      participantHistory: ['UOWNER'],
    });
    store.setHuddleStatus('Rend', 'ended', 200000);

    await handlers['action:huddle_track_again']({
      ack: mock.fn(),
      body: {
        user: { id: 'UOWNER' },
        actions: [{ value: 'Rend' }],
        message: { ts: '172100.000000', thread_ts: '172100.000000' },
        container: { channel_id: 'Crandom' },
        channel: { id: 'Crandom' },
      },
      client,
    });
    await flush();

    assert.equal(store.getHuddle('Rend').status, 'ended', 'does not re-activate a truly over huddle');
    const denial = client.chat.update.mock.calls[0];
    assert(denial, 'replaces the button message');
    assert(denial.arguments[0].text.includes('already over'));
    assert(
      store.listTriggerLog().some((entry) => entry.action === 'huddle_track_again_denied'),
      'logs the denial',
    );

    tracker.stop();
  });

  it('replaces its previous reply in a thread when mentioned again', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    store.upsertHuddle({
      callId: 'Rrep',
      channelId: 'Crandom',
      createdBy: 'UOWNER',
      startedAt: 172000,
      endedAt: null,
      threadRootTs: '172000.000000',
      participantHistory: ['UOWNER'],
    });

    const mention = async () =>
      await handlers.message({
        message: {
          type: 'message',
          channel: 'Crandom',
          user: 'UOWNER',
          thread_ts: '172000.000000',
          text: '<@BOTUSER> hey watch me',
        },
      });

    await mention();
    await flush();
    assert.equal(client.chat.postMessage.mock.callCount(), 1, 'first reply posts fresh');
    const firstTs = store.getHuddle('Rrep').last_reply_ts;
    assert(firstTs, 'persists the reply ts');

    await mention();
    await flush();
    assert.equal(client.chat.postMessage.mock.callCount(), 1, 'no second stacking reply');
    const replacement = client.chat.update.mock.calls[0];
    assert(replacement, 'updates the previous reply instead');
    assert.equal(replacement.arguments[0].channel, 'Crandom');
    assert.equal(replacement.arguments[0].ts, firstTs);

    tracker.stop();
  });

  it('awards leaderboard points when a tracked huddle ends', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    await handlers['event:user_huddle_changed']({
      event: { user: { id: 'UOWNER', profile: { huddle_state: 'in_a_huddle', huddle_state_call_id: 'Rp' } } },
    });
    await handlers['event:user_huddle_changed']({
      event: { user: { id: 'U9', profile: { huddle_state: 'in_a_huddle', huddle_state_call_id: 'Rp' } } },
    });
    await handlers.message({
      message: {
        subtype: 'huddle_thread',
        channel: 'Crandom',
        ts: '180000.000000',
        room: {
          id: 'Rp',
          call_family: 'huddle',
          created_by: 'UOWNER',
          date_start: 172000,
          date_end: 180000,
          thread_root_ts: '172000.000000',
          channels: ['Crandom'],
          participant_history: ['UOWNER', 'U9'],
        },
      },
    });
    await flush();

    assert.equal(store.getHuddle('Rp').status, 'ended');
    const leaderboard = store.listHuddleLeaderboard();
    const ownerRow = leaderboard.find((row) => row.user_id === 'UOWNER');
    assert(ownerRow, 'the starter appears on the leaderboard');
    assert(ownerRow.points >= 5, 'at least the starter bonus');
    assert(
      store.listHuddleLeaderboard(50, ['Crandom']).some((row) => row.user_id === 'UOWNER'),
      'the award is attributed to the channel it happened in',
    );
    assert.deepEqual(store.listHuddleLeaderboard(50, ['Cbot']), [], 'and is not attributed to any other channel');
    assert(
      store.listTriggerLog().some((entry) => entry.action === 'huddle_join'),
      'logs joins',
    );

    tracker.stop();
  });

  it('never awards leaderboard points for a channel the bot is not in', async () => {
    const store = await createTestStore();
    const { handlers, tracker } = createTrackerHarness({
      store,
      client: createBasicClient(),
      ownerId: 'UOWNER',
      botChannelIds: ['Cbot'],
    });

    await handlers['event:user_huddle_changed']({
      event: { user: { id: 'U9', profile: { huddle_state: 'in_a_huddle', huddle_state_call_id: 'Rout' } } },
    });
    await handlers.message({
      message: {
        subtype: 'huddle_thread',
        channel: 'Celsewhere',
        ts: '180000.000000',
        room: {
          id: 'Rout',
          call_family: 'huddle',
          created_by: 'UOWNER',
          date_start: 172000,
          date_end: 180000,
          thread_root_ts: '172000.000000',
          channels: ['Celsewhere'],
          participant_history: ['UOWNER', 'U9'],
        },
      },
    });
    await flush();

    assert.deepEqual(store.listHuddleLeaderboard(), [], 'no points for a channel the bot is not in');
    assert.deepEqual(
      store.listHuddleLeaderboard(50, ['Cbot']),
      [],
      'and nothing attributed to the bot channels either',
    );

    tracker.stop();
  });

  it('counts a huddle held in a DM the bot is in', async () => {
    const store = await createTestStore();
    const botChannels = {
      list: mock.fn(async ({ includeDms } = {}) => (includeDms ? ['Cbot', 'Ddm'] : ['Cbot'])),
    };
    const { handlers, tracker } = createTrackerHarness({
      store,
      client: createBasicClient(),
      ownerId: 'UOWNER',
      botChannels,
    });

    await handlers['event:user_huddle_changed']({
      event: { user: { id: 'UOWNER', profile: { huddle_state: 'in_a_huddle', huddle_state_call_id: 'Rdm' } } },
    });
    await handlers['event:user_huddle_changed']({
      event: { user: { id: 'U9', profile: { huddle_state: 'in_a_huddle', huddle_state_call_id: 'Rdm' } } },
    });
    await handlers.message({
      message: {
        subtype: 'huddle_thread',
        channel: 'Ddm',
        ts: '180000.000000',
        room: {
          id: 'Rdm',
          call_family: 'huddle',
          created_by: 'UOWNER',
          date_start: 172000,
          date_end: 180000,
          thread_root_ts: '172000.000000',
          channels: ['Ddm'],
          participant_history: ['UOWNER', 'U9'],
        },
      },
    });
    await flush(40);

    const scoped = store.listHuddleLeaderboard(50, ['Cbot', 'Ddm']);
    assert(
      scoped.some((row) => row.user_id === 'UOWNER'),
      'a DM huddle the bot was inside still counts',
    );
    assert(store.listHuddleLeaderboard(50, ['Cbot']).length === 0, 'but it is not shown for channels the DM is not in');

    tracker.stop();
  });

  it('drops a huddle with no channel to verify instead of recording it', async () => {
    const store = await createTestStore();
    const { handlers, tracker } = createTrackerHarness({
      store,
      client: createBasicClient(),
      ownerId: 'UOWNER',
      botChannelIds: ['Cbot'],
    });

    // A huddle the bot hears about through presence events alone and then never
    // gets a channel for. The bot cannot prove it is inside, so it does not exist
    // as far as Asteria is concerned: not stored, not scored, not shown.
    await handlers['event:user_huddle_changed']({
      event: { user: { id: 'U9', profile: { huddle_state: 'in_a_huddle', huddle_state_call_id: 'Rghost' } } },
    });
    await handlers.message({
      message: {
        subtype: 'huddle_thread',
        channel: '',
        ts: '180000.000000',
        room: {
          id: 'Rghost',
          call_family: 'huddle',
          created_by: 'U9',
          date_start: 172000,
          date_end: 180000,
          thread_root_ts: '172000.000000',
          channels: [],
          participant_history: ['U9'],
        },
      },
    });
    await flush();

    // The join event could only create a placeholder, because it carries no
    // channel. It is never promoted, never scored and never shown, and the
    // placeholder sweep removes it once it is old enough to be sure.
    const ghost = store.getHuddle('Rghost');
    assert.equal(ghost.status, 'unverified', 'held as an unverified placeholder');
    assert.equal(ghost.channel_id, '', 'with no channel attached');
    assert.equal(ghost.ended_at, null, 'and never finalised');
    assert.deepEqual(store.listHuddleMembers('Rghost'), [], 'it has no members');
    assert.deepEqual(store.listHuddleAttendance('Rghost'), [], 'and no attendance');
    assert.deepEqual(store.listHuddleLeaderboard(), [], 'it never scores');
    assert.deepEqual(
      store.listHuddleLeaderboard(50, ['Cbot']),
      [],
      'and it is not attributed to a channel the bot happens to be in',
    );
    assert.equal(
      store.purgeUnverifiedHuddles(0),
      0,
      'a placeholder that was just created is too new to sweep, in case the thread message is still coming',
    );

    // A placeholder left behind long ago, which is the one that must be cleared.
    store.upsertHuddle({ callId: 'Roldghost', startedAt: 1000, status: 'unverified' });
    assert.equal(store.getHuddle('Roldghost').status, 'unverified');
    assert.equal(store.purgeUnverifiedHuddles(3600), 1, 'the sweep clears a placeholder that is long quiet');
    assert.equal(store.getHuddle('Roldghost'), null, 'and it is gone');
    assert.equal(store.getHuddle('Rghost').status, 'unverified', 'leaving the fresh one alone');

    tracker.stop();
  });

  it('answers a mention even when huddle tracking is off in that channel', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    store.upsertHuddleChannel({ channelId: 'Cquiet', name: 'quiet', enabled: false, autoReplies: true });
    store.upsertHuddle({
      callId: 'Rquiet',
      channelId: 'Cquiet',
      createdBy: 'UOWNER',
      startedAt: 172000,
      endedAt: null,
      threadRootTs: '172000.000000',
      participantHistory: ['UOWNER'],
    });

    await handlers.message({
      message: {
        type: 'message',
        channel: 'Cquiet',
        user: 'UOWNER',
        thread_ts: '172000.000000',
        text: 'hey <@BOTUSER> watch this huddle for me?',
      },
    });
    await flush();

    assert.equal(client.chat.postMessage.mock.callCount(), 1, 'the ping gets an answer');
    assert.equal(client.conversations.open.mock.callCount(), 0, 'in the channel, not by DM');

    tracker.stop();
  });

  it('explains itself by DM when replies are off, then stays quiet for an hour', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    store.upsertHuddleChannel({
      channelId: 'Cmute',
      name: 'muted',
      enabled: true,
      autoReplies: false,
      ownerIds: ['UOWNER'],
    });
    store.upsertHuddle({
      callId: 'Rmute',
      channelId: 'Cmute',
      createdBy: 'UOWNER',
      startedAt: 172000,
      endedAt: null,
      threadRootTs: '172000.000000',
      participantHistory: ['UOWNER'],
    });

    const ping = {
      message: {
        type: 'message',
        channel: 'Cmute',
        user: 'U9',
        thread_ts: '172000.000000',
        text: '<@BOTUSER> status?',
      },
    };
    await handlers.message(ping);
    await flush();

    assert.equal(
      client.chat.postMessage.mock.calls.filter((call) => call.arguments[0].channel === 'Cmute').length,
      0,
      'nothing posted in the channel',
    );
    assert.equal(client.conversations.open.mock.callCount(), 1, 'the person who pinged is told why');
    const dm = client.chat.postMessage.mock.calls[0].arguments[0];
    assert.equal(dm.channel, 'Dquiet', 'sent as a DM');
    assert(dm.text.includes('replies are turned off'));
    assert(dm.text.includes('<@UOWNER>'), 'the channel owner is named as who can fix it');
    assert(
      store.listTriggerLog().some((entry) => entry.action === 'silly_request_silent'),
      'and it shows up in the logs',
    );

    await handlers.message(ping);
    await flush();
    assert.equal(client.chat.postMessage.mock.callCount(), 1, 'a second ping is not spammed');
    assert.equal(client.conversations.open.mock.callCount(), 1, 'and no second DM is opened');

    tracker.stop();
  });

  it('filters the trigger log down to the given channels', async () => {
    const store = await createTestStore();

    store.upsertHuddle({ callId: 'Rin', channelId: 'Crandom', createdBy: 'U1', startedAt: 1000 });
    store.upsertHuddle({ callId: 'Rdm', channelId: '', createdBy: 'U2', startedAt: 2000 });

    store.recordTriggerLog({ userId: 'U1', action: 'huddle_join', detail: 'Rin' });
    store.recordTriggerLog({ userId: 'U2', action: 'huddle_join', detail: 'Rdm' });
    store.recordTriggerLog({ userId: 'U3', action: 'silly_request', detail: '172000.000000', channelId: 'Crandom' });

    const inChannel = store.listTriggerLog(50, ['Crandom']);
    assert.equal(inChannel.length, 2, 'only the rows in Crandom');
    assert(inChannel.every((entry) => entry.channel_id === 'Crandom'));
    assert(
      inChannel.some((entry) => entry.action === 'huddle_join' && entry.detail === 'Rin'),
      'a join logged before the channel was known resolves through its huddle',
    );

    assert.equal(store.listTriggerLog(50, ['Cnowhere']).length, 0, 'no rows for unrelated channels');
    assert.equal(store.listTriggerLog(50, []).length, 0, 'no channel list means no rows');
    assert.equal(store.listTriggerLog(50).length, 3, 'unfiltered reads still work');
    assert.deepEqual(store.listHuddleChannelIds(), ['Crandom']);
  });

  it('computes leaderboard points across duration, rank, prizes and starter', () => {
    // Fully closed intervals, so the ranking is earned on complete data and the
    // totals are exactly what the old clean-data calculation produced.
    const attendance = {
      partial: false,
      participants: [
        { userId: 'U1', seconds: 300, partial: false, intervals: [{ from: 1000, to: 1300 }] },
        { userId: 'U2', seconds: 250, partial: false, intervals: [{ from: 1000, to: 1250 }] },
        { userId: 'U3', seconds: 150, partial: false, intervals: [{ from: 1000, to: 1150 }] },
      ],
    };
    const awards = computeHuddlePoints({
      huddle: { call_id: 'R', started_at: 1000, ended_at: 1300, created_by: 'U1' },
      members: [
        { user_id: 'U1', first_seen_at: 1000, last_seen_at: 1300, is_in: false },
        { user_id: 'U2', first_seen_at: 1000, last_seen_at: 1250, is_in: false },
        { user_id: 'U3', first_seen_at: 1000, last_seen_at: 1150, is_in: false },
      ],
      attendance,
      participantHistory: ['U1', 'U2', 'U3'],
      messageStats: {
        longest: { userId: 'U2' },
        shortest: { userId: 'U3' },
      },
    });

    assert.equal(awards.get('U1').points, 5 + 5 + 5, '5m + rank 1 + starter');
    assert.equal(awards.get('U2').points, 4 + 3 + 10, '4m + rank 2 + longest message');
    assert.equal(awards.get('U3').points, 2 + 1 + 10, '2m + rank 3 + shortest message');
    assert(awards.get('U1').reasons.includes('started the huddle'));
  });

  it('withholds rank bonuses when attendance is only a legacy span', () => {
    // No intervals means we only have first/last seen, which cannot tell a
    // continuous stay from a rejoin, so nobody is ranked on it.
    const awards = computeHuddlePoints({
      huddle: { call_id: 'Rlegacy', started_at: 1000, ended_at: 1300, created_by: 'U1' },
      members: [
        { user_id: 'U1', first_seen_at: 1000, last_seen_at: 1300, is_in: false },
        { user_id: 'U2', first_seen_at: 1000, last_seen_at: 1250, is_in: false },
      ],
      participantHistory: ['U1', 'U2'],
    });
    assert.equal(awards.get('U1').points, 5 + 5, '5m + starter, no rank');
    assert.equal(awards.get('U2').points, 4, '4m, no rank');
  });
});

describe('huddle channel configuration', () => {
  function huddleThreadMessage({ channel, callId = 'R1', ended = false }) {
    return {
      message: {
        subtype: 'huddle_thread',
        channel,
        ts: '172000.000000',
        room: {
          id: callId,
          call_family: 'huddle',
          created_by: 'UOWNER',
          date_start: 172000,
          date_end: ended ? 172600 : 0,
          thread_root_ts: '172000.000000',
          channels: [channel],
          participant_history: ['UOWNER'],
        },
      },
    };
  }

  it('stores, reads back and flags huddle channel settings', async () => {
    const store = await createTestStore();

    store.upsertHuddleChannel({
      channelId: 'Crandom',
      name: 'random',
      enabled: true,
      autoReplies: false,
      restrictTriggers: true,
      ownerIds: ['UOWNER', 'U2'],
      pausedUntil: 1800,
    });

    const row = store.getHuddleChannel('Crandom');
    assert.equal(row.name, 'random');
    assert.equal(row.enabled, 1);
    assert.equal(row.auto_replies, 0);
    assert.equal(row.restrict_triggers, 1);
    assert.equal(row.paused_until, 1800);
    assert.deepEqual(store.getHuddleChannel('Crandom').owner_ids ? JSON.parse(row.owner_ids) : null, ['UOWNER', 'U2']);
    assert.equal(store.getHuddleChannel('Cmissing'), null);

    assert.equal(store.setHuddleChannelFlag('Crandom', 'enabled', false), true);
    assert.equal(store.getHuddleChannel('Crandom').enabled, 0);
    assert.equal(store.setHuddleChannelFlag('Crandom', 'paused_until', 0), true);
    assert.equal(store.getHuddleChannel('Crandom').paused_until, 0);
    assert.equal(store.setHuddleChannelFlag('Crandom', 'nonsense', 1), false, 'rejects unknown fields');
  });

  it('lists configured channels plus channels we have seen huddles in', async () => {
    const store = await createTestStore();

    store.upsertHuddle({ callId: 'R1', channelId: 'Cseen', channelName: 'seen', createdBy: 'U1', startedAt: 1000 });
    store.upsertHuddleChannel({ channelId: 'Cconfigured', name: 'configured', ownerIds: ['U2'] });

    const tracked = store.listTrackedHuddleChannels();
    const byId = new Map(tracked.map((row) => [row.channel_id, row]));
    assert.equal(tracked.length, 2);
    assert.equal(byId.get('Cseen').configured, false, 'implicitly tracked, not configured');
    assert.equal(byId.get('Cseen').name, 'seen');
    assert.equal(byId.get('Cseen').enabled, 1, 'defaults to tracking on');
    assert.deepEqual(byId.get('Cseen').owner_ids, []);
    assert.equal(byId.get('Cconfigured').configured, true);
    assert.deepEqual(byId.get('Cconfigured').owner_ids, ['U2']);
  });

  it('stays silent and logs why when tracking is turned off for a channel', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    store.upsertHuddleChannel({ channelId: 'Crandom', enabled: false, autoReplies: true, ownerIds: [] });

    await handlers.message(huddleThreadMessage({ channel: 'Crandom' }));
    await flush();

    const huddle = store.getHuddle('R1');
    assert.equal(huddle.status, 'opted_out', 'recorded but silenced');
    assert.equal(client.chat.postMessage.mock.callCount(), 0, 'never announces tracking in a disabled channel');
    assert(
      store
        .listTriggerLog(50, ['Crandom'])
        .some((entry) => entry.action === 'huddle_tracking_disabled' && entry.detail === 'R1'),
      'logs that tracking is off in this channel',
    );
  });

  it('treats a paused channel as opted out until it resumes', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    store.upsertHuddleChannel({
      channelId: 'Crandom',
      enabled: true,
      pausedUntil: Math.floor(Date.now() / 1000) + 3600,
    });

    await handlers.message(huddleThreadMessage({ channel: 'Crandom' }));
    await flush();

    assert.equal(store.getHuddle('R1').status, 'opted_out');
    assert.equal(client.chat.postMessage.mock.callCount(), 0);
    assert(
      store.listTriggerLog(50, ['Crandom']).some((entry) => entry.action === 'huddle_tracking_paused'),
      'logs the pause',
    );
  });

  it('never replies to mentions when auto replies are off', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    store.upsertHuddleChannel({ channelId: 'Crandom', enabled: true, autoReplies: false });
    await handlers.message(huddleThreadMessage({ channel: 'Crandom' }));
    await flush();
    const postsBefore = client.chat.postMessage.mock.callCount();

    await handlers.message({
      message: {
        type: 'message',
        text: '<@BOTUSER> hello',
        user: 'U1',
        channel: 'Crandom',
        ts: '172100.000000',
        thread_ts: '172000.000000',
      },
    });
    await flush();

    assert.equal(
      client.chat.postMessage.mock.callCount(),
      postsBefore + 1,
      'no silly reply in the channel, only the one quiet DM explaining why',
    );
    const explanation = client.chat.postMessage.mock.calls.at(-1).arguments[0];
    assert.equal(explanation.channel, 'Dquiet', 'the explanation goes to the person as a DM');
    assert(
      store.listTriggerLog(50, ['Crandom']).filter((entry) => entry.action === 'silly_request').length === 0,
      'and no silly request is logged, because no silly reply was sent',
    );
    assert(
      store.listTriggerLog(50, ['Crandom']).some((entry) => entry.action === 'silly_request_silent'),
      'the silence is logged so it is not a mystery',
    );
  });

  it('tells a non-owner why it is ignoring them, rather than staying silent', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    store.upsertHuddleChannel({
      channelId: 'Crandom',
      enabled: true,
      autoReplies: true,
      restrictTriggers: true,
      ownerIds: ['UOWNER'],
    });
    await handlers.message(huddleThreadMessage({ channel: 'Crandom' }));
    await flush();
    const postsBefore = client.chat.postMessage.mock.callCount();

    await handlers.message({
      message: {
        type: 'message',
        text: '<@BOTUSER> hello',
        user: 'UTRANSCRIPT',
        channel: 'Crandom',
        ts: '172100.000000',
        thread_ts: '172000.000000',
      },
    });
    await flush();
    // Silence here is what made it look broken. The person is told why, and only
    // the person, so the channel is not spammed and the manager is not pinged.
    const ephemeral = client.chat.postEphemeral.mock.calls.at(-1)?.arguments[0];
    assert.equal(ephemeral.user, 'UTRANSCRIPT', 'the explanation goes to whoever asked');
    assert(ephemeral.text.includes('<@UOWNER>'), 'and names who can answer instead');
    assert.equal(client.chat.postMessage.mock.callCount(), postsBefore, 'nothing is said in the channel');
    assert(
      store.listTriggerLog(50, ['Crandom']).some((entry) => entry.action === 'silly_request_denied'),
      'logs the denial',
    );

    await handlers.message({
      message: {
        type: 'message',
        text: '<@BOTUSER> hello',
        user: 'UOWNER',
        channel: 'Crandom',
        ts: '172200.000000',
        thread_ts: '172000.000000',
      },
    });
    await flush();
    assert(client.chat.postMessage.mock.callCount() > postsBefore, 'the channel owner still gets replies');
  });

  it('silences a huddle that was already running when tracking got paused', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    store.upsertHuddle({ callId: 'R1', channelId: 'Crandom', createdBy: 'UOWNER', startedAt: 172000 });
    assert.equal(store.getHuddle('R1').status, 'active');

    store.upsertHuddleChannel({ channelId: 'Crandom', pausedUntil: Math.floor(Date.now() / 1000) + 900 });
    await handlers.message(huddleThreadMessage({ channel: 'Crandom' }));
    await flush();

    assert.equal(store.getHuddle('R1').status, 'opted_out', 'no review or points for a paused huddle');
    assert.equal(client.chat.postMessage.mock.callCount(), 0, 'stays quiet');
    assert.equal(
      store.listTriggerLog(50, ['Crandom']).filter((entry) => entry.action.startsWith('huddle_tracking_')).length,
      0,
      'does not re-log the pause for a huddle we already knew about',
    );
  });

  it('denies track-again in a paused channel and says why', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    store.upsertHuddle({ callId: 'R1', channelId: 'Crandom', createdBy: 'UOWNER', startedAt: 172000 });
    store.upsertHuddleChannel({ channelId: 'Crandom', pausedUntil: Math.floor(Date.now() / 1000) + 600 });

    await handlers['action:huddle_track_again']({
      ack: async () => {},
      body: {
        user: { id: 'UOWNER' },
        actions: [{ value: 'R1' }],
        message: { ts: '172000.000000', thread_ts: '172000.000000' },
        container: { channel_id: 'Crandom' },
      },
      client,
    });
    await flush();

    const updates = client.chat.update.mock.calls.map((call) => call.arguments[0]);
    assert(
      !updates.some((update) => update.text.includes('im tracking again')),
      'never confirms that it resumed tracking',
    );
    assert(updates.at(-1)?.text.includes('tracking is paused'), 'explains the pause in-channel');
    assert(
      store
        .listTriggerLog(50, ['Crandom'])
        .some((entry) => entry.action === 'huddle_track_again_denied' && entry.detail === 'tracking paused'),
      'logs the denial with the reason',
    );
  });

  it('tells the clicker directly when Slack refuses to edit the button message', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    // Slack answers cant_update_message for a message that is too old or that
    // the bot did not post. The click still counts; only the confirmation is lost.
    client.chat.update = mock.fn(async () => {
      throw Object.assign(new Error('An API error occurred: cant_update_message'), {
        data: { error: 'cant_update_message' },
      });
    });
    const { handlers } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    store.upsertHuddle({
      callId: 'R1',
      channelId: 'Crandom',
      createdBy: 'UOWNER',
      startedAt: 172000,
      threadRootTs: '172000.000000',
      status: 'ended',
      endedAt: 172100,
    });

    await handlers['action:huddle_track_again']({
      ack: async () => {},
      body: {
        user: { id: 'UOWNER' },
        actions: [{ value: 'R1' }],
        message: { ts: '172000.000000', thread_ts: '172000.000000' },
        container: { channel_id: 'Crandom' },
      },
      client,
    });
    await flush();

    const ephemeral = client.chat.postEphemeral.mock.calls.at(-1)?.arguments[0];
    assert.equal(ephemeral.user, 'UOWNER', 'the person who clicked hears about it');
    assert(ephemeral.text.includes('tracking this huddle again'), 'and is told it worked');
    assert.equal(store.getHuddle('R1').status, 'active', 'the click was not lost');
  });
});

describe('huddle reconciliation', () => {
  // Slack drops `user_huddle_changed` leave events, so a huddle that finished
  // would sit "active" until the twelve hour stale sweep, which then recorded
  // the end as start-plus-twelve-hours. That is what put a review prompt hours
  // late and made short huddles read as 12h. The reconciler asks Slack instead.
  it('closes a huddle that went quiet, using the end time Slack reports', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const now = Math.floor(Date.now() / 1000);
    const endedAt = now - 300;
    client.conversations.replies = mock.fn(async () => ({
      messages: [{ room: { id: 'Rquiet', date_start: now - 900, date_end: endedAt } }],
    }));
    const { tracker } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    store.upsertHuddle({
      callId: 'Rquiet',
      channelId: 'Crandom',
      createdBy: 'UOWNER',
      startedAt: now - 900,
      threadRootTs: '172000.000000',
      participantHistory: ['UOWNER'],
      // Slack said nothing about it for the last fifteen minutes.
      lastSeenAt: now - 890,
    });
    store.upsertHuddleMember({
      callId: 'Rquiet',
      userId: 'UOWNER',
      firstSeenAt: now - 900,
      lastSeenAt: now - 890,
      isIn: true,
    });

    await tracker.reconcileEndedHuddles();

    const huddle = store.getHuddle('Rquiet');
    assert.equal(huddle.status, 'ended');
    assert.equal(huddle.ended_at, endedAt, 'the real end time, not start-plus-twelve-hours');
    assert(huddle.ended_at - huddle.started_at < 3600, 'a ten minute huddle does not record a twelve hour one');
    assert.equal(
      store.listHuddleMembers('Rquiet').every((member) => !member.is_in),
      true,
      'nobody is left flagged as still being in it',
    );
    assert.equal(countButtonPosts(client, 'generate_huddle_review'), 1, 'the review prompt goes out once, promptly');
  });

  it('leaves a huddle alone while people are still joining and leaving', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    client.conversations.replies = mock.fn(async () => ({ messages: [{ room: { date_end: 0 } }] }));
    const { tracker } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });
    const now = Math.floor(Date.now() / 1000);

    // Started two hours ago but somebody was in it five seconds ago, so it is
    // plainly still going. huddle_members stores epoch seconds while
    // huddles.last_seen_at is a SQLite timestamp, and reading those as the same
    // kind of value once made this huddle look two hours quiet.
    store.upsertHuddle({
      callId: 'Rbusy',
      channelId: 'Crandom',
      createdBy: 'UOWNER',
      startedAt: now - 7200,
      threadRootTs: '172000.000000',
      participantHistory: ['UOWNER'],
      lastSeenAt: now - 5,
    });
    store.upsertHuddleMember({
      callId: 'Rbusy',
      userId: 'UOWNER',
      firstSeenAt: now - 7200,
      lastSeenAt: now - 5,
      isIn: true,
    });

    await tracker.reconcileEndedHuddles();

    assert.equal(store.getHuddle('Rbusy').status, 'active', 'still running');
    assert.equal(
      client.conversations.replies.mock.callCount(),
      0,
      'a huddle with recent activity is not worth asking Slack about',
    );
  });

  it('does not end a huddle when Slack cannot be reached', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    client.conversations.replies = mock.fn(async () => {
      throw new Error('ratelimited');
    });
    const { tracker } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });
    const now = Math.floor(Date.now() / 1000);

    store.upsertHuddle({
      callId: 'Rquiet2',
      channelId: 'Crandom',
      createdBy: 'UOWNER',
      startedAt: now - 900,
      threadRootTs: '172000.000000',
      participantHistory: ['UOWNER'],
      lastSeenAt: now - 890,
    });

    await tracker.reconcileEndedHuddles();

    assert.equal(store.getHuddle('Rquiet2').status, 'active', 'a failed lookup is not an end');
    assert.equal(client.chat.postMessage.mock.callCount(), 0, 'and prompts nobody');
  });
});

it('discards a huddle with no channel once it is long quiet', async () => {
  const store = await createTestStore();
  const client = createBasicClient();
  const { tracker } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });
  const now = Math.floor(Date.now() / 1000);

  // Seen only through a user_huddle_changed event, so there is no channel to
  // prove the bot is inside it. Left alone this stayed "active" for a day and
  // counted as a running huddle the whole time. It is discarded, not finalised:
  // inventing an end time for a huddle that was never ours would be worse.
  store.upsertHuddle({ callId: 'Rorphan', startedAt: now - 7200, lastSeenAt: now - 5400 });
  store.upsertHuddleMember({
    callId: 'Rorphan',
    userId: 'UOWNER',
    firstSeenAt: now - 7200,
    lastSeenAt: now - 5400,
    isIn: true,
  });

  await tracker.reconcileEndedHuddles();

  assert.equal(store.getHuddle('Rorphan'), null, 'it is removed rather than left running or ended');
  assert.deepEqual(store.listHuddleMembers('Rorphan'), [], 'and its roster goes with it');
  assert.deepEqual(store.listHuddleLeaderboard(), [], 'and it never scored');
  assert.equal(client.conversations.replies.mock.callCount(), 0, 'there is no thread to ask Slack about');
  assert.equal(client.chat.postMessage.mock.callCount(), 0, 'and nobody is prompted');
});

it('discards a huddle with a channel but no thread once it is long quiet', async () => {
  const store = await createTestStore();
  const client = createBasicClient();
  const { tracker } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });
  const now = Math.floor(Date.now() / 1000);

  // A real channel, so this huddle is ours, but Slack never gave us a thread
  // root, so there is no thread message to tell us when it stopped.
  store.upsertHuddle({ callId: 'Rnothread', channelId: 'Crandom', startedAt: now - 7200, lastSeenAt: now - 5400 });
  store.upsertHuddleMember({
    callId: 'Rnothread',
    userId: 'UOWNER',
    firstSeenAt: now - 7200,
    lastSeenAt: now - 5400,
    isIn: true,
  });

  await tracker.reconcileEndedHuddles();

  const huddle = store.getHuddle('Rnothread');
  assert.equal(huddle.status, 'ended', 'it stops being counted as running');
  assert.equal(huddle.ended_at, now - 5400, 'closed at the last moment we saw anyone');
  assert.equal(client.conversations.replies.mock.callCount(), 0, 'there is no thread to ask Slack about');
});

it('leaves an unverifiable huddle alone while it is still recent', async () => {
  const store = await createTestStore();
  const client = createBasicClient();
  const { tracker } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });
  const now = Math.floor(Date.now() / 1000);

  store.upsertHuddle({ callId: 'Rfresh', startedAt: now - 300, lastSeenAt: now - 10 });
  store.upsertHuddleMember({
    callId: 'Rfresh',
    userId: 'UOWNER',
    firstSeenAt: now - 300,
    lastSeenAt: now - 10,
    isIn: true,
  });

  await tracker.reconcileEndedHuddles();

  assert.equal(store.getHuddle('Rfresh').status, 'active', 'ten seconds of silence is not an ending');
});
