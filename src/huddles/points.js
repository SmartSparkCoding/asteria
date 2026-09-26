import { computeHuddleStats } from './review.js';

export const POINTS_PER_MINUTE = 1;
export const RANK_BONUS = [5, 3, 1];
export const LONGEST_MESSAGE_POINTS = 10;
export const SHORTEST_MESSAGE_POINTS = 10;
export const STARTER_POINTS = 5;

/**
 * Award points for an ended huddle. Called once when the huddle truly ends and
 * was being tracked. Returns a Map of userId -> { points, reasons } so callers
 * can persist the total (`awardHuddlePoints`) or log it.
 */
export function computeHuddlePoints({ huddle, members = [], participantHistory = [], messageStats = null }) {
  const awards = new Map();
  const addPoints = (userId, points, reason) => {
    if (!userId) {
      return;
    }
    const entry = awards.get(userId) ?? { points: 0, reasons: [] };
    entry.points += points;
    entry.reasons.push(reason);
    awards.set(userId, entry);
  };

  if (!huddle?.started_at || !huddle?.ended_at) {
    return new Map();
  }

  const stats = computeHuddleStats({ huddle, members, participantHistory });
  const ranked = stats.participants.filter((participant) => participant.durationSeconds != null);
  const durationAwards = ranked.map((participant) => {
    const durationMinutes = Math.max(1, Math.floor(participant.durationSeconds / 60));
    return { userId: participant.userId, durationMinutes };
  });

  durationAwards.forEach(({ userId, durationMinutes }) => {
    addPoints(userId, durationMinutes * POINTS_PER_MINUTE, `${durationMinutes}m`);
  });

  ranked.forEach((participant, index) => {
    const bonus = RANK_BONUS[index];
    if (bonus) {
      addPoints(participant.userId, bonus, `rank ${index + 1}`);
    }
  });

  if (messageStats?.longest?.userId) {
    addPoints(messageStats.longest.userId, LONGEST_MESSAGE_POINTS, 'longest message');
  }
  if (messageStats?.shortest && messageStats.shortest.userId !== messageStats.longest?.userId) {
    addPoints(messageStats.shortest.userId, SHORTEST_MESSAGE_POINTS, 'shortest message');
  }

  addPoints(huddle.created_by, STARTER_POINTS, 'started the huddle');

  return awards;
}
