import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createStore } from '../src/database/store.js';
import { computeHuddlePoints } from '../src/huddles/points.js';
import { computeHuddleStats } from '../src/huddles/review.js';

// The real huddle from C09RQFJCJ4U on 2026-09-29, which billed Jacob 182 minutes
// for 58 seconds of attendance.
const T0 = 1790696600; // 15:43:20
const at = (secondsFromT0) => T0 + secondsFromT0;

let store;
let paths = [];

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-attendance-'));
  paths = [path.join(dir, 'asteria.sqlite')];
  store = await createStore(paths[0]);
});

after(() => {
  for (const p of paths) fs.rmSync(p, { force: true });
});

const huddleRow = (endedAt) => ({
  call_id: 'RCALL',
  started_at: T0,
  ended_at: endedAt,
  created_by: 'U0STARTER',
  channel_id: 'CCHAN',
});

describe('attendance intervals', () => {
  it('charges only the closed interval when somebody rejoins', () => {
    const callId = 'RGAP';
    store.openHuddleAttendance(callId, 'U0JACOB', at(58));
    store.closeHuddleAttendance(callId, 'U0JACOB', at(116)); // 58s, then leaves
    store.openHuddleAttendance(callId, 'U0JACOB', at(3800)); // rejoins hours later
    store.closeHuddleAttendance(callId, 'U0JACOB', at(3830)); // stays 30s

    const { participants, partial } = store.computeHuddleAttendance(callId, {
      startedAt: T0,
      endedAt: at(4000),
    });
    assert.equal(partial, false, 'every interval closed, so the data is exact');
    const jacob = participants.find((p) => p.userId === 'U0JACOB');
    assert.equal(jacob.seconds, 88, '58s plus 30s, not the 3772s span between them');
  });

  it('never bills anybody for longer than the call itself', () => {
    const callId = 'RCAP';
    store.openHuddleAttendance(callId, 'U0OVER', at(0));
    // A leave timestamp that lands after the huddle ended, as a late event would.
    store.closeHuddleAttendance(callId, 'U0OVER', at(9999));
    const { participants } = store.computeHuddleAttendance(callId, { startedAt: T0, endedAt: at(600) });
    assert.equal(participants[0].seconds, 600, 'clipped to the length of the call');
  });

  it('unions overlapping intervals instead of adding them', () => {
    const callId = 'ROVERLAP';
    store.openHuddleAttendance(callId, 'U0DUP', at(100));
    store.closeHuddleAttendance(callId, 'U0DUP', at(200));
    store.openHuddleAttendance(callId, 'U0DUP', at(150));
    store.closeHuddleAttendance(callId, 'U0DUP', at(250));
    const { participants } = store.computeHuddleAttendance(callId, { startedAt: T0, endedAt: at(600) });
    // Present from 100 to 250, which is 150s. Adding the two stretches gave 200s
    // and counted the 150-200 overlap twice.
    assert.equal(participants[0].seconds, 150, 'the shared stretch is counted once');
  });

  it('unions an overlap that is not symmetric', () => {
    const callId = 'ROVERLAP2';
    store.openHuddleAttendance(callId, 'U0NEST', at(100));
    store.closeHuddleAttendance(callId, 'U0NEST', at(300));
    store.openHuddleAttendance(callId, 'U0NEST', at(150));
    store.closeHuddleAttendance(callId, 'U0NEST', at(200));
    const { participants } = store.computeHuddleAttendance(callId, { startedAt: T0, endedAt: at(600) });
    // A stretch entirely inside another adds nothing: adding them gave 250s for
    // 200s of real presence.
    assert.equal(participants[0].seconds, 200, 'a nested stretch is not extra time');
  });

  it('does not double count a repeated join for the same open stretch', () => {
    const callId = 'RREJOIN';
    store.openHuddleAttendance(callId, 'U0SAME', at(10));
    store.openHuddleAttendance(callId, 'U0SAME', at(20)); // Slack re-sent the join
    store.closeHuddleAttendance(callId, 'U0SAME', at(70));
    const { participants } = store.computeHuddleAttendance(callId, { startedAt: T0, endedAt: at(600) });
    assert.equal(participants[0].seconds, 60, 'one stretch of 60s, not 60s plus 50s');
  });

  it('awards nothing for a stretch it cannot prove, and says so', () => {
    const callId = 'RPROVE';
    store.openHuddleAttendance(callId, 'U0PROOF', at(0));
    store.closeHuddleAttendance(callId, 'U0PROOF', at(600));
    store.openHuddleAttendance(callId, 'U0PROOF2', at(10)); // never left
    store.openHuddleAttendance(callId, 'U0PROOF3', at(10));
    store.closeHuddleAttendance(callId, 'U0PROOF3', at(610));

    const { participants, partial } = store.computeHuddleAttendance(callId, {
      startedAt: T0,
      endedAt: at(600),
    });
    assert.equal(partial, true, 'the huddle is flagged as partial');
    const unproven = participants.find((p) => p.userId === 'U0PROOF2');
    assert.equal(unproven.seconds, 0, 'no time is invented for the open interval');
    assert.equal(unproven.partial, true);

    const stats = computeHuddleStats({
      huddle: huddleRow(at(600)),
      members: [],
      attendance: { participants, partial },
    });
    assert.equal(stats.attendancePartial, true, 'the review is told it is partial');
  });

  it('scores a partially tracked person on provable time and withholds their rank', () => {
    const callId = 'RRANK';
    store.openHuddleAttendance(callId, 'U0GOOD', at(0));
    store.closeHuddleAttendance(callId, 'U0GOOD', at(600));
    store.openHuddleAttendance(callId, 'U0OPEN', at(0));
    store.closeHuddleAttendance(callId, 'U0OPEN', at(120));
    store.openHuddleAttendance(callId, 'U0OPEN', at(200)); // tail never closed

    const huddle = huddleRow(at(600));
    const attendance = store.computeHuddleAttendance(callId, { startedAt: T0, endedAt: huddle.ended_at });
    const stats = computeHuddleStats({ huddle, members: [], attendance });

    const awards = computeHuddlePoints({ huddle, members: [], attendance });
    const good = awards.get('U0GOOD');
    const open = awards.get('U0OPEN');

    assert.equal(good.points, 10 * 1 + 5, '10 minutes plus the rank bonus');
    assert.equal(open.points, 2, 'only the 2 provable minutes, no rank bonus');
    assert.equal(open.reasons.some((reason) => reason.kind === 'rank'), false, 'a partial record cannot take first place');
    assert.equal(stats.attendancePartial, true);
  });

  it('does not score a leave time we had to invent ourselves', () => {
    // This is the shape of the real bug: Jacob left after 58s, Slack never sent
    // a second leave, and the only way to bound the row was to fill the end in.
    const callId = 'RINFER';
    store.openHuddleAttendance(callId, 'U0REAL', at(58));
    store.closeHuddleAttendance(callId, 'U0REAL', at(116)); // proven 58s
    store.openHuddleAttendance(callId, 'U0REAL', at(3800)); // rejoined, never left
    store.closeAllOpenHuddleAttendance(callId, at(4000)); // end time we supplied

    const { participants, partial } = store.computeHuddleAttendance(callId, {
      startedAt: T0,
      endedAt: at(4000),
    });
    const jacob = participants.find((p) => p.userId === 'U0REAL');
    assert.equal(partial, true, 'the invented end keeps the huddle partial');
    assert.equal(jacob.partial, true);
    assert.equal(jacob.seconds, 58, 'only the proven 58 seconds counts toward points');
    assert.equal(jacob.ceilingSeconds, 258, 'the full span is still reported as a ceiling');

    const huddle = huddleRow(at(4000));
    const awards = computeHuddlePoints({
      huddle,
      members: [],
      attendance: { participants, partial },
    });
    assert.equal(awards.get('U0REAL').points, 1, '58 seconds is one minute of points, not 182');
    assert.equal(awards.get('U0REAL').reasons.some((reason) => reason.kind === 'rank'), false, 'and no rank bonus');
  });

  it('falls back to the old span for huddles recorded before intervals, marked partial', () => {
    const huddle = huddleRow(at(600));
    const stats = computeHuddleStats({
      huddle,
      members: [{ user_id: 'U0OLD', first_seen_at: at(0), last_seen_at: at(600) }],
      attendance: { participants: [], partial: false },
    });
    assert.equal(stats.attendancePartial, true, 'pre interval data is never treated as exact');
    assert.equal(stats.participants[0].durationSeconds, 600);
  });
});
