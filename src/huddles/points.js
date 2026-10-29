import { computeHuddleStats } from './review.js';

export const POINTS_PER_MINUTE = 1;
export const RANK_BONUS = [5, 3, 1];
export const LONGEST_MESSAGE_POINTS = 10;
export const SHORTEST_MESSAGE_POINTS = 10;
export const STARTER_POINTS = 5;

/**
 * Every way to earn points, in one place.
 *
 * The dashboard, the huddle page and the help copy all quote these numbers, so
 * they live here rather than being written into three strings that drift apart.
 */
export const POINT_RULES = [
  {
    kind: 'minutes',
    label: 'Time in the huddle',
    detail: '1 point for every minute, counting only the stretches Orbit can prove.',
  },
  {
    kind: 'rank',
    label: 'Top of the huddle',
    detail: '5 points for first by time, 3 for second, 1 for third.',
  },
  {
    kind: 'starter',
    label: 'Started the huddle',
    detail: '5 points for whoever opened it.',
  },
  {
    kind: 'message',
    label: 'Message bonus',
    detail: '10 points for the longest and 10 for the shortest message in the huddle thread.',
  },
];

/** The join/leave trail Slack recorded for a huddle, oldest first. */
export function parseParticipantHistory(huddle) {
  try {
    const parsed = JSON.parse(huddle?.participant_json ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Turn a stored `reasons` array into `{ kind, label, points }`.
 *
 * Awards written before this existed are bare strings ("12m", "rank 1"), and
 * they were stored without their individual value, so the value is rebuilt from
 * the rules that were in force at the time. That is exact for those rules: they
 * have not changed, only been written down.
 */
export function awardItems(reasons) {
  const list = Array.isArray(reasons) ? reasons : [];
  return list
    .map((reason) => {
      if (reason && typeof reason === 'object' && typeof reason.kind === 'string') {
        return {
          kind: reason.kind,
          label: String(reason.label ?? reason.kind),
          points: Number(reason.points) || 0,
        };
      }
      const text = String(reason ?? '');
      if (/^\d+m$/.test(text)) {
        return { kind: 'minutes', label: `${text} in the call`, points: Number(text.slice(0, -1)) };
      }
      if (/^rank [123]$/.test(text)) {
        return { kind: 'rank', label: text, points: RANK_BONUS[Number(text.slice(-1)) - 1] };
      }
      if (text === 'started the huddle') {
        return { kind: 'starter', label: text, points: STARTER_POINTS };
      }
      if (text === 'longest message') {
        return { kind: 'message', label: text, points: LONGEST_MESSAGE_POINTS };
      }
      if (text === 'shortest message') {
        return { kind: 'message', label: text, points: SHORTEST_MESSAGE_POINTS };
      }
      // "backfilled" is a marker on where the table came from, not an award.
      return { kind: 'other', label: text, points: 0 };
    })
    .filter((item) => item.label);
}

/**
 * Award points for an ended huddle. Called once when the huddle truly ends and
 * was being tracked. Returns a Map of userId -> { points, reasons } so callers
 * can persist the total (`awardHuddlePoints`) or log it.
 *
 * `reasons` is a list of `{ kind, label, points }`, so a huddle page can show
 * where every point came from instead of only the total.
 */
export function computeHuddlePoints({
  huddle,
  members = [],
  attendance = null,
  participantHistory = [],
  messageStats = null,
}) {
  const awards = new Map();
  const addPoints = (userId, points, kind, label) => {
    if (!userId || !points) {
      return;
    }
    const entry = awards.get(userId) ?? { points: 0, reasons: [] };
    entry.points += points;
    entry.reasons.push({ kind, label, points });
    awards.set(userId, entry);
  };

  if (!huddle?.started_at || !huddle?.ended_at) {
    return new Map();
  }

  const stats = computeHuddleStats({ huddle, members, attendance, participantHistory });
  // Points follow provable time, so a member whose join never closed still
  // scores the stretches we can demonstrate and nothing beyond them.
  const ranked = stats.participants.filter((participant) => (participant.provableSeconds ?? 0) > 0);
  const durationAwards = ranked.map((participant) => {
    const durationMinutes = Math.max(1, Math.floor(participant.provableSeconds / 60));
    return { userId: participant.userId, durationMinutes };
  });

  durationAwards.forEach(({ userId, durationMinutes }) => {
    addPoints(userId, durationMinutes * POINTS_PER_MINUTE, 'minutes', `${durationMinutes}m in the call`);
  });

  // Rank bonuses go only to people whose attendance is fully accounted for, so
  // a partial record can never win a place off someone else's missing events.
  const fullyTracked = ranked.filter((participant) => !participant.partial);
  fullyTracked.forEach((participant, index) => {
    const bonus = RANK_BONUS[index];
    if (bonus) {
      addPoints(participant.userId, bonus, 'rank', `rank ${index + 1}`);
    }
  });

  if (messageStats?.longest?.userId) {
    addPoints(messageStats.longest.userId, LONGEST_MESSAGE_POINTS, 'message', 'longest message');
  }
  if (messageStats?.shortest && messageStats.shortest.userId !== messageStats.longest?.userId) {
    addPoints(messageStats.shortest.userId, SHORTEST_MESSAGE_POINTS, 'message', 'shortest message');
  }

  addPoints(huddle.created_by, STARTER_POINTS, 'starter', 'started the huddle');

  return awards;
}
