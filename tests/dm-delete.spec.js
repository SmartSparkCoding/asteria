import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it, mock } from 'node:test';
import { createChannelPermissions } from '../src/app-home/permissions.js';
import { createStore } from '../src/database/store.js';
import { registerDmDeleteByLink } from '../src/dm/delete-by-link.js';

const OWNER = 'U0AEYDUCLKF';
const MANAGER = 'U0MANAGER01';
const STRANGER = 'U0STRANGER1';
const DM = 'D0BOTDM001';

const createdPaths = [];

after(() => {
  for (const created of createdPaths) {
    fs.rmSync(created, { force: true });
  }
});

function createClient() {
  return {
    chat: {
      postMessage: mock.fn(async () => ({ ts: '1.1' })),
      delete: mock.fn(async () => ({ ok: true })),
    },
  };
}

async function createHarness() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-dm-'));
  const databasePath = path.join(tempDir, 'asteria.sqlite');
  createdPaths.push(databasePath);
  const store = await createStore(databasePath);
  store.updateSettings({ personal_channel_owner_id: OWNER, timezone: 'UTC' });
  store.upsertHuddleChannel({ channelId: 'C0MANAGED01', name: 'managed', ownerIds: [MANAGER] });

  const client = createClient();
  const app = { message: mock.fn(), event: mock.fn(), action: mock.fn(), view: mock.fn(), error: mock.fn() };
  const logger = { info: mock.fn(), error: mock.fn() };
  const permissions = createChannelPermissions({ store });
  const { handleDirectMessage } = registerDmDeleteByLink({ app, store, client, logger, permissions });

  return { store, client, logger, handleDirectMessage, app };
}

function dm(text, user) {
  return { message: { channel: DM, channel_type: 'im', user, text }, client: undefined };
}

const LINK = 'https://hackclub.slack.com/archives/C09RQFJCJ4U/p1790380910506989';

describe('delete a message by DMing the bot a link', () => {
  it('is registered as a message handler', async () => {
    const { app } = await createHarness();
    assert.equal(app.message.mock.callCount(), 1);
  });

  it('lets the app owner delete a message by DM', async () => {
    const { store, client, handleDirectMessage } = await createHarness();

    await handleDirectMessage(dm(`delete this ${LINK}`, OWNER));

    assert.equal(client.chat.delete.mock.callCount(), 1);
    const target = client.chat.delete.mock.calls.at(0).arguments[0];
    assert.equal(target.channel, 'C09RQFJCJ4U');
    assert.equal(target.ts, '1790380910.506989');
    const reply = client.chat.postMessage.mock.calls.at(-1).arguments[0];
    assert(reply.text.includes('Deleted'), 'confirms in the DM');
    assert(
      store.listTriggerLog().some((entry) => entry.action === 'delete_message' && entry.channel_id === 'C09RQFJCJ4U'),
      'logs the delete against the channel',
    );
  });

  it('lets a channel manager delete in the channel they manage', async () => {
    const { client, handleDirectMessage } = await createHarness();
    const managedLink = 'https://hackclub.slack.com/archives/C0MANAGED01/p1790380910506989';

    await handleDirectMessage(dm(managedLink, MANAGER));

    assert.equal(client.chat.delete.mock.callCount(), 1);
    assert.equal(client.chat.delete.mock.calls.at(0).arguments[0].channel, 'C0MANAGED01');
  });

  it('refuses a manager trying it in a channel they do not manage', async () => {
    const { client, handleDirectMessage } = await createHarness();

    await handleDirectMessage(dm(LINK, MANAGER));

    assert.equal(client.chat.delete.mock.callCount(), 0, 'managers are scoped to their own channels');
  });

  it('refuses anyone who does not manage that channel', async () => {
    const { store, client, handleDirectMessage } = await createHarness();

    await handleDirectMessage(dm(LINK, STRANGER));

    assert.equal(client.chat.delete.mock.callCount(), 0, 'nothing is deleted');
    const reply = client.chat.postMessage.mock.calls.at(-1).arguments[0];
    assert(reply.text.includes('not a manager'), 'says why in the DM');
    assert(
      store.listTriggerLog().some((entry) => entry.action === 'delete_message_denied'),
      'the refusal is logged',
    );
  });

  it('explains a Slack failure instead of pretending it worked', async () => {
    const { store, client, handleDirectMessage } = await createHarness();
    client.chat.delete = mock.fn(async () => {
      const error = new Error('An API error occurred: not_in_channel');
      error.data = { error: 'not_in_channel' };
      throw error;
    });

    await handleDirectMessage(dm(LINK, OWNER));

    const reply = client.chat.postMessage.mock.calls.at(-1).arguments[0];
    assert(reply.text.includes('not_in_channel'), 'surfaces the reason');
    assert(
      store.listTriggerLog().some((entry) => entry.action === 'delete_message_failed'),
      'the failure is logged',
    );
  });

  it('ignores DMs without a message link, and messages outside DMs', async () => {
    const { client, handleDirectMessage } = await createHarness();

    await handleDirectMessage(dm('hey, what is up?', OWNER));
    await handleDirectMessage({
      message: {
        channel: 'C09RQFJCJ4U',
        user: OWNER,
        text: `delete this ${LINK}`,
      },
    });

    assert.equal(client.chat.delete.mock.callCount(), 0);
    assert.equal(client.chat.postMessage.mock.callCount(), 0, 'stays quiet in channels');
  });
});
