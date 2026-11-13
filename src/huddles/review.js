import { DateTime } from 'luxon';

/**
 * Compute the stats shown in a huddle review from what we tracked.
 *
 * `attendance` is the interval based result from
 * `store.computeHuddleAttendance`, which is the only trustworthy source: each
 * entry is the sum of that person's *closed* presence intervals, so the gaps
 * between them are preserved. The old `members` span (first_seen_at to
 * last_seen_at) is used only for huddles recorded before intervals existed, and
 * marks them partial, because that span silently billed a 58 second appearance
 * as the whole call.
 *
 * `participantHistory` is the list of user IDs Slack reports ever joined the
 * huddle; anyone we never saw join is folded in with an unknown duration so
 * attendance stays complete.
 */
export function computeHuddleStats({ huddle, members, attendance = null, participantHistory = [] }) {
  const startedAt = huddle.started_at ?? 0;
  const endedAt = huddle.ended_at ?? null;

  const tracked = attendance?.participants ?? [];
  const fromIntervals = tracked.length > 0;

  const participants = fromIntervals
    ? tracked.map((entry) => ({
        userId: entry.userId,
        firstSeenAt: entry.intervals[0]?.from ?? null,
        lastSeenAt: entry.intervals.length ? entry.intervals[entry.intervals.length - 1].to : null,
        // A partial record still has a floor we can state. Reporting null here
        // printed "unknown" for somebody we had watched for five hours, while
        // the huddle page said "at least 5h" for the same person. Only a record
        // with nothing proven at all is genuinely unknown.
        durationSeconds: entry.seconds > 0 ? entry.seconds : null,
        provableSeconds: entry.seconds,
        partial: entry.partial,
        // Only an interval-derived duration is a floor. The legacy span below is
        // a guess in the other direction, so it must not be labelled "at least".
        durationIsFloor: entry.partial,
      }))
    : members.map((member) => {
        const durationSeconds =
          member.first_seen_at != null && member.last_seen_at != null
            ? Math.max(0, member.last_seen_at - member.first_seen_at)
            : member.first_seen_at != null && endedAt
              ? Math.max(0, endedAt - member.first_seen_at)
              : null;
        return {
          userId: member.user_id,
          firstSeenAt: member.first_seen_at ?? null,
          lastSeenAt: member.last_seen_at ?? null,
          durationSeconds,
          provableSeconds: durationSeconds ?? 0,
          partial: true,
        };
      });

  const knownIds = new Set(participants.map((participant) => participant.userId));
  for (const userId of participantHistory) {
    if (!knownIds.has(userId)) {
      participants.push({
        userId,
        firstSeenAt: null,
        lastSeenAt: null,
        durationSeconds: null,
        provableSeconds: 0,
        partial: true,
      });
    }
  }

  participants.sort((a, b) => {
    const aDuration = a.provableSeconds ?? -1;
    const bDuration = b.provableSeconds ?? -1;
    if (bDuration !== aDuration) {
      return bDuration - aDuration;
    }
    return (a.firstSeenAt ?? 0) - (b.firstSeenAt ?? 0);
  });

  const longestParticipant = [...participants]
    .filter((participant) => (participant.provableSeconds ?? -1) > 0)
    .sort((a, b) => {
      if (b.provableSeconds !== a.provableSeconds) {
        return b.provableSeconds - a.provableSeconds;
      }
      return (a.firstSeenAt ?? 0) - (b.firstSeenAt ?? 0);
    })[0];

  const durationSeconds = startedAt && endedAt ? Math.max(0, endedAt - startedAt) : null;

  return {
    callId: huddle.call_id,
    channelId: huddle.channel_id || null,
    channelName: huddle.channel_name || '',
    createdBy: huddle.created_by || longestParticipant?.userId || null,
    startedAt,
    endedAt,
    durationSeconds,
    participants,
    longestParticipantId: longestParticipant?.userId ?? null,
    // True when some attendance could not be proven, either because a join was
    // never closed or because the huddle predates interval tracking. Surfaces
    // on the huddle page and keeps points to what can be demonstrated.
    attendancePartial: fromIntervals ? Boolean(attendance?.partial) : true,
  };
}

export function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) {
    return 'unknown';
  }
  const totalSeconds = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${remainingSeconds}s`;
  }
  if (remainingSeconds === 0) {
    return `${minutes}m`;
  }
  return `${minutes}m ${remainingSeconds}s`;
}

function formatTime(epochSeconds, timezone) {
  if (!epochSeconds) {
    return 'unknown';
  }
  return DateTime.fromSeconds(epochSeconds, { zone: timezone || 'UTC' }).toFormat('d LLL, HH:mm');
}

function channelLabel(stats) {
  if (!stats.channelId) {
    return 'a huddle';
  }
  if (stats.channelId.startsWith('D') || stats.channelId.startsWith('G')) {
    return 'a DM';
  }
  return stats.channelName ? `#${stats.channelName}` : `<#${stats.channelId}>`;
}

/**
 * Name someone for display, never as a Slack mention.
 *
 * A huddle review lists everyone who was in the call. Using <@U123> there turned
 * reading the stats into a notification for every single person on the call, so
 * the review names them in plain text instead. A missing name falls back to the
 * raw id, which is ugly but still pings nobody.
 */
