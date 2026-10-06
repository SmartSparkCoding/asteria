import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import { createStore } from '../src/database/store.js';
import { createHuddleTracker } from '../src/huddles/tracker.js';

let createdPaths = [];

afterEach(() => {
  for (const databasePath of createdPaths) {
    fs.rmSync(path.dirname(databasePath), { recursive: true, force: true });
  }
  createdPaths = [];
});

async function createTestStore() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-golf-'));
  const databasePath = path.join(tempDir, 'asteria.sqlite');
  createdPaths.push(databasePath);
  return createStore(databasePath);
}

function createBasicClient() {
  return {
    auth: { test: mock.fn(async () => ({ user_id: 'BOTUSER', bot_id: 'BOT123' })) },
    users: { info: mock.fn(async ({ user }) => ({ user: { id: user, profile: {} } })) },
    chat: {
      postMessage: mock.fn(async () => ({ ts: '111.222' })),
      postEphemeral: mock.fn(async () => ({ ok: true })),
      update: mock.fn(async () => ({ ts: '111.222' })),
      getPermalink: mock.fn(async (args) => ({ permalink: `https://x/p${args.message_ts}` })),
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

function createHarness({ store, client, ownerIds = [] }) {
  const handlers = {};
  const app = {
    event: (name, handler) => {
      handlers[`event:${name}`] = handler;
    },
    message: (handler) => {
      handlers.message = handler;
    },
    action: (id, handler) => {
      handlers[`action:${id}`] = handler;
    },
    error: mock.fn(),
  };
  const tracker = createHuddleTracker({
    app,
    store,
    client,
    logger: { error: mock.fn(), info: mock.fn(), warn: mock.fn() },
    ownerId: 'UOWNER',
    botChannels: { list: mock.fn(async () => ['Cgolf']) },
    baseUrl: 'https://asteria.test',
  });
  store.upsertHuddleChannel({ channelId: 'Cgolf', name: 'golf', enabled: true, ownerIds });
  store.upsertHuddle({
    callId: 'Rgolf',
    channelId: 'Cgolf',
    createdBy: 'UOWNER',
    startedAt: 172000,
    endedAt: null,
    threadRootTs: '172000.000000',
    participantHistory: ['UOWNER'],
  });
  return { handlers, tracker };
}

function say({ text, user = 'UGUEST', threadTs = '172000.000000' }) {
  return {
    message: {
      type: 'message',
      channel: 'Cgolf',
      user,
      text,
      thread_ts: threadTs,
      ts: '172000.000999',
    },
  };
}

const COOLDOWN_TEXT = /1 minute cooldown/;

describe('the golf bit', () => {
  it('answers in the huddle thread when someone mentions golf', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createHarness({ store, client });

    await handlers.message(say({ text: 'has anyone here played golf' }));
    await flush();

    assert.equal(client.chat.postMessage.mock.callCount(), 1, 'one reply');
    const posted = client.chat.postMessage.mock.calls[0].arguments[0];
    assert.equal(posted.channel, 'Cgolf');
    assert.equal(posted.thread_ts, '172000.000000', 'the reply stays in the thread');
    assert(
      posted.text.includes('i dont play golf') ||
        posted.text.includes("someone forgot that the inspector doesn't play golf"),
      `a canned line, got: ${posted.text}`,
    );
    for (const emoji of [':feels-the-aura:', ':pet-brny:', ':peak:', ':golf:', ':freddie-silly:']) {
      assert(posted.text.includes(emoji), `missing ${emoji} in ${posted.text}`);
    }
    tracker.stop();
  });

  it('also fires on inspector and AIC, but not on unrelated talk', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    // A manager, so the cooldown does not swallow the second trigger word and
    // hide whether it fired at all.
    const { handlers, tracker } = createHarness({ store, client, ownerIds: ['UCM'] });

    await handlers.message(say({ text: 'the inspector is coming', user: 'UCM' }));
    await flush();
    await handlers.message(say({ text: 'AIC said so', user: 'UCM' }));
    await flush();
    assert.equal(client.chat.postMessage.mock.callCount(), 2, 'both trigger words reply');

    await handlers.message(say({ text: 'what about lunch', user: 'UCM' }));
    await flush();
    assert.equal(client.chat.postMessage.mock.callCount(), 2, 'ordinary talk does not');
    tracker.stop();
  });

  it('does not answer outside a huddle thread', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createHarness({ store, client });

    await handlers.message(say({ text: 'golf', threadTs: '999999.000001' }));
    await flush();

    assert.equal(client.chat.postMessage.mock.callCount(), 0, 'no reply outside a huddle');
    tracker.stop();
  });

  it('does not answer its own replies, which would loop forever', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createHarness({ store, client });

    await handlers.message({
      message: {
        subtype: 'bot_message',
        channel: 'Cgolf',
        bot_id: 'BOT123',
        text: 'i dont play golf :golf:',
        thread_ts: '172000.000000',
        ts: '172000.001000',
      },
    });
    await flush();

    assert.equal(client.chat.postMessage.mock.callCount(), 0, 'a bot message is not a trigger');
    tracker.stop();
  });

  it('cools a non-manager down for a minute, telling them once', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createHarness({ store, client });

    await handlers.message(say({ text: 'golf', user: 'UALICE' }));
    await flush();
    assert.equal(client.chat.postMessage.mock.callCount(), 1, 'the first one gets the joke');

    await handlers.message(say({ text: 'golf', user: 'UBOB' }));
    await flush();
    assert.equal(client.chat.postMessage.mock.callCount(), 1, 'the second one gets nothing');
    assert.equal(client.chat.postEphemeral.mock.callCount(), 1, 'but is told why, privately');
    const notice = client.chat.postEphemeral.mock.calls[0].arguments[0];
    assert.equal(notice.user, 'UBOB', 'only the person who was cooled down sees it');
    assert.match(notice.text, COOLDOWN_TEXT);

    await handlers.message(say({ text: 'golf', user: 'UBOB' }));
    await flush();
    assert.equal(client.chat.postEphemeral.mock.callCount(), 1, 'not repeatedly for the same person');
    tracker.stop();
  });

  it('tells each person once, not everybody once', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createHarness({ store, client });

    await handlers.message(say({ text: 'golf', user: 'UALICE' }));
    await flush();
    for (const user of ['UBOB', 'UCARL', 'UDANA']) {
      await handlers.message(say({ text: 'golf', user }));
      await flush();
    }

    assert.equal(client.chat.postMessage.mock.callCount(), 1, 'still only the first reply');
    assert.equal(client.chat.postEphemeral.mock.callCount(), 3, 'each of the other three hears once');
    const recipients = client.chat.postEphemeral.mock.calls.map((call) => call.arguments[0].user);
    assert.deepEqual(recipients, ['UBOB', 'UCARL', 'UDANA']);
    tracker.stop();
  });

  it('never cools a channel manager down', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createHarness({ store, client, ownerIds: ['UCM'] });

    await handlers.message(say({ text: 'golf', user: 'UALICE' }));
    await flush();
    assert.equal(client.chat.postMessage.mock.callCount(), 1);

    for (let i = 0; i < 4; i += 1) {
      await handlers.message(say({ text: 'golf again', user: 'UCM' }));
      await flush();
    }

    assert.equal(client.chat.postMessage.mock.callCount(), 5, 'the manager replies every time');
    assert.equal(client.chat.postEphemeral.mock.callCount(), 0, 'and is never shown a cooldown notice');
    tracker.stop();
  });

  it('lets the cooldown expire, and tells them again on the next one', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createHarness({ store, client });

    // Drive Date directly: the cooldown is wall-clock, so the only honest way to
    // test it ending is to move the clock.
    mock.timers.enable({ apis: ['Date'], now: 1_720_000_000_000 });

    try {
      await handlers.message(say({ text: 'golf', user: 'UALICE' }));
      await flush();
      assert.equal(client.chat.postMessage.mock.callCount(), 1, 'first trigger replies');

      await handlers.message(say({ text: 'golf', user: 'UBOB' }));
      await flush();
      assert.equal(client.chat.postEphemeral.mock.callCount(), 1, 'inside the window, Bob is told');
      assert.equal(client.chat.postMessage.mock.callCount(), 1, 'and gets no reply');

      mock.timers.tick(61 * 1000);

      await handlers.message(say({ text: 'golf', user: 'UBOB' }));
      await flush();
      assert.equal(client.chat.postMessage.mock.callCount(), 2, 'after the window Bob is answered');
      assert.equal(client.chat.postEphemeral.mock.callCount(), 1, 'and gets no stale notice');

      // Arming again should tell Bob once more, rather than ignoring him in
      // silence because he was told in an earlier cycle.
      await handlers.message(say({ text: 'golf again', user: 'UCARL' }));
      await flush();
      await handlers.message(say({ text: 'golf again', user: 'UBOB' }));
      await flush();
      // Carol is told too — she hit the same armed cooldown Bob did.
      assert.equal(client.chat.postEphemeral.mock.callCount(), 3, 'a fresh cooldown tells him again');
      assert.equal(client.chat.postMessage.mock.callCount(), 2, 'and nobody who is cooling down gets a reply');
      const bobNotices = client.chat.postEphemeral.mock.calls
        .map((call) => call.arguments[0].user)
        .filter((user) => user === 'UBOB');
      assert.equal(bobNotices.length, 2, 'Bob was told in both cycles, not just the first');
    } finally {
      mock.timers.reset();
    }
    tracker.stop();
  });

  it('ignores a message with no text at all', async () => {
    const store = await createTestStore();
    const client = createBasicClient();
    const { handlers, tracker } = createHarness({ store, client });

    await handlers.message(say({ text: '' }));
    await handlers.message(say({}));
    await flush();

    assert.equal(client.chat.postMessage.mock.callCount(), 0, 'no text, no reply');
    assert.equal(client.chat.postEphemeral.mock.callCount(), 0, 'and no notice either');
    tracker.stop();
  });
});
