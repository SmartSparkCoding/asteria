import assert from 'node:assert';
import { describe, it, mock } from 'node:test';
import { createBotChannelDirectory } from '../src/services/bot-channels.js';

function createClient({ pages, authUserId = 'UBOT', fail = false } = {}) {
  return {
    auth: { test: mock.fn(async () => ({ user_id: authUserId })) },
    users: {
      conversations: mock.fn(async () => {
        if (fail) {
          throw new Error('ratelimited');
        }
        return pages.shift() || { channels: [] };
      }),
    },
    conversations: {
      list: mock.fn(async () => ({ channels: [] })),
    },
  };
}

describe('bot channel directory', () => {
  it("reads the bot's own memberships and never walks the whole workspace", async () => {
    const client = createClient({
      pages: [
        {
          channels: [{ id: 'Cbot1' }, { id: 'Cbot2' }],
          response_metadata: { next_cursor: 'page2' },
        },
        { channels: [{ id: 'Cbot3' }] },
      ],
    });
    const logger = { info: mock.fn(), error: mock.fn() };
    const directory = createBotChannelDirectory({ client, logger });

    assert.deepEqual(await directory.list(), ['Cbot1', 'Cbot2', 'Cbot3']);
    assert.equal(client.conversations.list.mock.callCount(), 0, 'never enumerates every channel');
    assert.deepEqual(
      client.users.conversations.mock.calls.at(0).arguments[0],
      {
        user: 'UBOT',
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: 999,
      },
      'asks for the bot user id, not a workspace-wide list',
    );
    assert.equal(client.auth.test.mock.callCount(), 1, 'auth.test is resolved once and reused');
  });

  it('caches the membership list instead of re-fetching it per view', async () => {
    const client = createClient({ pages: [{ channels: [{ id: 'Cbot1' }] }] });
    const directory = createBotChannelDirectory({ client, logger: { info: mock.fn(), error: mock.fn() } });

    await directory.list();
    await directory.list();
    await directory.list();

    assert.equal(client.users.conversations.mock.callCount(), 1);
  });

  it('returns nothing when membership cannot be verified instead of guessing', async () => {
    const client = createClient({ fail: true });
    const logger = { info: mock.fn(), error: mock.fn() };
    const directory = createBotChannelDirectory({ client, logger });

    assert.deepEqual(await directory.list(), [], 'shows nothing rather than every known channel');
    assert.equal(logger.error.mock.callCount(), 1, 'the failure is logged, not hidden');
  });
});
