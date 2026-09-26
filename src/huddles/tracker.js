import { computeHuddlePoints } from './points.js';
import {
  computeHuddleStats,
  formatDuration,
  formatHuddleReviewMessage,
  resolveHuddleThreadMessageStats,
} from './review.js';
import { nextUserHuddleAction } from './state.js';

const GENERATE_REVIEW_ACTION_ID = 'generate_huddle_review';
const OPT_OUT_ACTION_ID = 'huddle_opt_out';
const TRACK_AGAIN_ACTION_ID = 'huddle_track_again';
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

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function nowEpochSeconds() {
  return Math.floor(Date.now() / 1000);
}

const DEFAULT_CHANNEL_RULES = {
  configured: false,
  enabled: true,
  paused: false,
  pausedUntil: 0,
  autoReplies: true,
  restrictTriggers: false,
  ownerIds: [],
};

function normalizeOwnerIds(value) {
  return Array.isArray(value) ? value.filter((id) => typeof id === 'string' && id) : [];
}

const SIX_SEVEN_JOKES = [
  'why was 6 afraid of 7? because 7 8 9 😭 :pet-brny:',
  'why did 6 break up with 7? because 6 ate 9 💀 :pet-brny:',
  'whats 7s favourite food? s7ew :freddie-confused: :pet-brny:',
  'why is 7 so good at tennis? it serves 6 🎾 :pet-brny:',
  'how does 7 get around? it catches the 6:15 bus 🚌 :pet-brny:',
  'what do you call a sick 7? s7niffles 🤧 :pet-brny:',
  'why wont 7 drive? the 6 oclock traffic 8s itself :freddie-confused: 🚦',
];

const SILLY_LINES = [
  'just a silly lil clanker, minding my own business :clanker: :freddie-silly:',
  'no huddles to roast right now. almost a shame :freddie-not-working:',
  'i am but a humble clanker with jokes :clanker: :freddie-no-glasses:',
  ...SIX_SEVEN_JOKES,
];

