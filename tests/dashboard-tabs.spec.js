import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { resolvePermissions } from '../src/dashboard/permissions.js';
import { createDashboardServer } from '../src/dashboard/server.js';
import { createStore } from '../src/database/store.js';

const OWNER = 'U0AEYDUCLKF';
const MANAGER = 'U0MANAGER01';
const CHANNEL = 'C0MANAGED01';

let store;
let server;
let base;
let ownerCookie;
let managerCookie;
const paths = [];

const nowSec = () => Math.floor(Date.now() / 1000);

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-tabs-'));
  paths.push(path.join(dir, 'asteria.sqlite'));
  store = await createStore(paths[0]);
  store.updateSettings({ personal_channel_owner_id: OWNER, daily_question_send_time: '09:00' });
  store.upsertHuddleChannel({ channelId: CHANNEL, name: 'managed', ownerIds: [OWNER, MANAGER] });
  store.upsertHuddle({ callId: 'R1', startedAt: nowSec() - 60, channelId: CHANNEL, threadRootTs: '1.1' });
  store.upsertHuddle({ callId: 'R2', startedAt: nowSec() - 60 });

  server = createDashboardServer({
    store,
    client: {},
    botChannels: {
      list: async () => [CHANNEL, 'C0UNCONFIGURED'],
      // Must match the real botChannels.names, which returns a plain object keyed
      // by id. An earlier version of this mock returned a Map, which hid a
      // `names.get is not a function` that 500'd both tabs in production.
      names: async (ids) => Object.fromEntries((ids || []).map((id) => [id, id === CHANNEL ? 'managed' : 'loose'])),
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  await server.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${server.server.address().port}`;

  const mint = (id) =>
    server.auth.completeLogin({
      slackUserId: id,
      displayName: id,
      permissions: resolvePermissions({ store, slackUserId: id }),
    });
  ownerCookie = `asteria_session=${mint(OWNER)}`;
  managerCookie = `asteria_session=${mint(MANAGER)}`;
});

after(async () => {
  server?.close();
  for (const p of paths) fs.rmSync(p, { force: true });
});

const get = (route, cookie) => fetch(base + route, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
const send = (route, body, cookie) =>
  fetch(base + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

describe('tabbed pages', () => {
  it('sends a signed out visitor to sign in', async () => {
    for (const route of ['/j-log', '/huddles', '/admin']) {
      const res = await get(route);
      assert.equal(res.status, 302, `${route} should redirect`);
      assert.equal(res.headers.get('location'), '/login');
    }
  });

  it('serves each tab to the owner with the tab marked current', async () => {
    for (const [route, label] of [
      ['/j-log', 'j-log manager'],
      ['/huddles', 'Orbit Huddles'],
      ['/admin', 'Orbit Admin'],
    ]) {
      const html = await (await get(route, ownerCookie)).text();
      assert(html.includes(label), `${route} shows its tab`);
      assert(html.includes('class="brand" href="/"'), `${route} links home from the icon`);
    }
  });

  it('keeps a non owner out of the admin panel', async () => {
    const html = await (await get('/admin', managerCookie)).text();
    assert(!html.includes('Bot membership'), 'no admin data leaks');
    const res = await get('/api/admin', managerCookie);
    assert.equal(res.status, 403);
  });

  it('explains what the bot cannot see', async () => {
    // Status first: a 500 would still parse as json and fail later for the wrong
    // reason, which is how both tabs broke in production without a test noticing.
    const res = await get('/api/admin', ownerCookie);
    assert.equal(res.status, 200, '/api/admin must not error');
    const data = await res.json();
    assert.equal(data.orphans.noChannel, 1, 'the channelless huddle is counted');
    assert(data.orphans.total >= 1);
    assert(
      data.permissions.some((p) => p.granted === false),
      'the missing scope is named',
    );
    assert.equal(data.membership['channels the bot is in'], '2');
  });

  it('flags a channel the bot tracks but has no settings for', async () => {
    const res = await get('/api/huddles/config', ownerCookie);
    assert.equal(res.status, 200, '/api/huddles/config must not error');
    const data = await res.json();
    assert.equal(data.unconfigured.length, 1);
    assert.equal(data.unconfigured[0].name, 'loose');
  });

  it('saves the j-log draft and settings', async () => {
    assert.equal((await send('/api/j-log/draft', { main_update_text: 'today' }, ownerCookie)).status, 200);
    const data = await (await get('/api/j-log', ownerCookie)).json();
    assert.equal(data.draft.main_update_text, 'today');

    await send('/api/j-log/settings', { daily_question_enabled: 0, daily_question_send_time: '07:30' }, ownerCookie);
    const after = await (await get('/api/j-log', ownerCookie)).json();
    assert.equal(after.settings.daily_question_send_time, '07:30');
    assert.equal(Number(after.settings.daily_question_enabled), 0);
  });

  it('toggles a channel flag and a pause', async () => {
    assert.equal(
      (await send('/api/huddles/config', { channelId: CHANNEL, restrict_triggers: 1 }, ownerCookie)).status,
      200,
    );
    let data = await (await get('/api/huddles/config', ownerCookie)).json();
    assert.equal(data.channels[0].restrict_triggers, true);

    // Condensed mode: on, the thread gets the summary and a link and no button.
    assert.equal(
      (await send('/api/huddles/config', { channelId: CHANNEL, condensed_review: 1 }, ownerCookie)).status,
      200,
    );
    data = await (await get('/api/huddles/config', ownerCookie)).json();
    assert.equal(data.channels[0].condensed_review, true, 'condensed is readable back');

    await send('/api/huddles/config', { channelId: CHANNEL, paused: true }, ownerCookie);
    data = await (await get('/api/huddles/config', ownerCookie)).json();
    assert.equal(data.channels[0].paused, true, 'a pause silences the channel');

    await send('/api/huddles/config', { channelId: CHANNEL, paused: false }, ownerCookie);
    data = await (await get('/api/huddles/config', ownerCookie)).json();
    assert.equal(data.channels[0].paused, false);
  });

  it('adds and removes a manager', async () => {
    await send('/api/huddles/owners', { channelId: CHANNEL, add: 'U0NEWMAN01' }, ownerCookie);
    let data = await (await get('/api/huddles/config', ownerCookie)).json();
    assert(data.channels[0].owners.some((o) => o.id === 'U0NEWMAN01'));

    await send('/api/huddles/owners', { channelId: CHANNEL, remove: 'U0NEWMAN01' }, ownerCookie);
    data = await (await get('/api/huddles/config', ownerCookie)).json();
    assert(!data.channels[0].owners.some((o) => o.id === 'U0NEWMAN01'));
  });

  it('rejects a manager id that is not a slack id', async () => {
    const res = await send('/api/huddles/owners', { channelId: CHANNEL, add: 'not-an-id' }, ownerCookie);
    assert.equal(res.status, 400);
  });

  it('stops a manager reaching a channel that is not theirs', async () => {
    const res = await send('/api/huddles/config', { channelId: 'C0SOMEONEELSE', enabled: 0 }, managerCookie);
    assert.equal(res.status, 403);
  });

  it('shows a manager only the channels they run', async () => {
    const data = await (await get('/api/huddles/config', managerCookie)).json();
    assert.deepEqual(
      data.channels.map((c) => c.channelId),
      [CHANNEL],
      'a manager never sees another channel',
    );
    assert.deepEqual(data.available, [], 'only the owner may adopt new channels');
  });

  it('hides the owner tabs and pages from a manager', async () => {
    const html = await (await get('/huddles', managerCookie)).text();
    assert(html.includes('Orbit Huddles'));
    assert(!html.includes('j-log manager'), 'no j-log tab');
    assert(!html.includes('Orbit Admin'), 'no admin tab');

    for (const route of ['/j-log', '/admin']) {
      assert.equal((await get(route, managerCookie)).status, 403, `${route} is owner only`);
    }
  });

  it('keeps the global settings away from a channel manager', async () => {
    assert.equal((await get('/api/j-log', managerCookie)).status, 403);
    assert.equal((await send('/api/j-log/settings', { timezone: 'UTC' }, managerCookie)).status, 403);

    // The old endpoint took the raw body into updateSettings, so any manager
    // could post personal_channel_owner_id and become the owner.
    const escalation = await send('/api/j-log/settings', { personal_channel_owner_id: MANAGER }, managerCookie);
    assert.equal(escalation.status, 403, 'the attempt is refused');
    assert.equal(store.getSettings().personal_channel_owner_id, OWNER, 'the owner did not change');
  });

  it('changes one flag without resetting the rest of the channel', async () => {
    await send(
      '/api/huddles/config',
      { channelId: CHANNEL, auto_replies: 0, restrict_triggers: 1, condensed_review: 1 },
      ownerCookie,
    );
    await send('/api/huddles/config', { channelId: CHANNEL, enabled: 0 }, ownerCookie);

    const data = await (await get('/api/huddles/config', ownerCookie)).json();
    const channel = data.channels.find((c) => c.channelId === CHANNEL);
    assert.equal(channel.enabled, false, 'the requested flag changed');
    assert.equal(channel.auto_replies, false, 'an unrelated flag survived');
    assert.equal(channel.restrict_triggers, true, 'an unrelated flag survived');
    assert.equal(channel.condensed_review, true, 'an unrelated flag survived');
    assert(
      channel.owners.some((o) => o.id === MANAGER),
      'the owner list survived',
    );
  });

  it('adding a manager does not reset the channel', async () => {
    await send(
      '/api/huddles/config',
      { channelId: CHANNEL, enabled: 0, auto_replies: 0, restrict_triggers: 1 },
      ownerCookie,
    );
    await send('/api/huddles/owners', { channelId: CHANNEL, add: 'U0NEWMAN02' }, ownerCookie);

    const data = await (await get('/api/huddles/config', ownerCookie)).json();
    const channel = data.channels.find((c) => c.channelId === CHANNEL);
    assert(
      channel.owners.some((o) => o.id === 'U0NEWMAN02'),
      'the manager was added',
    );
    assert.equal(channel.enabled, false, 'the enabled flag survived');
    assert.equal(channel.auto_replies, false, 'the replies flag survived');
    assert.equal(channel.restrict_triggers, true, 'the triggers flag survived');
  });

  it('lets the owner adopt a channel the bot is already in', async () => {
    const before = await (await get('/api/huddles/config', ownerCookie)).json();
    assert(
      before.available.some((c) => c.channelId === 'C0UNCONFIGURED'),
      'an untracked channel is offered rather than silently missing',
    );

    assert.equal(
      (await send('/api/huddles/config', { channelId: 'C0UNCONFIGURED', enabled: 1 }, ownerCookie)).status,
      200,
    );
    const after = await (await get('/api/huddles/config', ownerCookie)).json();
    assert(
      after.channels.some((c) => c.channelId === 'C0UNCONFIGURED'),
      'it is a channel card now',
    );
    assert.deepEqual(after.available, [], 'and it is no longer offered');
  });
});
