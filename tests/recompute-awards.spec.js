import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { recomputeMissingHuddleAwards } from '../src/database/recompute-awards.js';
import { createStore } from '../src/database/store.js';

let createdPaths = [];

afterEach(() => {
  for (const databasePath of createdPaths) {
    fs.rmSync(path.dirname(databasePath), { recursive: true, force: true });
  }
  createdPaths = [];
});

async function createTestStore() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-awards-'));
  const databasePath = path.join(tempDir, 'asteria.sqlite');
  createdPaths.push(databasePath);
  return createStore(databasePath);
}

function addEndedHuddle(store, { callId, channelId, threadRootTs = '1.1', startedAt = 1_790_000_000, seconds = 600 }) {
  store.upsertHuddle({
    callId,
    channelId,
    createdBy: 'U1',
    startedAt,
    endedAt: startedAt + seconds,
    threadRootTs,
    participantHistory: ['U1'],
  });
  store.setHuddleStatus(callId, 'ended', startedAt + seconds);
  store.upsertHuddleMember({
    callId,
    userId: 'U1',
    firstSeenAt: startedAt,
    lastSeenAt: startedAt + seconds,
    isIn: false,
  });
}

describe('recomputing missing huddle awards', () => {
  it('scores an ended huddle that has members but no awards', async () => {
    const store = await createTestStore();
    addEndedHuddle(store, { callId: 'Rmissed', channelId: 'C1' });

    const result = recomputeMissingHuddleAwards(store, { logger: { info() {} } });
    assert.equal(result.huddles, 1);
    assert(result.points > 0, 'the 10 minute call is worth something');
    assert(store.listHuddleAwards('Rmissed').length > 0, 'awards are stored');
    assert(store.listHuddleLeaderboard(5, ['C1']).some((row) => row.user_id === 'U1' && row.points > 0));
    store.close();
  });

  it('is idempotent, so a second run changes nothing', async () => {
    const store = await createTestStore();
    addEndedHuddle(store, { callId: 'Rmissed', channelId: 'C1' });
    const first = recomputeMissingHuddleAwards(store, { logger: { info() {} } });
    const points = store.listHuddleLeaderboard(5, ['C1'])[0].points;
    const second = recomputeMissingHuddleAwards(store, { logger: { info() {} } });
    assert.equal(first.huddles, 1);
    assert.equal(second.huddles, 0, 'already scored');
    assert.equal(store.listHuddleLeaderboard(5, ['C1'])[0].points, points, 'no double count');
    store.close();
  });

  it('does not score a huddle it cannot place in a channel or thread', async () => {
    const store = await createTestStore();
    addEndedHuddle(store, { callId: 'RnoThread', channelId: 'C1', threadRootTs: '' });
    addEndedHuddle(store, { callId: 'RnoChannel', channelId: '', threadRootTs: '' });
    const result = recomputeMissingHuddleAwards(store, { logger: { info() {} } });
    assert.equal(result.huddles, 0, 'no proof the bot was there');
    assert.equal(store.listHuddleAwards('RnoThread').length, 0);
    store.close();
  });

  it('writes nothing on a dry run', async () => {
    const store = await createTestStore();
    addEndedHuddle(store, { callId: 'Rmissed', channelId: 'C1' });
    const result = recomputeMissingHuddleAwards(store, { logger: { info() {} }, dryRun: true });
    assert.equal(result.huddles, 1);
    assert.equal(store.listHuddleAwards('Rmissed').length, 0, 'dry run never awards');
    store.close();
  });
});
