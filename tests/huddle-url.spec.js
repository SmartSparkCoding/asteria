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

  test('the old broken path really is a 404, so this test would have caught it', async () => {
    const broken = await fetch(`${harness.base}/huddle/${CALL}`, { redirect: 'manual' });
    assert.equal(broken.status, 404);
  });

  test('no base URL means no link, rather than a link to nowhere', () => {
    assert.equal(huddlePageUrl('', CALL), '');
    assert.equal(huddlePageUrl('https://x.test', ''), '');
    assert.equal(huddlePageUrl(null, CALL), '');
  });
});
