import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { resolvePermissions } from '../src/dashboard/permissions.js';
import { createDashboardServer } from '../src/dashboard/server.js';
import { createStore } from '../src/database/store.js';

const OWNER = 'U0OWNER001';
const HUDDLER = 'U0HUDDLER1';
const STRANGER = 'U0STRANGE1';
const CHANNEL = 'C0RECAPS001';

let store;
let server;
let base;
let dir;

const cookieFor = (id) =>
  `asteria_session=${server.auth.completeLogin({
    slackUserId: id,
    displayName: id,
    permissions: resolvePermissions({ store, slackUserId: id }),
  })}`;

const get = (route, cookie) => fetch(base + route, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
const post = (route, body, cookie) =>
  fetch(base + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-recaps-'));
  store = await createStore(path.join(dir, 'asteria.sqlite'));
  const now = Math.floor(Date.now() / 1000);
  store.updateSettings({ personal_channel_owner_id: OWNER });
  store.upsertHuddleChannel({ channelId: CHANNEL, name: 'general' });
  store.upsertHuddle({
    callId: 'Rrecap',
    channelId: CHANNEL,
    startedAt: now - 600,
    endedAt: now - 60,
    status: 'ended',
  });
  store.upsertHuddleMember({
    callId: 'Rrecap',
    userId: HUDDLER,
    firstSeenAt: now - 600,
    lastSeenAt: now - 60,
    isIn: false,
  });
  server = createDashboardServer({
    store,
    client: {},
    botChannels: { list: async () => [CHANNEL], names: async () => ({ [CHANNEL]: 'general' }) },
    logger: { info() {}, warn() {}, error() {} },
  });
  await server.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${server.server.address().port}`;
});

after(async () => {
  await server?.close();
  store?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('orbit recaps', () => {
  it('sends a signed out visitor to sign in and keeps the path', async () => {
    const res = await get('/general/recaps');
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /^\/login\?next=%2Fgeneral%2Frecaps$/);
  });

  it('shows the policy page to someone who has huddled there', async () => {
    const res = await get('/general/recaps', cookieFor(HUDDLER));
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /recorded and stored by Orbit/, 'the policy is on the page');
    assert.match(html, /What happened/);
  });

  it('refuses someone who has never huddled in the channel', async () => {
    const page = await get('/general/recaps', cookieFor(STRANGER));
    assert.equal(page.status, 200);
    assert.match(await page.text(), /once you have joined a huddle/);

    const res = await post('/api/recaps', { channelId: CHANNEL, body: 'hi', accepted: true }, cookieFor(STRANGER));
    assert.equal(res.status, 403);
  });

  it('accepts a submission only with the policy ticked', async () => {
    const refused = await post('/api/recaps', { channelId: CHANNEL, body: 'the bit' }, cookieFor(HUDDLER));
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /policy/i);

    const accepted = await post(
      '/api/recaps',
      { channelId: CHANNEL, body: 'the bit where the bot said 6 7', accepted: true },
      cookieFor(HUDDLER),
    );
    assert.equal(accepted.status, 200);
    const rows = store.listHuddleRecaps(CHANNEL);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, HUDDLER);
    assert.equal(rows[0].policy_accepted_at.length > 0, true);
  });

  it('only accepts Slack links from the same channel', async () => {
    const other = await post(
      '/api/recaps',
      {
        channelId: CHANNEL,
        body: 'look',
        accepted: true,
        links: ['https://hackclub.slack.com/archives/C0OTHER001/p1793209323798679'],
      },
      cookieFor(HUDDLER),
    );
    assert.equal(other.status, 400);

    const good = await post(
      '/api/recaps',
      {
        channelId: CHANNEL,
        body: 'look',
        accepted: true,
        links: [`https://hackclub.slack.com/archives/${CHANNEL}/p1793209323798679`],
      },
      cookieFor(HUDDLER),
    );
    assert.equal(good.status, 200);
    const rows = store.listHuddleRecaps(CHANNEL);
    assert.equal(rows.find((row) => row.body === 'look').links.length, 1);
  });

  it('lets an admin read every submission for a channel', async () => {
    const res = await get(`/api/recaps?channelId=${CHANNEL}`, cookieFor(OWNER));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert(body.recaps.length >= 2);
    assert.equal((await get(`/api/recaps?channelId=${CHANNEL}`, cookieFor(STRANGER))).status, 403);
  });

  it('rate limits a burst of submissions', async () => {
    const statuses = [];
    for (let i = 0; i < 20; i += 1) {
      const res = await post(
        '/api/recaps',
        { channelId: CHANNEL, body: `burst ${i}`, accepted: true },
        cookieFor(HUDDLER),
      );
      statuses.push(res.status);
      if (res.status === 429) {
        break;
      }
    }
    assert(statuses.includes(429), 'a burst is eventually refused');
    assert(statuses.filter((code) => code === 200).length <= 10, 'at most ten per hour');
  });

  it('shows the recap count on the dashboard config', async () => {
    const res = await get('/api/huddles/config', cookieFor(OWNER));
    const data = await res.json();
    assert(data.channels[0].recapCount >= 2);
  });
});
