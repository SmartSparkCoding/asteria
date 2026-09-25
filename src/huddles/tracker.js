import {
  computeHuddleStats,
  formatDuration,
  formatHuddleReviewMessage,
  resolveHuddleThreadMessageStats,
} from './review.js';
import { nextUserHuddleAction } from './state.js';

const GENERATE_REVIEW_ACTION_ID = 'generate_huddle_review';
const STALE_HUDDLE_SECONDS = 12 * 60 * 60;
const STALE_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

function parseParticipantHistory(huddle) {
  try {
    const parsed = JSON.parse(huddle?.participant_json ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function nowEpochSeconds() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Wire Asteria into Slack huddles. Presence comes from the workspace-wide
 * `user_huddle_changed` event; room metadata (channel, starter, timestamps,
 * thread) comes from `huddle_thread` messages. When a huddle ends the starter
 * is DMed for an optional huddle review.
 */
export function createHuddleTracker({ app, store, client, logger, ownerId = '' }) {
  function buildReviewPrompt(callId, duration) {
    return {
      text: 'Your huddle just ended. Want a huddle review?',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:headphones: Your huddle just ended (${formatDuration(duration)}). Want a *huddle review* with stats on attendance and the longest / shortest message in the huddle chat?`,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              action_id: GENERATE_REVIEW_ACTION_ID,
              text: { type: 'plain_text', text: 'Generate huddle review' },
              style: 'primary',
              value: callId,
            },
          ],
        },
      ],
    };
  }

  async function postReviewPromptToThread(huddle, duration) {
    if (!huddle.channel_id || !huddle.thread_root_ts) {
      return false;
    }
    try {
      await client.chat.postMessage({
        channel: huddle.channel_id,
        thread_ts: huddle.thread_root_ts,
        ...buildReviewPrompt(huddle.call_id, duration),
      });
      return true;
    } catch (error) {
      logger.warn?.(`Could not post huddle review prompt to thread for ${huddle.call_id}, falling back to DM`, error);
      return false;
    }
  }

  async function finalizeHuddle(callId, endedAt) {
    if (!store.setHuddleStatus(callId, 'ended', endedAt)) {
      return;
    }
    const huddle = store.getHuddle(callId);
    if (!huddle) {
      return;
    }
    const members = store.listHuddleMembers(callId);
    const recipient = pickReviewRecipient(huddle, members, ownerId);
    if (!recipient) {
      return;
    }
    const duration = huddle.started_at && endedAt ? Math.max(0, endedAt - huddle.started_at) : 0;
    if (await postReviewPromptToThread(huddle, duration)) {
      return;
    }
    try {
      await client.chat.postMessage({
        channel: recipient,
        ...buildReviewPrompt(huddle.call_id, duration),
      });
    } catch (error) {
      logger.error(`Failed to DM huddle review prompt for ${callId}`, error);
    }
  }

  async function applyJoin(userId, callId) {
    const joinedAt = nowEpochSeconds();
    store.setUserHuddleState({ userId, callId, isIn: true });
    if (!store.getHuddle(callId)) {
      store.upsertHuddle({ callId, startedAt: joinedAt });
    }
    store.upsertHuddleMember({
      callId,
      userId,
      firstSeenAt: joinedAt,
      lastSeenAt: joinedAt,
      isIn: true,
    });
  }

  async function applyLeave(userId, callId) {
    const leftAt = nowEpochSeconds();
    store.setUserHuddleState({ userId, callId: '', isIn: false });
    store.upsertHuddleMember({ callId, userId, firstSeenAt: null, lastSeenAt: leftAt, isIn: false });
    await finalizeHuddle(callId, leftAt);
  }

  async function handleUserHuddleChange({ event }) {
    const userId = event?.user?.id;
    if (!userId) {
      return;
    }
    const profile = event.user.profile ?? {};
    const prev = store.getUserHuddleState(userId);
    const actions = nextUserHuddleAction(prev, {
      huddleState: profile.huddle_state,
      callId: profile.huddle_state_call_id || prev.call_id || '',
    });
    for (const action of actions) {
      if (action.type === 'join') {
        await applyJoin(userId, action.callId);
      } else if (action.type === 'leave') {
        await applyLeave(userId, action.callId);
      }
    }
  }

  function handleHuddleThreadMessage(message) {
    const room = message?.room;
    if (room?.call_family !== 'huddle' || !room.id) {
      return;
    }
    const endedAt = room.date_end || null;
    store.upsertHuddle({
      callId: room.id,
      channelId: message.channel || room.channels?.[0] || '',
      createdBy: room.created_by || '',
      startedAt: room.date_start || 0,
      endedAt,
      threadRootTs: room.thread_root_ts || message.ts || '',
      participantHistory: room.participant_history || [],
    });
    if (endedAt) {
      void finalizeHuddle(room.id, endedAt);
    }
  }

  async function sweepStaleHuddles() {
    const cutoff = nowEpochSeconds() - STALE_HUDDLE_SECONDS;
    const stale = store.listStaleActiveHuddles(cutoff);
    for (const huddle of stale) {
      if (store.countActiveHuddleMembers(huddle.call_id) === 0) {
        await finalizeHuddle(huddle.call_id, huddle.started_at + STALE_HUDDLE_SECONDS);
      }
    }
  }

  let botUserIdPromise = null;

  function getBotUserId() {
    if (!client.auth?.test) {
      return Promise.resolve('');
    }
    botUserIdPromise ??= client.auth
      .test()
      .then((result) => result?.user_id || '')
      .catch((error) => {
        logger.error('Failed to resolve bot user id', error);
        return '';
      });
    return botUserIdPromise;
  }

  async function backfillChannelHuddles(channelId, actionClient) {
    const historyClient = actionClient ?? client;
    if (!historyClient.conversations?.history) {
      return;
    }
    try {
      const result = await historyClient.conversations.history({ channel: channelId, limit: 50 });
      for (const message of result?.messages ?? []) {
        if (message?.subtype === 'huddle_thread') {
          handleHuddleThreadMessage(message);
        }
      }
    } catch (error) {
      logger.error(`Failed to backfill huddle_thread messages for ${channelId}`, error);
    }
  }

  async function handleMemberJoinedChannel({ event, client: eventClient }) {
    if (!event?.channel || !event?.user || event.user !== (await getBotUserId())) {
      return;
    }
    await backfillChannelHuddles(event.channel, eventClient);
  }

  async function handleGenerateReview({ ack, body, client: actionClient }) {
    if (ack) {
      await ack();
    }
    const callId = body?.actions?.[0]?.value;
    if (!callId) {
      return;
    }
    const huddle = store.getHuddle(callId);
    if (!huddle) {
      await actionClient.chat.postMessage({
        channel: body?.user?.id,
        text: 'Sorry, I could not find that huddle anymore.',
      });
      return;
    }
    await generateReview({ huddle, recipientUserId: body?.user?.id, actionClient });
  }

  async function generateReview({ huddle, recipientUserId, actionClient }) {
    if (!recipientUserId) {
      return;
    }
    const members = store.listHuddleMembers(huddle.call_id);
    const stats = computeHuddleStats({
      huddle,
      members,
      participantHistory: parseParticipantHistory(huddle),
    });

    if (huddle.channel_id && huddle.thread_root_ts) {
      try {
        stats.messageStats = await resolveHuddleThreadMessageStats({
          client: actionClient,
          channelId: huddle.channel_id,
          threadRootTs: huddle.thread_root_ts,
          startedAt: huddle.started_at,
          endedAt: huddle.ended_at,
          memberIds: members.map((member) => member.user_id),
        });
      } catch (error) {
        logger.error(`Failed to resolve huddle chat stats for ${huddle.call_id}`, error);
        stats.messageStats = null;
      }
    } else {
      stats.messageStats = null;
    }

    const timezone = store.getSettings().timezone || 'UTC';
    const text = formatHuddleReviewMessage(stats, { timezone });

    await actionClient.chat.postMessage({
      channel: recipientUserId,
      text,
    });
  }

  app.event('user_huddle_changed', (payload) => {
    void handleUserHuddleChange(payload).catch((error) => {
      logger.error('Handle user_huddle_changed', error);
    });
  });

  app.action(GENERATE_REVIEW_ACTION_ID, (payload) => {
    void handleGenerateReview(payload).catch((error) => {
      logger.error('Generate huddle review', error);
    });
  });

  app.message((payload) => {
    const message = payload.message ?? payload;
    if (message?.subtype === 'huddle_thread') {
      try {
        handleHuddleThreadMessage(message);
      } catch (error) {
        logger.error('Handle huddle_thread message', error);
      }
    }
  });

  app.event('member_joined_channel', (payload) => {
    void handleMemberJoinedChannel(payload).catch((error) => {
      logger.error('Backfill huddles after joining a channel', error);
    });
  });

  const sweepTimer = setInterval(() => {
    void sweepStaleHuddles().catch((error) => {
      logger.error('Sweep stale huddles', error);
    });
  }, STALE_SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  return {
    GENERATE_REVIEW_ACTION_ID,
    stop() {
      clearInterval(sweepTimer);
    },
  };
}

function pickReviewRecipient(huddle, members, ownerId) {
  if (huddle.created_by) {
    return huddle.created_by;
  }
  if (ownerId && members.some((member) => member.user_id === ownerId)) {
    return ownerId;
  }
  const firstJoiner = [...members].sort((a, b) => (a.first_seen_at ?? 0) - (b.first_seen_at ?? 0))[0];
  return firstJoiner?.user_id ?? null;
}
