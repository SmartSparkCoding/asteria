import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { backfillHuddleAwards } from '../src/database/backfill-huddle-awards.js';
import { createStore } from '../src/database/store.js';

const T0 = 1_700_000_000;
const CHANNEL = 'Cinside';

const created = [];
afterEach(() => {
  for (const dir of created) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  created.length = 0;
});

async function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-backfill-'));
  created.push(dir);
  return createStore(path.join(dir, 'asteria.sqlite'));
}

const noop = { info() {}, warn() {}, error() {} };

/**
 * A huddle whose member row claims far more time than the intervals support.
 *
 * That mismatch is the whole point: `first_seen_at`/`last_seen_at` is the
 * corrupt single span, and the intervals are the truth.
 */
function seedOvercountedHuddle(store, { callId = 'Rback', startedAt = T0, endedAt = T0 + 600 } = {}) {
  store.upsertHuddle({
    callId,
    channelId: CHANNEL,
    channelName: 'inside',
    createdBy: 'USTARTER',
    startedAt,
    endedAt,
    threadRootTs: '1.1',
    status: 'ended',
    participantHistory: ['USTARTER', 'UJOINER'],
  });
  // The member spans claim the whole ten minutes for both people.
  for (const [userId, seen] of [
    ['USTARTER', startedAt],
    ['UJOINER', startedAt + 300],
  ]) {
    store.upsertHuddleMember({
      callId,
      userId,
      firstSeenAt: seen,
      lastSeenAt: endedAt,
      isIn: false,
    });
  }
  // But the intervals only prove a minute each.
  store.openHuddleAttendance(callId, 'USTARTER', startedAt);
  store.closeHuddleAttendance(callId, 'USTARTER', startedAt + 60);
  store.openHuddleAttendance(callId, 'UJOINER', startedAt + 300);
  store.closeHuddleAttendance(callId, 'UJOINER', startedAt + 360);
}

describe('rebuilding historical huddle award breakdowns', () => {
  it('rebuilds from the stored intervals, not the corrupt member spans', async () => {
    const store = await freshStore();
    seedOvercountedHuddle(store);

    const result = backfillHuddleAwards({ store, logger: noop });
    assert.equal(result.reconstructed, 1);

    const awards = store.listHuddleAwards('Rback');
    assert.equal(awards.length, 2, 'both people are on the page');
    // If the fallback to first_seen/last_seen were still in play, each person
    // would score 10m or 5m. The intervals only prove one minute each.
    for (const award of awards) {
      const attendance = award.reasons.find((reason) => /^\d+m$/.test(reason));
      assert.equal(attendance, '1m', `${award.userId} is scored on the minute actually proven`);
    }
    store.close();
  });

  it('tags every row so the page can say the total was rebuilt', async () => {
    const store = await freshStore();
    seedOvercountedHuddle(store);
    backfillHuddleAwards({ store, logger: noop });

    // The page banner keys off this exact string, so a typo here silently
    // drops the explanation of where the number came from.
    for (const award of store.listHuddleAwards('Rback')) {
      assert(award.reasons.includes('backfilled'), `${award.user_id} carries the marker`);
    }
    store.close();
  });

  it('leaves a huddle alone when there are no intervals to rebuild from', async () => {
    const store = await freshStore();
    // Members but no intervals: the only thing available is the corrupt span,
    // so the honest answer is an empty page rather than a wrong total.
    store.upsertHuddle({
      callId: 'Rbare',
      channelId: CHANNEL,
      channelName: 'inside',
      createdBy: 'USTARTER',
      startedAt: T0,
      endedAt: T0 + 600,
      threadRootTs: '2.2',
      status: 'ended',
    });
    store.upsertHuddleMember({
      callId: 'Rbare',
      userId: 'USTARTER',
      firstSeenAt: T0,
      lastSeenAt: T0 + 600,
      isIn: false,
    });

    const result = backfillHuddleAwards({ store, logger: noop });
    assert.equal(result.reconstructed, 0);
    assert.equal(result.noAttendance, 1, 'it is counted as unrebuildable, not silently dropped');
    assert.equal(store.listHuddleAwards('Rbare').length, 0);
    store.close();
  });

  it('never invents a score for a huddle with no channel', async () => {
    const store = await freshStore();
    // No channel means the awarder could never have proven it was inside.
    store.upsertHuddle({
      callId: 'Rnchan',
      channelId: '',
      createdBy: 'USTARTER',
      startedAt: T0,
      endedAt: T0 + 600,
      status: 'ended',
    });
    store.upsertHuddleMember({
      callId: 'Rnchan',
      userId: 'USTARTER',
      firstSeenAt: T0,
      lastSeenAt: T0 + 60,
      isIn: false,
    });

    const result = backfillHuddleAwards({ store, logger: noop });
    assert.equal(result.reconstructed, 0);
    assert.equal(store.listHuddleAwards('Rnchan').length, 0);
    store.close();
  });

  it('leaves already stored breakdowns alone', async () => {
    const store = await freshStore();
    seedOvercountedHuddle(store);
    backfillHuddleAwards({ store, logger: noop });
    const first = store.listHuddleAwards('Rback');

    const second = backfillHuddleAwards({ store, logger: noop });
    assert.equal(second.reconstructed, 0);
    assert.equal(second.alreadyStored, 1);
    assert.deepEqual(
      store.listHuddleAwards('Rback').map((award) => award.reasons),
      first.map((award) => award.reasons),
      'and it is idempotent',
    );
    store.close();
  });
});
