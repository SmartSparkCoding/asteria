import { computeHuddlePoints, parseParticipantHistory } from '../huddles/points.js';

/**
 * huddle_channel_points is what a channel-scoped leaderboard reads, but it only
 * started being written at the same time as the lifetime total. Every huddle
 * scored before that has a lifetime score and no attributed copy, so a scoped
 * query sees nothing for it. Rather than let the board quietly fall back to
 * lifetime totals (which is how people from untracked channels showed up), we
 * recompute the attribution once from the huddles themselves.
 *
 * The recompute is honest about what it cannot know: the per-message longest /
 * shortest bonuses are not persisted, so a backfilled huddle scores duration,
 * rank and starter points only. New huddles are attributed at award time with
 * the full award, so the table converges on the real numbers as huddles happen.
 */
export function backfillChannelPoints(store, { logger, force = false } = {}) {
  if (!store?.rebuildHuddleChannelPoints || !store?.huddlePointTotals) {
    return null;
  }
  const before = store.huddlePointTotals();
  // Rebuild when there is a lifetime score that nothing has been attributed to.
  if (!force && !(before.lifetime > 0 && before.rows === 0)) {
    return null;
  }
  const result = store.rebuildHuddleChannelPoints((huddle, members) =>
    computeHuddlePoints({
      huddle,
      members,
      participantHistory: parseParticipantHistory(huddle),
      // deliberately omitted: messageStats are not persisted, so they cannot be
      // recomputed. See the note above.
      messageStats: null,
    }),
  );
  const after = store.huddlePointTotals();
  logger?.info?.(
    `Attributed huddle points to channels: ${result.rows} row(s) across ${result.huddles} huddle(s), ` +
      `${result.points} point(s) (lifetime total ${before.lifetime}, attributed ${after.attributed})`,
  );
  return { ...result, before, after };
}