function personLabel(userId, displayNames) {
  if (!userId) {
    return 'unknown';
  }
  return displayNames?.[userId] || userId;
}

export function formatHuddleReviewMessage(stats, { timezone = 'UTC', displayNames = {} } = {}) {
  const participantLines = stats.participants.map((participant) => {
    const isLongest = participant.userId === stats.longestParticipantId;
    // A partial record is a floor, so say so rather than presenting it as the
    // whole time. Same wording the huddle page uses.
    const durationLabel =
      participant.durationIsFloor && participant.durationSeconds != null
        ? `at least ${formatDuration(participant.durationSeconds)}`
        : formatDuration(participant.durationSeconds);
    const badge = isLongest ? ' *— longest in the huddle*' : '';
    return `• ${personLabel(participant.userId, displayNames)} — ${durationLabel}${badge}`;
  });

  const lines = [
    `🎧 *Huddle review* — ${channelLabel(stats)}`,
    '',
    `*Started by:* ${personLabel(stats.createdBy, displayNames)} · ${formatTime(stats.startedAt, timezone)}`,
    `*Ended:* ${formatTime(stats.endedAt, timezone)}`,
    `*Total duration:* ${formatDuration(stats.durationSeconds)}`,
    '',
    `*Attendance (${stats.participants.length}):*`,
    ...participantLines,
  ];

  if (stats.messageStats) {
    lines.push('', '*Huddle chat messages:*');
    if (stats.messageStats.longest) {
      lines.push(formatMessageStat('*Longest message:*', stats.messageStats.longest, displayNames));
    }
    if (stats.messageStats.shortest) {
      lines.push(formatMessageStat('*Shortest message:*', stats.messageStats.shortest, displayNames));
    }
  } else {
    lines.push('', '_No huddle chat messages were recorded._');
  }

  return lines.join('\n');
}

function formatMessageStat(label, stat, displayNames) {
  const snippet = stat.text ? ` — "${truncate(stat.text, 80)}"` : '';
  const link = stat.permalink ? ` <${stat.permalink}|view message>` : '';
  return `${label} ${stat.length} chars by ${personLabel(stat.userId, displayNames)}${snippet}${link}`;
}

function truncate(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}…`;
}

export function extractMessageText(message) {
  if (message.text) {
    return message.text;
  }
  const parts = [];
  for (const block of message.blocks ?? []) {
    if (block.type === 'rich_text') {
      for (const element of block.elements ?? []) {
        if (element.type === 'rich_text_section') {
          const textParts = [];
          for (const node of element.elements ?? []) {
            if (node.type === 'text') {
              textParts.push(node.text ?? '');
            }
          }
          parts.push(textParts.join(''));
        }
      }
    }
    if (block.type?.startsWith('section')) {
      parts.push(block.text?.text ?? '');
    }
  }
  return parts.filter(Boolean).join(' ').trim();
}

/**
 * Best-effort fetch of the huddle's chat thread to find the longest and
 * shortest messages. Only counts plain user messages by known participants sent
 * during the huddle window. Returns `{ longest, shortest }` (each `{ userId,
 * text, length, ts, permalink }`) or `null` when nothing qualifies or the
 * thread is unavailable. Never stores message text.
 */
export async function resolveHuddleThreadMessageStats({
  client,
  channelId,
  threadRootTs,
  startedAt,
  endedAt,
  memberIds,
}) {
  if (!channelId || !threadRootTs) {
    return null;
  }

  let messages;
  try {
    const replay = await client.conversations.replies({ channel: channelId, ts: threadRootTs, limit: 200 });
    messages = replay?.messages ?? [];
  } catch (_error) {
    return null;
  }

  const memberIdSet = new Set(memberIds ?? []);
  const inWindow = messages.filter((message) => {
    if (message.type !== 'message' || message.subtype) {
      return false;
    }
    if (memberIdSet.size > 0 && !memberIdSet.has(message.user)) {
      return false;
    }
    const messageTs = Number.parseFloat(message.ts);
    if (startedAt && messageTs < startedAt) {
      return false;
    }
    if (endedAt && messageTs > endedAt) {
      return false;
    }
    return true;
  });

  const measured = inWindow.map((message) => {
    const text = extractMessageText(message);
    return {
      userId: message.user,
      text,
      length: text.length,
      ts: message.ts,
    };
  });

  if (measured.length === 0) {
    return null;
  }

  const longest = measured.reduce((best, current) => (current.length > best.length ? current : best));
  const shortest = measured.reduce((best, current) => (current.length < best.length ? current : best));

  const withPermalinks = measured.filter((stat) => stat === longest || stat === shortest);
  await Promise.all(
    withPermalinks.map(async (stat) => {
      try {
        const permalinkResponse = await client.chat.getPermalink({
          channel: channelId,
          message_ts: stat.ts,
        });
        stat.permalink = permalinkResponse?.permalink ?? null;
      } catch {
        stat.permalink = null;
      }
    }),
  );

  return { longest, shortest };
}
