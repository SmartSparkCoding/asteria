import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import { createStore } from '../src/database/store.js';
import { createHuddleTracker } from '../src/huddles/tracker.js';

// These tests exist for one failure mode: the bot deciding somebody was not in a
// huddle when Slack's own roster said they were. Every case here is a way an
// appearance used to be lost or mangled.

let createdPaths = [];

afterEach(() => {
  for (const databasePath of createdPaths) {
    fs.rmSync(path.dirname(databasePath), { recursive: true, force: true });
  }
  createdPaths = [];
});

async function createTestStore() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-accuracy-'));
  const databasePath = path.join(tempDir, 'orbit.sqlite');
  createdPaths.push(databasePath);
  return createStore(databasePath);
}

const CHANNELS = ['Crandom'];
const now = () => Math.floor(Date.now() / 1000);

function createBasicClient() {
  return {
    auth: { test: mock.fn(async () => ({ user_id: 'BOTUSER', bot_id: 'BOT123' })) },
    users: {
      info: mock.fn(async ({ user }) => ({ user: { id: user, profile: { display_name: `name-${user}` } } })),
    },
    chat: {
      postMessage: mock.fn(async () => ({ ts: '111.222' })),
      getPermalink: mock.fn(async () => ({ permalink: 'https://example.slack.com/archives/C/p1' })),
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

function createHarness({ store, client, botChannels, botChannelIds = CHANNELS, bootBackfill = false }) {
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
  const logger = { error: mock.fn(), info: mock.fn(), warn: mock.fn(), debug: mock.fn() };
  const tracker = createHuddleTracker({
    app,
    store,
    client,
    logger,
    ownerId: 'UOWNER',
    botChannels: botChannels ?? { list: mock.fn(async () => botChannelIds) },
    baseUrl: 'https://orbit.test',
    bootBackfill,
  });
  return { handlers, tracker, logger };
}

function threadMessage({ id = 'R1', participants, history = participants, dateStart = now() - 600, dateEnd = 0 }) {
  return {
    message: {
      subtype: 'huddle_thread',
      channel: 'Crandom',
      ts: `${dateStart}.100000`,
      room: {
        id,
        call_family: 'huddle',
        created_by: 'UOWNER',
        date_start: dateStart,
        date_end: dateEnd,
        thread_root_ts: `${dateStart}.000000`,
        channels: ['Crandom'],
        participants,
        participant_history: history,
      },
    },
  };
}

function openIntervals(store, callId) {
  return store.listHuddleAttendance(callId).filter((row) => row.left_at === null);
}

async function flush(times = 50) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

describe('huddle attendance accuracy', () => {
  it('credits an appearance that only the roster saw', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createHarness({ store, client });

    // UMISSED never produced a presence event. Slack's roster says they are in
    // the room, and that used to become a member row with no attendance on it,
    // which is a person who was in the huddle and scored zero.
    await handlers.message(threadMessage({ id: 'Rmissed', participants: ['UOWNER', 'UMISSED'] }));

    const open = openIntervals(store, 'Rmissed');
    assert.deepEqual(open.map((row) => row.user_id).sort(), ['UMISSED', 'UOWNER']);
    assert.ok(
      open.every((row) => Number(row.inferred) === 0),
      'a roster sighting is evidence, not a guess',
    );
    assert.equal(Number(store.listHuddleMembers('Rmissed').find((member) => member.user_id === 'UMISSED').is_in), 1);
    tracker.stop();
  });

  it('closes somebody where they were last seen, not at the current time', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createHarness({ store, client });
    const openedAt = now() - 600;
    const lastSeenAt = now() - 60;

    store.upsertHuddle({
      callId: 'Rgone',
      channelId: 'Crandom',
      createdBy: 'UOWNER',
      startedAt: openedAt,
      endedAt: null,
      threadRootTs: `${openedAt}.000000`,
      participantHistory: ['U1', 'U2'],
    });
    // U1 was witnessed in the room a minute ago, then dropped out of the roster
    // because Slack never told us they left.
    store.openHuddleAttendance('Rgone', 'U1', openedAt);
    store.upsertHuddleMember({
      callId: 'Rgone',
      userId: 'U1',
      firstSeenAt: openedAt,
      lastSeenAt: lastSeenAt,
      isIn: true,
    });
    store.setUserHuddleState({ userId: 'U1', callId: 'Rgone', isIn: true });
    await handlers.message(threadMessage({ id: 'Rgone', participants: ['U2'], dateStart: openedAt }));

    const row = store.listHuddleAttendance('Rgone').find((entry) => entry.user_id === 'U1');
    assert.ok(row?.left_at, 'the interval is closed');
    assert.ok(
      Math.abs(Number(row.left_at) - lastSeenAt) <= 2,
      `closed where they were last seen (${row.left_at} vs ${lastSeenAt}), not where the poll ran`,
    );
    assert.equal(Number(store.listHuddleMembers('Rgone').find((member) => member.user_id === 'U1').is_in), 0);
    tracker.stop();
  });

  it('does not read an empty live list as everybody leaving at once', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createHarness({ store, client });
    const openedAt = now() - 600;

    await handlers.message(threadMessage({ id: 'Rempty', participants: ['U1'], dateStart: openedAt }));
    store.touchHuddleMembers('Rempty', ['U1'], now() - 30);
    await handlers.message(threadMessage({ id: 'Rempty', participants: [], dateStart: openedAt }));

    assert.equal(openIntervals(store, 'Rempty').length, 1, 'the interval is still open');
    assert.equal(Number(store.listHuddleMembers('Rempty').find((member) => member.user_id === 'U1').is_in), 1);
    tracker.stop();
  });

  it('ends a huddle as soon as Slack reports an end time', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { tracker } = createHarness({ store, client });
    const startedAt = now() - 600;
    const endedAt = now() - 120;

    store.upsertHuddle({
      callId: 'Rend',
      channelId: 'Crandom',
      createdBy: 'UOWNER',
      startedAt,
      endedAt: null,
      threadRootTs: `${startedAt}.000000`,
      participantHistory: ['U1'],
    });
    store.openHuddleAttendance('Rend', 'U1', startedAt);
    // Recent activity on purpose: this is exactly the huddle the old quiet gate
    // refused to look at, so it would have stayed open until it went quiet.
    store.touchHuddleMembers('Rend', ['U1'], now());
    client.conversations.replies = mock.fn(async () => ({
      messages: [
        {
          room: {
            id: 'Rend',
            call_family: 'huddle',
            date_start: startedAt,
            date_end: endedAt,
            participants: [],
            participant_history: ['U1'],
          },
        },
      ],
    }));

    await tracker.sampleActiveHuddles();

    const huddle = store.getHuddle('Rend');
    assert.equal(huddle.status, 'ended');
    assert.equal(Number(huddle.ended_at), endedAt, 'the end is the one Slack reported');
    tracker.stop();
  });

  it('retries a rate limited channel lookup instead of dropping the huddle', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    let calls = 0;
    const botChannels = {
      list: mock.fn(async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('ratelimited');
        }
        return CHANNELS;
      }),
    };
    const { handlers, tracker } = createHarness({ store, client, botChannels });

    await handlers.message(threadMessage({ id: 'Rretry', participants: ['U1'] }));

    assert.equal(store.getHuddle('Rretry')?.channel_id, 'Crandom', 'the huddle is kept, not thrown away');
    tracker.stop();
  });

  it('applies two presence events for the same person in the order Slack sent them', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createHarness({ store, client });

    await handlers.message(threadMessage({ id: 'Rord', participants: ['UOWNER'] }));

    // Both fired without awaiting, the way Slack delivers a burst. The leave
    // reads state the join has written, so it can see the interval it closes.
    const join = handlers['event:user_huddle_changed']({
      event: { user: { id: 'U1', profile: { huddle_state: 'in_a_huddle', huddle_state_call_id: 'Rord' } } },
    });
    const leave = handlers['event:user_huddle_changed']({
      event: { user: { id: 'U1', profile: { huddle_state: 'not_in_a_huddle', huddle_state_call_id: 'Rord' } } },
    });
    await Promise.all([join, leave]);
    await flush();

    assert.equal(Number(store.getUserHuddleState('U1')?.is_in ?? 0), 0, 'the leave won');
    assert.deepEqual(
      openIntervals(store, 'Rord').filter((row) => row.user_id === 'U1'),
      [],
      'no interval is left dangling',
    );
    tracker.stop();
  });

  it('records a huddle found during the startup catch-up without announcing it', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const startedAt = now() - 1800;
    client.conversations.history = mock.fn(async () => ({
      messages: [
        {
          subtype: 'huddle_thread',
          channel: 'Crandom',
          ts: `${startedAt}.100000`,
          room: {
            id: 'Rback',
            call_family: 'huddle',
            created_by: 'U1',
            date_start: startedAt,
            date_end: 0,
            thread_root_ts: `${startedAt}.000000`,
            channels: ['Crandom'],
            participants: ['U1'],
            participant_history: ['U1'],
          },
        },
      ],
    }));
    const { tracker } = createHarness({ store, client, bootBackfill: true });
    await flush();

    assert.equal(store.getHuddle('Rback')?.status, 'active', 'the running huddle is picked up');
    assert.deepEqual(
      openIntervals(store, 'Rback').map((row) => row.user_id),
      ['U1'],
      'and the people in it are credited from now on',
    );
    assert.equal(client.chat.postMessage.mock.callCount(), 0, 'without announcing a huddle that already started');
    tracker.stop();
  });
});
