import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import { buildHuddlesView } from '../src/app-home/views.js';
import { createStore } from '../src/database/store.js';
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

function createTrackerHarness({ store, client, ownerId }) {
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
    logger: { error: mock.fn() },
    ownerId,
  });
  return { handlers, tracker };
}

function createBasicClient() {
  return {
    chat: {
      postMessage: mock.fn(async () => ({ ts: '111.222' })),
      getPermalink: mock.fn(async (args) => ({
        permalink: `https://example.slack.com/archives/C/p${args.message_ts}`,
      })),
    },
    conversations: {
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
    const message = formatHuddleReviewMessage(stats, { timezone: 'UTC' });
    assert(message.includes('Huddle review'));
    assert(message.includes('#random'));
    assert(message.includes('<@U1> — 5m'));
    assert(message.includes('<@U2> — 1m 40s'));
    assert(message.includes('longest in the huddle'));
    assert(message.includes('34 chars by <@U2>'));
    assert(message.includes('2 chars by <@U1>'));
    assert(message.includes('https://p'));
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

    const liveHuddle = store.getHuddle('R1');
    assert.equal(liveHuddle.status, 'active');
    assert.equal(store.listHuddleMembers('R1').length, 1);

    handlers.message({
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

    await handlers['event:user_huddle_changed']({
      event: {
        user: {
          id: 'UOWNER',
          profile: { huddle_state: 'not_in_a_huddle', huddle_state_call_id: 'R1' },
        },
      },
    });
    await flush();

    assert.equal(store.getHuddle('R1').status, 'ended');
    assert.equal(client.chat.postMessage.mock.callCount(), 1);
    const prompt = client.chat.postMessage.mock.calls[0].arguments[0];
    assert.equal(prompt.channel, 'UOWNER');
    assert(prompt.blocks.some((block) => block.type === 'actions'));
    assert.equal(prompt.blocks.find((block) => block.type === 'actions').elements[0].value, 'R1');

    handlers.message({
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
    assert.equal(client.chat.postMessage.mock.callCount(), 1, 'no duplicate prompts');

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

    assert.equal(client.chat.postMessage.mock.callCount(), 2);
    const review = client.chat.postMessage.mock.calls[1].arguments[0];
    assert(review.text.includes('Huddle review'));
    assert(review.text.includes('#reviews'));
    assert(review.text.includes('<@UOWNER> — 5m *— longest in the huddle*'));
    assert(review.text.includes('<@U9> — 1m 40s'));
    assert(review.text.includes('No huddle chat messages were recorded.'));

    tracker.stop();
  });

  it('prompts the first joiner when the starter is unknown and no owner is in', async () => {
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
    await handlers['event:user_huddle_changed']({
      event: {
        user: {
          id: 'U5',
          profile: { huddle_state: 'not_in_a_huddle', huddle_state_call_id: 'R2' },
        },
      },
    });
    await flush();

    assert.equal(client.chat.postMessage.mock.callCount(), 1);
    assert.equal(client.chat.postMessage.mock.calls[0].arguments[0].channel, 'U5');

    tracker.stop();
  });
});
