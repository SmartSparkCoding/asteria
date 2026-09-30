import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import {
  anonymiseRow,
  canShowPeople,
  channelIsVisible,
  channelLabel,
  isChannelPublic,
} from '../src/dashboard/privacy.js';
import { buildDashboardStats } from '../src/dashboard/stats.js';
import { createStore } from '../src/database/store.js';

const PUBLIC = 'Cpublic';
const PRIVATE = 'Cprivate';
const UNKNOWN = 'Cunknown';
const START = 1_700_000_000;
const END = START + 3600;

const ANON = { role: null, isOwner: false, isManager: false, managedChannelIds: [] };
const OWNER = { role: 'owner', isOwner: true, isManager: false, managedChannelIds: [] };
const MANAGER = { role: 'manager', isOwner: false, isManager: true, managedChannelIds: [PUBLIC] };

describe('channel privacy rules', () => {
  test('only a positive public answer counts as public', () => {
    assert.equal(isChannelPublic(0), true);
    // -1 means "never checked", and 1 means private. Neither may be read as
    // public, because guessing wrong publishes a private channel's detail.
    assert.equal(isChannelPublic(-1), false);
    assert.equal(isChannelPublic(1), false);
    assert.equal(isChannelPublic(undefined), false);
    assert.equal(isChannelPublic(null), false);
  });

  test('a private or unchecked channel still shows a card, just not its name', () => {
    assert.equal(channelIsVisible(-1), true);
    assert.equal(channelIsVisible(1), true);
  });

  test('an untrusted viewer gets the raw channel id, never the name', () => {
    for (const isPrivate of [-1, 1, 0]) {
      assert.equal(
        channelLabel({ name: 'secret-plans', channelId: 'C123', isPrivate, canIdentify: false }),
        'C123',
        `isPrivate ${isPrivate} must not leak the name to an untrusted viewer`,
      );
    }
  });

  test('a trusted viewer gets the name only for a public channel', () => {
    assert.equal(channelLabel({ name: 'general', channelId: 'C1', isPrivate: 0, canIdentify: true }), 'general');
    assert.equal(channelLabel({ name: 'secret', channelId: 'C2', isPrivate: 1, canIdentify: true }), 'C2');
    assert.equal(channelLabel({ name: 'maybe', channelId: 'C3', isPrivate: -1, canIdentify: true }), 'C3');
  });

  test('a private channel shows people to nobody, not even the owner', () => {
    for (const isPrivate of [1, -1]) {
      assert.equal(
        canShowPeople({ isPrivate, isOwner: true, isManager: false, permissions: OWNER, channelId: PRIVATE }),
        false,
        `isPrivate ${isPrivate} must stay unnamed for the owner too`,
      );
    }
  });

  test('a manager only sees people in a channel they manage', () => {
    assert.equal(
      canShowPeople({ isPrivate: 0, isOwner: false, isManager: true, permissions: MANAGER, channelId: PUBLIC }),
      true,
    );
    assert.equal(
      canShowPeople({ isPrivate: 0, isOwner: false, isManager: true, permissions: MANAGER, channelId: PRIVATE }),
      false,
      'a manager of one channel must not be shown people from another',
    );
    assert.equal(
      canShowPeople({ isPrivate: 0, isOwner: false, isManager: false, permissions: ANON, channelId: PUBLIC }),
      false,
    );
  });

  test('anonymising keeps the number and drops everything identifying', () => {
    const row = anonymiseRow({ userId: 'U123', displayName: 'Freddie', pronouns: 'he/him', points: 42 });
    assert.equal(row.points, 42);
    assert.equal(row.userId, '');
    assert.equal(row.displayName, 'Someone');
    assert.equal(row.pronouns, '');
    assert.ok(!('imageUrl' in row && row.imageUrl));
  });
});

