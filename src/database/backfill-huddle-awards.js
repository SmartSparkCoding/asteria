import { computeHuddlePoints, parseParticipantHistory } from '../huddles/points.js';

/**
 * Reconstruct the point breakdown for huddles that were tracked before the
 * breakdown was stored.
 *
 * Two things this deliberately does NOT do.
 *
 * It does not award points. The leaderboard already holds whatever these huddles
 * actually paid out, and re-awarding would double count. This only fills in
 * `huddle_awards` so a historical huddle's page has something to show.
 *
 * It does not reconstruct huddles that were never eligible for points. The
 * awarder only paid out for huddles it could prove it was inside, which means a
 * huddle with a channel the bot was not in. The bot sees huddle presence
 * workspace wide, so most of what it recorded is in that category, and inventing
 * a score for them would put points on a page that were never awarded to anyone.
 * Those huddles are reported as `skipped` and their pages say so.
 *
 * Message based awards (longest and shortest message) are gone for good. They
 * needed a Slack thread read at the time the huddle ended, which nobody kept, so
 * historical breakdowns are attendance, rank and starter only. Pages label it
 * rather than quietly showing a smaller total.
 */
export function backfillHuddleAwards({ store, logger = console, batchLogEvery = 100 } = {}) {
  const huddles = store.listHuddles();
  const result = { reconstructed: 0, skipped: 0, pagesFilled: 0, alreadyStored: 0, noAttendance: 0 };

  for (const huddle of huddles) {
    const callId = huddle.call_id;
    if (!callId || !huddle.started_at || !huddle.ended_at) {
      result.skipped += 1;
      continue;
    }
    if (huddle.channel_id && store.listHuddleAwards(callId).length > 0) {
      result.alreadyStored += 1;
      continue;
    }

    if (!huddle.channel_id) {
      // Unattributable, so the awarder would have skipped it. Leave it empty on
      // purpose: the page reads "no points were awarded", which is the truth.
      result.skipped += 1;
      continue;
    }

    const members = store.listHuddleMembers(callId);
    if (members.length === 0) {
      result.skipped += 1;
      continue;
    }

    // Use the stored intervals, never the first_seen/last_seen span. Passing no
    // attendance at all makes computeHuddleStats fall back to exactly the single
    // span that produced the original overcount, so a "reconstruction" built
    // that way would put the broken number back on the page.
    const attendance = store.computeHuddleAttendance(callId, {
      startedAt: huddle.started_at,
      endedAt: huddle.ended_at,
    });
    if (!attendance || (attendance.participants?.length ?? 0) === 0) {
      // No intervals were ever recorded, so there is nothing honest to rebuild
      // from. Say so on the page rather than inventing a figure.
      result.noAttendance += 1;
      continue;
    }

    const awards = computeHuddlePoints({
      huddle,
      members,
      attendance,
      participantHistory: parseParticipantHistory(huddle),
      // Intentionally null. The longest and shortest message were never kept, so
      // passing null leaves them out instead of guessing.
      messageStats: null,
    });
    if (awards.size === 0) {
      result.skipped += 1;
      continue;
    }
    // The page keys its "this was rebuilt" banner off this exact reason, so it
    // has to be written here or the page shows a total with no explanation of
    // where the number came from.
    for (const entry of awards.values()) {
      entry.reasons.push('backfilled');
    }
    store.saveHuddleAwards(callId, huddle.channel_id || '', awards);
    result.reconstructed += 1;
    if (result.reconstructed % batchLogEvery === 0) {
      logger.info?.(`[huddle-awards] reconstructed ${result.reconstructed} huddles so far`);
    }
  }

  logger.info?.(
    `[huddle-awards] reconstructed ${result.reconstructed}, already stored ${result.alreadyStored}, ` +
      `no attendance to rebuild from ${result.noAttendance}, ` +
      `skipped ${result.skipped} (no channel, or never ended)`,
  );
  return result;
}
