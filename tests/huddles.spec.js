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
    auth: {
      test: mock.fn(async () => ({ user_id: 'BOTUSER', bot_id: 'BOT123' })),
    },
    chat: {
      postMessage: mock.fn(async () => ({ ts: '111.222' })),
      getPermalink: mock.fn(async (args) => ({
        permalink: `https://example.slack.com/archives/C/p${args.message_ts}`,
      })),
      update: mock.fn(async () => ({ ts: '111.222' })),
    },
    conversations: {
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

    assert.equal(store.getHuddle('R1').status, 'active', 'a leave does not end the huddle');
    assert.equal(client.chat.postMessage.mock.callCount(), 0, 'no prompt from a plain leave');

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
    assert.equal(store.getHuddle('R1').status, 'ended', 'the closing huddle_thread message ends it');
    assert.equal(client.chat.postMessage.mock.callCount(), 1);
    const prompt = client.chat.postMessage.mock.calls[0].arguments[0];
    assert.equal(prompt.channel, 'Crandom');
    assert.equal(prompt.thread_ts, '172000.000000');
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
    assert.equal(review.channel, 'Creview');
    assert.equal(review.thread_ts, '1000.000000');
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
    handlers.message({
      message: {
        subtype: 'huddle_thread',
        ts: '172800.000000',
        room: {
          id: 'R2',
          call_family: 'huddle',
          created_by: '',
          date_start: 172000,
          date_end: 172800,
          thread_root_ts: '',
          channels: [],
          participant_history: ['U5'],
        },
      },
    });
    await flush();

    assert.equal(client.chat.postMessage.mock.callCount(), 1);
    assert.equal(client.chat.postMessage.mock.calls[0].arguments[0].channel, 'U5');

    tracker.stop();
  });

  it('falls back to DMing the starter when the thread prompt cannot be posted', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    let postCount = 0;
    client.chat.postMessage = mock.fn(async () => {
      postCount += 1;
      if (postCount === 1) {
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
    handlers.message({
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
    handlers.message({
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

    assert.equal(client.chat.postMessage.mock.callCount(), 2);
    const threadAttempt = client.chat.postMessage.mock.calls[0].arguments[0];
    assert.equal(threadAttempt.channel, 'Cthr');
    assert.equal(threadAttempt.thread_ts, '173000.000000');
    const dmFallback = client.chat.postMessage.mock.calls[1].arguments[0];
    assert.equal(dmFallback.channel, 'UOWNER');
    assert.equal(dmFallback.blocks.find((block) => block.type === 'actions').elements[0].value, 'R3');

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

    handlers.message({
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

    assert.equal(client.chat.postMessage.mock.callCount(), 1);
    const notice = client.chat.postMessage.mock.calls[0].arguments[0];
    assert.equal(notice.channel, 'Crandom');
    assert.equal(notice.thread_ts, '172000.000000');
    assert(notice.blocks.some((block) => block.text?.text.includes("i'm tracking your huddle for stats")));
    const noticeAction = notice.blocks.find((block) => block.type === 'actions').elements[0];
    assert.equal(noticeAction.action_id, 'huddle_opt_out');
    assert.equal(noticeAction.value, 'Rnew');

    handlers.message({
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

    assert.equal(client.chat.postMessage.mock.callCount(), 2, 'closing sends the review prompt, not another notice');
    const closing = client.chat.postMessage.mock.calls[1].arguments[0];
    assert.equal(
      closing.blocks.find((block) => block.type === 'actions').elements[0].action_id,
      'generate_huddle_review',
    );

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
    assert.equal(store.getHuddle('R5').status, 'active');

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

    handlers.message({
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

    assert.equal(store.listHuddleMembers('Rmulti').length, 2);
    assert.equal(store.getHuddle('Rmulti').status, 'active', 'still active even after EVERY member leaves');
    assert.equal(client.chat.postMessage.mock.callCount(), 0, 'no prompt from leaves');

    handlers.message({
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
    assert.equal(client.chat.postMessage.mock.callCount(), 1, 'prompt only from the closing message');

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

    handlers.message({
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

    handlers.message({
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

    handlers.message({
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

    handlers.message({
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

  it('shames the active huddle when mentioned in a normal channel', async () => {
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

    handlers.message({
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

    tracker.stop();
  });

  it('ignores messages that do not mention the bot', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createTrackerHarness({ store, client, ownerId: 'UOWNER' });

    handlers.message({
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

    const mention = () =>
      handlers.message({
        message: {
          type: 'message',
          channel: 'Crandom',
          user: 'UOWNER',
          thread_ts: '172000.000000',
          text: '<@BOTUSER> hey watch me',
        },
      });

    mention();
    await flush();
    assert.equal(client.chat.postMessage.mock.callCount(), 1, 'first reply posts fresh');
    const firstTs = store.getHuddle('Rrep').last_reply_ts;
    assert(firstTs, 'persists the reply ts');

    mention();
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
    handlers.message({
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
      store.listTriggerLog().some((entry) => entry.action === 'huddle_join'),
      'logs joins',
    );

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
    const awards = computeHuddlePoints({
      huddle: { call_id: 'R', started_at: 1000, ended_at: 1300, created_by: 'U1' },
      members: [
        { user_id: 'U1', first_seen_at: 1000, last_seen_at: 1300, is_in: false },
        { user_id: 'U2', first_seen_at: 1000, last_seen_at: 1250, is_in: false },
        { user_id: 'U3', first_seen_at: 1000, last_seen_at: 1150, is_in: false },
      ],
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
});