describe('the public dashboard never publishes private detail', () => {
  const created = [];
  let store;
  let slackPrivacyAsked;

  before(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-privacy-'));
    created.push(dir);
    store = await createStore(path.join(dir, 'asteria.sqlite'));
    seed();
  });

  after(() => {
    // One store for the whole suite: sql.js holds the database in memory, so
    // closing it between tests leaves the next one reading a dead handle.
    store.close();
    for (const dir of created) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Three channels, one of each privacy state, each with a huddle and a manager.
   */
  function seed() {
    store.upsertHuddle({
      callId: 'Rpublic1',
      channelId: PUBLIC,
      channelName: 'general',
      createdBy: 'U1',
      startedAt: START,
      endedAt: END,
      status: 'ended',
    });
    store.upsertHuddle({
      callId: 'Rprivate1',
      channelId: PRIVATE,
      channelName: 'secret-plans',
      createdBy: 'U1',
      startedAt: START,
      endedAt: END,
      status: 'ended',
    });
    store.upsertHuddle({
      callId: 'Runknown1',
      channelId: UNKNOWN,
      channelName: 'never-asked',
      createdBy: 'U1',
      startedAt: START,
      endedAt: END,
      status: 'ended',
    });
    for (const [channelId, ownerId] of [
      [PUBLIC, 'U1'],
      [PRIVATE, 'U2'],
      [UNKNOWN, 'U3'],
    ]) {
      store.upsertHuddleChannel({
        channelId,
        name: { [PUBLIC]: 'general', [PRIVATE]: 'secret-plans', [UNKNOWN]: 'never-asked' }[channelId],
        ownerIds: [ownerId],
        isPrivate: 0,
      });
      // Force the tri-state the way the sync would.
      store.setHuddleChannelPrivacy(channelId, channelId === PUBLIC ? 0 : channelId === PRIVATE ? 1 : -1);
    }
  }

  function build(permissions) {
    slackPrivacyAsked = [];
    return buildDashboardStats({
      store,
      botChannels: { list: async () => [PUBLIC, PRIVATE, UNKNOWN] },
      permissions,
      startedAt: Date.now(),
      statusEvents: [{ state: 'ok', at: new Date().toISOString() }],
      slack: {
        channelPrivacy: async (channelId) => {
          slackPrivacyAsked.push(channelId);
          return channelId === PRIVATE ? 1 : 0;
        },
      },
    });
  }

  test('an anonymous viewer gets no channel names, managers or leaderboard names', async () => {
    const stats = await build(ANON);

    for (const channel of stats.channels) {
      assert.notEqual(channel.name, 'general', 'the public channel name is hidden from anonymous');
      assert.equal(channel.managers.length, 0, 'no named manager is published');
      assert.ok(channel.managerCount >= 0, 'but the count is still there');
    }
    for (const row of stats.leaderboard) {
      assert.equal(row.userId, '', 'a leaderboard row must not carry a Slack id');
      assert.equal(row.realName, '');
      assert.equal(row.pronouns, '');
      assert.equal(row.imageUrl, '');
    }
  });

  test('Slack is asked once per unchecked channel and the answer is remembered', async () => {
    // Put both back to unknown: the previous test already resolved them, and
    // this test is about the ask happening exactly once and then sticking.
    store.setHuddleChannelPrivacy(PRIVATE, -1);
    store.setHuddleChannelPrivacy(UNKNOWN, -1);
    await build(ANON);
    assert.deepEqual(
      slackPrivacyAsked.sort(),
      [PRIVATE, UNKNOWN].sort(),
      'a channel Slack already answered for is not asked again',
    );
    // The private answer was persisted, so the next load must not re-ask it.
    assert.equal(store.getHuddleChannel(PRIVATE).is_private, 1);
    assert.equal(store.getHuddleChannel(UNKNOWN).is_private, 0, 'Slack said it was public, so it is now known');
  });

  test('the owner still sees a named leaderboard and public channel names', async () => {
    const stats = await build(OWNER);
    const publicCard = stats.channels.find((channel) => channel.id === PUBLIC);
    assert.equal(publicCard.name, 'general', 'the owner is trusted, so a public channel is named');
    const privateCard = stats.channels.find((channel) => channel.id === PRIVATE);
    assert.equal(privateCard.name, PRIVATE, 'a private channel stays as the raw id even for the owner');
    assert.equal(privateCard.managers.length, 0);
  });
});