function pickRandom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function formatLongDuration(totalSeconds) {
  const total = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours === 0) {
    return `${minutes}m`;
  }
  if (minutes === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${minutes}m`;
}

function buildSillyReply(huddle) {
  if (!huddle) {
    return pickRandom(SILLY_LINES);
  }
  const duration = huddle.started_at
    ? formatLongDuration(Math.max(0, nowEpochSeconds() - huddle.started_at))
    : 'forever';
  const roasts = [
    `omg still in your *${duration}* long huddle. how sad. humans are sad :freddie-depression:`,
    `still in a huddle after *${duration}*?? go touch grass fr :freddie-silly: :freddie-no-glasses:`,
    `*${duration}* in a huddle and counting. the clankers have fully taken over :clanker: :freddie-confused:`,
    `you have been huddling for *${duration}*... i am judging you :freddie-depression: 🫠`,
  ];
  return pickRandom([...roasts, ...SIX_SEVEN_JOKES]);
}

/**
 * Wire Asteria into Slack huddles. Presence comes from the workspace-wide
 * `user_huddle_changed` event; room metadata (channel, starter, timestamps,
 * thread) comes from `huddle_thread` messages. When a huddle ends the starter
 * is DMed for an optional huddle review.
 */
export function createHuddleTracker({ app, store, client, logger, ownerId = '', botChannels }) {
  function buildReviewPrompt(callId, duration) {
    return {
      text: 'Your huddle just ended. Want a huddle review?',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `🎧 Your huddle just ended (${formatDuration(duration)}). Want a *huddle review* with stats on attendance and the longest / shortest message in the huddle chat?`,
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

  function buildOptOutPrompt(callId) {
    return {
      text: "Hi! FYI - i'm tracking your huddle for stats!",
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: "👋 Hi! FYI - i'm tracking your huddle for stats! If you'd prefer I didn't, press the button below!",
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              action_id: OPT_OUT_ACTION_ID,
              text: { type: 'plain_text', text: 'Opt out of tracking' },
              style: 'danger',
              value: callId,
            },
          ],
        },
      ],
    };
  }

  /**
   * Per-channel rules, configured from the app home. Unconfigured channels keep
   * the default behaviour: tracking on, auto replies on, anyone can trigger.
   */
  function channelRules(channelId) {
    const row = store.getHuddleChannel(channelId);
    if (!row) {
      return { ...DEFAULT_CHANNEL_RULES, tracking: true };
    }
    const pausedUntil = Number(row.paused_until) || 0;
    const paused = pausedUntil > nowEpochSeconds();
    const enabled = !!row.enabled;
    return {
      configured: true,
      enabled,
      paused,
      pausedUntil,
      autoReplies: enabled && !paused && !!row.auto_replies,
      restrictTriggers: !!row.restrict_triggers,
      ownerIds: normalizeOwnerIds(parseJsonArray(row.owner_ids)),
      tracking: enabled && !paused,
    };
  }

  function isChannelOwner(rules, userId) {
    if (!userId) {
      return false;
    }
    return rules.ownerIds.includes(userId);
  }

  function huddleChannelForThread(threadTs) {
    if (!threadTs) {
      return '';
    }
    return store.listHuddles().find((h) => h.thread_root_ts === threadTs)?.channel_id || '';
  }

  function mayTriggerInChannel(rules, userId) {
    if (!rules.restrictTriggers) {
      return true;
    }
    return isChannelOwner(rules, userId);
  }

  async function announceTrackingToThread(huddle) {
    if (!huddle.channel_id || !huddle.thread_root_ts) {
      return;
    }
    try {
      await client.chat.postMessage({
        channel: huddle.channel_id,
        thread_ts: huddle.thread_root_ts,
        ...buildOptOutPrompt(huddle.call_id),
      });
    } catch (error) {
      logger.warn?.(`Could not post huddle tracking notice for ${huddle.call_id}`, error);
    }
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
    const wasOptedOut = store.getHuddle(callId)?.status === 'opted_out';
    if (!store.setHuddleStatus(callId, 'ended', endedAt)) {
      return;
    }
    if (wasOptedOut) {
      return;
    }
    const huddle = store.getHuddle(callId);
    if (!huddle) {
      return;
    }
    await awardHuddlePoints(huddle);
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

  async function awardHuddlePoints(huddle) {
    if (!huddle?.started_at || !huddle?.ended_at) {
      return;
    }
    // Huddles we happen to observe in channels the bot was never in must not reach
    // the leaderboard. Channel-less huddles are DMs with the bot, so they always count.
    if (huddle.channel_id && botChannels) {
      const channelIds = await botChannels.list();
      if (!channelIds.includes(huddle.channel_id)) {
        if (channelIds.length === 0) {
          logger.error(`Could not verify which channels the bot is in; skipping points for huddle ${huddle.call_id}`);
        } else {
          logger.info(`Skipping points for huddle ${huddle.call_id}: the bot is not in ${huddle.channel_id}`);
        }
        return;
      }
    }
    const members = store.listHuddleMembers(huddle.call_id);
    if (members.length === 0) {
      return;
    }
    let messageStats = null;
    if (huddle.channel_id && huddle.thread_root_ts) {
      try {
        messageStats = await resolveHuddleThreadMessageStats({
          client,
          channelId: huddle.channel_id,
          threadRootTs: huddle.thread_root_ts,
          startedAt: huddle.started_at,
          endedAt: huddle.ended_at,
          memberIds: members.map((member) => member.user_id),
        });
      } catch (error) {
        logger.error(`Failed to resolve message stats for ${huddle.call_id}`, error);
      }
    }
    const awards = computeHuddlePoints({
      huddle,
      members,
      participantHistory: parseParticipantHistory(huddle),
      messageStats,
    });
    for (const [userId, entry] of awards) {
      store.awardHuddlePoints(userId, entry.points, huddle.channel_id || '');
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
    store.recordTriggerLog({
      userId,
      action: 'huddle_join',
      detail: callId,
      channelId: store.getHuddle(callId)?.channel_id || '',
    });
  }

  async function applyLeave(userId, callId) {
    const leftAt = nowEpochSeconds();
    store.setUserHuddleState({ userId, callId: '', isIn: false });
    store.upsertHuddleMember({ callId, userId, firstSeenAt: null, lastSeenAt: leftAt, isIn: false });
    store.recordTriggerLog({
      userId,
      action: 'huddle_leave',
      detail: callId,
      channelId: store.getHuddle(callId)?.channel_id || '',
    });
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
    const channelId = message.channel || room.channels?.[0] || '';
    const existing = store.getHuddle(room.id);
    const endedAt = room.date_end || null;
    const rules = channelRules(channelId || existing?.channel_id || '');
    store.upsertHuddle({
      callId: room.id,
      channelId,
      createdBy: room.created_by || '',
      startedAt: room.date_start || 0,
      endedAt,
      threadRootTs: room.thread_root_ts || message.ts || '',
      participantHistory: room.participant_history || [],
    });
    if (!rules.tracking) {
      // The channel has tracking off or paused: record the huddle silently so we
      // still have a timeline, but never announce it, review it or award points.
      if (!existing) {
        store.setHuddleOptedOut(room.id);
        store.recordTriggerLog({
          userId: '',
          action: rules.paused ? 'huddle_tracking_paused' : 'huddle_tracking_disabled',
          detail: room.id,
          channelId,
        });
      } else if (store.getHuddle(room.id)?.status === 'active') {
        // tracking was switched off while this huddle was already running
        store.setHuddleOptedOut(room.id);
      }
      if (endedAt) {
        void finalizeHuddle(room.id, endedAt);
      }
      return;
    }
    if (!existing && !endedAt) {
      void announceTrackingToThread(store.getHuddle(room.id));
    }
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

  async function handleHuddleMention({ message, channel, client: eventClient }) {
    const threadTs = message?.thread_ts ?? '';
    const botUserId = await getBotUserId();
    if (!threadTs && !botUserId) {
      return;
    }
    if (!botUserId || !message?.text?.includes(`<@${botUserId}>`)) {
      return;
    }
    const replyClient = eventClient ?? client;
    const channelId = message.channel ?? channel ?? huddleChannelForThread(threadTs);
    const rules = channelRules(channelId);
    if (!rules.autoReplies) {
      return;
    }
    if (!mayTriggerInChannel(rules, message?.user || '')) {
      store.recordTriggerLog({
        userId: message?.user || '',
        action: 'silly_request_denied',
        detail: 'not a channel owner',
        channelId,
      });
      return;
    }
    const huddle = store.listHuddles().find((h) => h.thread_root_ts === threadTs);
    store.recordTriggerLog({
      userId: message?.user || '',
      action: 'silly_request',
      detail: threadTs || channelId,
      channelId,
    });
    const postReply = async (textOrBlocks) => {
      const updatePayload = {
        ...(typeof textOrBlocks === 'string' ? { text: textOrBlocks } : textOrBlocks),
      };
      if (huddle?.channel_id && huddle?.thread_root_ts && huddle?.last_reply_ts) {
        try {
          await replyClient.chat.update({
            channel: huddle.channel_id,
            ts: huddle.last_reply_ts,
            ...updatePayload,
          });
          return null;
        } catch {
          // fall back to a fresh reply
        }
      }
      const response = await replyClient.chat.postMessage({
        channel: message.channel ?? channel,
        ...{ ...(threadTs ? { thread_ts: threadTs } : {}) },
        ...updatePayload,
      });
      if (huddle && response?.ts) {
        store.setHuddleLastReplyTs(huddle.call_id, response.ts);
      }
      return response;
    };

    if (huddle?.status === 'active') {
      await postReply(buildSillyReply(huddle));
      return;
    }
    if (huddle?.status === 'opted_out') {
      await postReply({
        text: '👀 hii - do you want me to track again?',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '👀 hii - i stopped tracking this one. do you want me to track again? :pet-freddie:',
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                action_id: TRACK_AGAIN_ACTION_ID,
                text: { type: 'plain_text', text: 'Track again' },
                style: 'primary',
                value: huddle.call_id,
              },
            ],
          },
        ],
      });
      return;
    }
    if (huddle && huddle.status !== 'active') {
      await postReply({
        text: "that huddle's already over - nothing to track 💀 :freddie-sleeping:. @ me again when the next one starts!",
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: "that huddle's already over 💀 :freddie-sleeping: - or is it? press it if it's actually still going:",
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                action_id: TRACK_AGAIN_ACTION_ID,
                text: { type: 'plain_text', text: 'Track again' },
                style: 'primary',
                value: huddle.call_id,
              },
            ],
          },
        ],
      });
      return;
    }
    const trackedHuddle = store.listHuddles().find((h) => h.status === 'active');
    await postReply(buildSillyReply(trackedHuddle || null));
  }

  async function isHuddleStillLive(huddle, actionClient) {
    if (!huddle?.channel_id || !huddle?.thread_root_ts) {
      return true;
    }
    try {
      const reply = await actionClient.conversations.replies({
        channel: huddle.channel_id,
        ts: huddle.thread_root_ts,
        limit: 1,
      });
      const root = reply?.messages?.[0];
      return !(root?.room?.date_end ?? 0);
    } catch {
      return true;
    }
  }

  async function handleTrackAgain({ ack, body, client: actionClient }) {
    if (ack) {
      await ack();
    }
    const callId = body?.actions?.[0]?.value;
    if (!callId) {
      return;
    }
    const userId = body?.user?.id || '';
    const ts = body?.message?.thread_ts || body?.message?.ts;
    const channelId = body?.container?.channel_id ?? body?.channel?.id;
    const huddle = store.getHuddle(callId);
    const rules = channelRules(huddle?.channel_id || channelId || '');
    if (!mayTriggerInChannel(rules, userId)) {
      store.recordTriggerLog({
        userId,
        action: 'huddle_track_again_denied',
        detail: 'not a channel owner',
        channelId: huddle?.channel_id || channelId || '',
      });
      await declineTrackAgain({
        actionClient,
        channelId,
        ts,
        text: 'only the channel owners I was given can ask me to track a huddle here',
      });
      return;
    }
    if (!rules.tracking) {
      store.recordTriggerLog({
        userId,
        action: 'huddle_track_again_denied',
        detail: rules.paused ? 'tracking paused' : 'tracking disabled',
        channelId: huddle?.channel_id || channelId || '',
      });
      await declineTrackAgain({
        actionClient,
        channelId,
        ts,
        text: rules.paused
          ? 'tracking is paused in this channel right now, so im staying quiet :zipper-mouth:'
          : 'tracking is turned off in this channel, so im staying quiet :zipper-mouth:',
      });
      return;
    }
    const stillLive = await isHuddleStillLive(huddle, actionClient);
    if (!stillLive) {
      store.recordTriggerLog({
        userId,
        action: 'huddle_track_again_denied',
        detail: callId,
        channelId: huddle?.channel_id || channelId || '',
      });
      await declineTrackAgain({
        actionClient,
        channelId,
        ts,
        text: "that huddle's already over 💀 :freddie-sleeping: - nothing to track",
      });
      return;
    }
    const reactivated = store.reactivateHuddle(callId);
    if (!reactivated && store.getHuddle(callId)?.status !== 'active') {
      return;
    }
    store.recordTriggerLog({
      userId,
      action: 'huddle_track_again',
      detail: callId,
      channelId: huddle?.channel_id || channelId || '',
    });
    if (ts && channelId) {
      try {
        await actionClient.chat.update({
          channel: channelId,
          ts,
          text: `thanks <@${userId}> for clicking me! im tracking again 💚 :freddie-working:`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `thanks <@${userId}> for clicking me! im tracking again 💚 :freddie-working:`,
              },
            },
          ],
        });
      } catch (error) {
        logger.error(`Failed to confirm huddle tracking for ${callId}`, error);
      }
    }
  }

  async function declineTrackAgain({ actionClient, channelId, ts, text }) {
    if (!ts || !channelId) {
      return;
    }
    try {
      await actionClient.chat.update({
        channel: channelId,
        ts,
        text,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
      });
    } catch (error) {
      logger.error(`Failed to decline huddle re-tracking in ${channelId}`, error);
    }
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
    const rules = channelRules(huddle.channel_id || body?.container?.channel_id || '');
    if (!mayTriggerInChannel(rules, body?.user?.id || '')) {
      store.recordTriggerLog({
        userId: body?.user?.id,
        action: 'huddle_review_denied',
        detail: 'not a channel owner',
        channelId: huddle.channel_id || body?.container?.channel_id || '',
      });
      await actionClient.chat.postMessage({
        channel: body?.user?.id,
        text: 'only the channel owners I was given can ask me for a review in that channel',
      });
      return;
    }
    await generateReview({ huddle, recipientUserId: body?.user?.id, actionClient });
    store.recordTriggerLog({
      userId: body?.user?.id,
      action: 'huddle_review_generated',
      detail: callId,
      channelId: huddle.channel_id || body?.container?.channel_id || body?.channel?.id || '',
    });
    const promptTs = body?.message?.ts;
    const promptChannelId = body?.container?.channel_id ?? body?.channel?.id;
    if (promptTs && promptChannelId) {
      try {
        await actionClient.chat.update({
          channel: promptChannelId,
          ts: promptTs,
          text: 'Huddle review posted above ⬆️',
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: 'Huddle review posted 🫡',
              },
            },
          ],
        });
      } catch (error) {
        logger.warn?.(`Could not update huddle review prompt for ${callId}`, error);
      }
    }
  }

  async function generateReview({ huddle, recipientUserId, actionClient }) {
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

    if (huddle.channel_id && huddle.thread_root_ts) {
      await actionClient.chat.postMessage({
        channel: huddle.channel_id,
        thread_ts: huddle.thread_root_ts,
        text,
      });
      return;
    }
    if (!recipientUserId) {
      return;
    }
    await actionClient.chat.postMessage({
      channel: recipientUserId,
      text,
    });
  }

  async function handleOptOut({ ack, body, client: actionClient }) {
    if (ack) {
      await ack();
    }
    const callId = body?.actions?.[0]?.value;
    if (!callId) {
      return;
    }
    if (!store.setHuddleOptedOut(callId)) {
      return;
    }
    store.recordTriggerLog({
      userId: body?.user?.id,
      action: 'huddle_opt_out',
      detail: callId,
      channelId: store.getHuddle(callId)?.channel_id || body?.container?.channel_id || body?.channel?.id || '',
    });
    const ts = body?.message?.ts;
    const channelId = body?.container?.channel_id ?? body?.channel?.id;
    if (ts && channelId) {
      try {
        await actionClient.chat.update({
          channel: channelId,
          ts,
          text: 'Okay — no stats or review for this huddle.',
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: "🔕 Okay — I've stopped tracking this huddle. No stats, and no review prompt when it ends.",
              },
            },
          ],
        });
      } catch (error) {
        logger.warn?.(`Could not update huddle opt-out message for ${callId}`, error);
      }
    }
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

  app.action(OPT_OUT_ACTION_ID, (payload) => {
    void handleOptOut(payload).catch((error) => {
      logger.error('Opt out of huddle tracking', error);
    });
  });

  app.action(TRACK_AGAIN_ACTION_ID, (payload) => {
    void handleTrackAgain(payload).catch((error) => {
      logger.error('Re-enable huddle tracking', error);
    });
  });

  app.message((payload) => {
    const message = payload.message ?? payload.event ?? payload;
    if (message?.subtype === 'huddle_thread') {
      try {
        handleHuddleThreadMessage(message);
      } catch (error) {
        logger.error('Handle huddle_thread message', error);
      }
    }
    void handleHuddleMention({
      message,
      channel: payload.channel,
      client: payload.client,
    }).catch((error) => {
      logger.error('Handle huddle mention', error);
    });
  });

  app.event('message_changed', (payload) => {
    const message = payload?.message;
    if (message?.subtype !== 'huddle_thread' || !message?.room?.id) {
      return;
    }
    try {
      handleHuddleThreadMessage(message);
    } catch (error) {
      logger.error('Handle huddle_thread close message', error);
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
    OPT_OUT_ACTION_ID,
    TRACK_AGAIN_ACTION_ID,
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
