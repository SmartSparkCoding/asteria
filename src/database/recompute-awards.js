import { computeHuddlePoints, parseParticipantHistory } from '../huddles/points.js';

/**
 * Score ended huddles that have members but no award rows at all.
 *
 * This is not a backfill of guesses. A huddle only qualifies when it has a
 * `thread_root_ts`, which is proof the bot saw its thread message inside the
 * channel: Slack only delivers `message.channels` for channels the bot is in.
 * Those huddles were recorded and finalised but their awards never landed,
 * either because the bot had been removed from the channel by the time the
 * huddle ended, or because the run predates award attribution.
 *
 * Message bonus stats are not persisted, so a recomputed huddle scores duration,
 * rank and starter points only. That is the same honest ceiling the original
 * channel-point backfill used, and it is deliberately lower than a live award.
 *
 * Safe to run repeatedly: a huddle that already has any award is skipped.
 */
export function recomputeMissingHuddleAwards(store, { logger, dryRun = false } = {}) {
  const summary = { huddles: 0, users: 0, points: 0, skipped: 0, details: [] };

  for (const huddle of store.listHuddles()) {
    if (huddle.status !== 'ended' || !huddle.channel_id || !huddle.thread_root_ts) {
      summary.skipped += 1;
      continue;
    }
    if (!huddle.started_at || !huddle.ended_at) {
      summary.skipped += 1;
      continue;
    }
    if (store.listHuddleAwards(huddle.call_id).length > 0) {
      summary.skipped += 1;
      continue;
    }
    const members = store.listHuddleMembers(huddle.call_id);
    if (members.length === 0) {
      summary.skipped += 1;
      continue;
    }

    // Anyone still flagged as inside when the record says the call ended has
    // their interval closed at that end time, exactly like a live award.
    store.closeAllOpenHuddleAttendance(huddle.call_id, huddle.ended_at);
    const attendance = store.computeHuddleAttendance(huddle.call_id, {
      startedAt: huddle.started_at,
      endedAt: huddle.ended_at,
    });
    const awards = computeHuddlePoints({
      huddle,
      members,
      attendance,
      participantHistory: parseParticipantHistory(huddle),
      messageStats: null,
    });
    if (awards.size === 0) {
      summary.skipped += 1;
      continue;
    }

    let huddlePoints = 0;
    for (const entry of awards.values()) {
      huddlePoints += entry.points;
    }
    if (huddlePoints === 0) {
      summary.skipped += 1;
      continue;
    }

    summary.huddles += 1;
    summary.users += awards.size;
    summary.points += huddlePoints;
    summary.details.push({
      callId: huddle.call_id,
      channelId: huddle.channel_id,
      points: huddlePoints,
      users: [...awards.entries()].map(([userId, entry]) => ({ userId, points: entry.points })),
    });
    logger?.info?.(
      `${dryRun ? '[dry run] would score' : 'Scoring'} ${huddle.call_id} in ${huddle.channel_id}: ${huddlePoints} point(s) across ${awards.size} person/people`,
    );
    if (dryRun) {
      continue;
    }
    for (const [userId, entry] of awards) {
      store.awardHuddlePoints(userId, entry.points, huddle.channel_id);
    }
    store.saveHuddleAwards(huddle.call_id, huddle.channel_id, awards);
    store.recordTriggerLog({
      userId: '',
      action: 'huddle_awards_recomputed',
      detail: huddle.call_id,
      channelId: huddle.channel_id,
    });
  }

  return summary;
}
