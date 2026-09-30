import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createDashboardServer } from '../src/dashboard/server.js';
import { createStore } from '../src/database/store.js';

const OWNER = 'U0AEYDUCLKF';
const IN_THE_HUDDLE = 'U0PARTICIP1';
const NOT_IN_IT = 'U0STRANGER1';
const CHANNEL = 'C0PUBDCHAN1';
const CALL = 'R0PUBDHUD1';

let store;
let server;
let base;
let paths = [];
const cookies = {};

const nowSec = () => Math.floor(Date.now() / 1000);

// Only these two reach out, and the page must not depend on anything else.
const cachet = {
  list: async (ids) =>
    Object.fromEntries(
      (ids || []).map((id) => [id, { displayName: `name-${id}`, realName: '', imageUrl: '', slackUserId: id }]),
    ),
  fetchProfile: async () => null,
  avatarUrl: (id) => `https://cachet.hackclub.com/users/${id}/r`,
  profileUrl: (id) => `https://cachet.hackclub.com/users/${id}`,
  clear() {},
};

const flaron = {
  fetchChannel: async (id) => ({ channelId: id, name: 'pubd', members: 3, isPrivate: false }),
  list: async () => ({}),
  avatarUrl: (id) => `https://cachet.hackclub.com/users/${id}/r`,
  profileUrl: (id) => `https://cachet.hackclub.com/users/${id}`,
  clear() {},
};

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-huddlepage-'));
  paths = [path.join(dir, 'asteria.sqlite')];
  store = await createStore(paths[0]);
  store.updateSettings({ personal_channel_owner_id: OWNER });
  store.upsertHuddleChannel({ channelId: CHANNEL, name: 'pubd', isPrivate: false });
  store.upsertHuddle({
    callId: CALL,
    channelId: CHANNEL,
    createdBy: IN_THE_HUDDLE,
    startedAt: nowSec() - 900,
    endedAt: nowSec() - 300,
    threadRootTs: '1.1',
    status: 'ended',
  });
  store.openHuddleAttendance(CALL, IN_THE_HUDDLE, nowSec() - 900);
  store.closeHuddleAttendance(CALL, IN_THE_HUDDLE, nowSec() - 300);
  store.saveHuddleAwards(CALL, CHANNEL, new Map([[IN_THE_HUDDLE, { points: 24, reasons: ['10m', 'rank 1'] }]]));
  // The owner was in the call but earned nothing, so the live roster holds two
  // people while the page's points table holds one. Both are right: the feed
  // reports who attended, the table reports who was awarded for.
  store.upsertHuddleMember({
    callId: CALL,
    userId: IN_THE_HUDDLE,
    firstSeenAt: nowSec() - 900,
    lastSeenAt: nowSec() - 300,
    isIn: false,
  });
  store.upsertHuddleMember({
    callId: CALL,
    userId: OWNER,
    firstSeenAt: nowSec() - 850,
    lastSeenAt: nowSec() - 300,
    isIn: false,
  });

  server = createDashboardServer({
    store,
    client: {},
    botChannels: { list: async () => [CHANNEL], names: async () => ({}) },
    cachet,
    flaron,
    logger: { info() {}, warn() {}, error() {} },
  });
  await server.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${server.server.address().port}`;
  for (const id of [OWNER, IN_THE_HUDDLE, NOT_IN_IT]) {
    cookies[id] =
      `asteria_session=${server.auth.completeLogin({ slackUserId: id, displayName: id, permissions: { role: 'user', isOwner: id === OWNER, isManager: false, managedChannelIds: [] } })}`;
  }
});

after(async () => {
  server?.close();
  for (const p of paths) fs.rmSync(p, { force: true });
});

const get = (route, cookie) => fetch(base + route, { headers: cookie ? { cookie } : {}, redirect: 'manual' });

describe('huddle pages', () => {
  it('lets Jacob and people who were in the huddle see the page', async () => {
    for (const who of [OWNER, IN_THE_HUDDLE]) {
      const res = await get(`/${CALL}`, cookies[who]);
      assert.equal(res.status, 200, `${who} should be allowed`);
      const html = await res.text();
      assert(html.includes('Huddle overview'), 'renders the page');
      assert(html.includes(`name-${IN_THE_HUDDLE}`), 'names the person who was there');
      assert(html.includes('10m in the call'), 'shows why they scored');
    }
  });

  it('hides the page from everyone else, and does not confirm it exists', async () => {
    const res = await get(`/${CALL}`, cookies[NOT_IN_IT]);
    // 404 rather than 403, so the response does not prove the huddle is real.
    assert.equal(res.status, 404);
    const html = await res.text();
    assert(!html.includes('Huddle overview'), 'no huddle data leaks');
    assert(!html.includes(`name-${IN_THE_HUDDLE}`), 'not even the attendance');
  });

  it('sends a signed out visitor to sign in, which is also what makes an unfurl harmless', async () => {
    const res = await get(`/${CALL}`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `/login?next=%2F${CALL}`);
  });

  it('never mentions anybody, so opening a page notifies nobody', async () => {
    const html = await (await get(`/${CALL}`, cookies[OWNER])).text();
    assert.equal(html.match(/<@[A-Z0-9]+>/g), null, 'no Slack mentions in the page');
  });

  it('asks search engines and link previews to leave it alone', async () => {
    const html = await (await get(`/${CALL}`, cookies[OWNER])).text();
    assert(html.includes('noindex'), 'marked noindex');
    // A Slack unfurl reads og: tags, so none of them may exist.
    assert(!/property=["']og:/.test(html), 'no Open Graph tags to unfurl');
  });

  it('404s a huddle that does not exist, even for Jacob', async () => {
    assert.equal((await get('/R0NOSUCH1', cookies[OWNER])).status, 404);
  });

  it('does not let a manager reach it just by managing the channel', async () => {
    store.upsertHuddleChannel({ channelId: CHANNEL, name: 'pubd', ownerIds: [NOT_IN_IT] });
    const cookie = `asteria_session=${server.auth.completeLogin({
      slackUserId: NOT_IN_IT,
      displayName: NOT_IN_IT,
      permissions: { role: 'manager', isOwner: false, isManager: true, managedChannelIds: [CHANNEL] },
    })}`;
    const res = await get(`/${CALL}`, cookie);
    // Owning a channel is not the same as having been on the call, and this page
    // carries the per person breakdown.
    assert.equal(res.status, 404, 'managing a channel does not grant huddle pages');
    store.upsertHuddleChannel({ channelId: CHANNEL, name: 'pubd', ownerIds: [] });
  });

  it('serves the live feed only to people who can see the page', async () => {
    const allowed = await get(`/api/huddle/${CALL}/live`, cookies[OWNER]);
    assert.equal(allowed.status, 200);
    const data = await allowed.json();
    assert.equal(data.callId, CALL);
    assert.equal(data.isLive, false, 'an ended huddle is not live');
    assert.equal(data.totalPoints, 24);
    assert.equal(data.participants, 2, 'the feed reports the roster, including whoever earned nothing');
    assert.equal(data.totalPoints, 24, 'and the points come from awards, not the head count');
    assert.equal(typeof data.isLive, 'boolean');

    assert.equal((await get(`/api/huddle/${CALL}/live`, cookies[NOT_IN_IT])).status, 404);
    assert.equal((await get(`/api/huddle/${CALL}/live`)).status, 401);
  });

  it('tags the two counters that change during a live huddle', async () => {
    const res = await get(`/${CALL}`, cookies[OWNER]);
    assert.equal(res.status, 200);
    const html = await res.text();
    // A live huddle polls this feed, so the numbers that move need to be
    // addressable. Without this the poll can only notice the huddle ended.
    assert(html.includes('data-live="participants"'), 'the head count is updatable');
    assert(html.includes('data-live="points"'), 'and so is the total');
    const participants = /data-live="participants"[^>]*>([0-9]+)</.exec(html);
    assert(participants && participants[1] === '2', 'it starts showing the real head count');
    const points = /data-live="points"[^>]*>([0-9]+)</.exec(html);
    assert(points && points[1] === '24', 'and the real points, which come from awards not the roster');
  });
});
