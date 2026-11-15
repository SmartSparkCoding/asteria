import { DateTime } from 'luxon';

/**
 * Pass-through channels.
 *
 * A pass-through channel is one people can ask to be let into. The owner writes
 * the questions once. Someone presses the button in that channel, answers, and
 * Orbit announces the request in the main channel with the answers in the
 * thread, then runs an anonymous yes/no vote there. Who voted is stored (so
 * nobody votes twice) and never printed.
 */

export const VOTE_YES = 'yesyes';
export const VOTE_NO = 'no-no';

export const OPEN_REQUEST_ACTION = 'passthrough_request_open';
export const DECIDE_REQUEST_ACTION = 'passthrough_decide';

const MAX_QUESTIONS = 10;
const MAX_ANSWER_LENGTH = 500;

/**
 * One question per line. A line ending in `| required` must be answered before
 * the form will submit; everything else is optional.
 */
export function parseQuestionLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_QUESTIONS)
    .map((line, index) => {
      const [rawLabel, ...flags] = line.split('|');
      const required = flags.some((flag) => /^\s*required\s*$/i.test(flag));
      return { id: `q${index + 1}`, label: rawLabel.trim(), required };
    })
    .filter((question) => question.label)
    .map((question, index) => ({ ...question, id: `q${index + 1}` }));
}

export function formatQuestionLines(questions) {
  return (questions || [])
    .map((question) => (question.required ? `${question.label} | required` : question.label))
    .join('\n');
}

function channelLabel(channelId) {
  return channelId ? `<#${channelId}>` : 'the channel';
}

/** The message pinned in a pass-through channel that opens the form. */
export function buildAnchorMessage({ channelId, label = '', questionCount = 0 }) {
  const title = label ? `*${label}* (<#${channelId}>)` : `<#${channelId}>`;
  const questions = questionCount === 1 ? '1 question' : `${questionCount} questions`;
  return {
    text: `Want into ${channelLabel(channelId)}? Fill in the entry form and the owner will see your answers.`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:passport_control: *Want into ${title}?*\nFill in the entry form (${questions}) and the owner will see your answers. Nothing is posted in the channel.`,
        },
      },
      {
        type: 'actions',
        block_id: 'passthrough_request_actions',
        elements: [
          {
            type: 'button',
            action_id: OPEN_REQUEST_ACTION,
            text: { type: 'plain_text', text: 'Fill in the entry form' },
            value: channelId,
            style: 'primary',
          },
        ],
      },
    ],
  };
}

export function buildRequestAnnouncement({ userId, channelId, requestId }) {
  return {
    text: `<@${userId}> wants access to ${channelLabel(channelId)}. The form answers are in this thread.`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:inbox_tray: *<@${userId}> wants access to ${channelLabel(channelId)}.*\nThe form answers and the vote are in this thread.`,
        },
      },
      {
        type: 'actions',
        block_id: 'passthrough_decide_actions',
        elements: [
          {
            type: 'button',
            action_id: DECIDE_REQUEST_ACTION,
            text: { type: 'plain_text', text: 'Approve and invite' },
            value: `${requestId}:approve`,
            style: 'primary',
          },
          {
            type: 'button',
            action_id: DECIDE_REQUEST_ACTION,
            text: { type: 'plain_text', text: 'Deny' },
            value: `${requestId}:deny`,
            style: 'danger',
          },
        ],
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: 'Only the channel owner can approve or deny.' }],
      },
    ],
  };
}

export function buildAnswersBlocks({ request }) {
  const when = request?.created_at
    ? DateTime.fromSQL(request.created_at, { zone: 'utc' }).toUTC().toFormat('d LLL yyyy, HH:mm')
    : '';
  const header = `*Entry form from <@${request.user_id}>*${when ? ` · ${when} UTC` : ''}`;
  const lines = (request.answers || []).map((entry) =>
    entry.answer ? `*${entry.question}*\n${entry.answer}` : `*${entry.question}*\n_not answered_`,
  );
  return [
    { type: 'section', text: { type: 'mrkdwn', text: header } },
    { type: 'divider' },
    ...(lines.length > 0
      ? lines.map((text) => ({ type: 'section', text: { type: 'mrkdwn', text } }))
      : [{ type: 'section', text: { type: 'mrkdwn', text: '_The form had no questions._' } }]),
  ];
}

export function tallyText(counts) {
  const yes = Number(counts?.yes) || 0;
  const no = Number(counts?.no) || 0;
  const total = yes + no;
  const noun = total === 1 ? 'vote' : 'votes';
  return `Yes *${yes}* · No *${no}* · ${total} ${noun} so far`;
}

export function buildVoteMessage({ request, counts }) {
  return {
    text: `Vote: should <@${request.user_id}> get access to ${channelLabel(request.channel_id)}? React :${VOTE_YES}: for yes or :${VOTE_NO}: for no.`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:ballot_box: *Vote:* should <@${request.user_id}> get access to ${channelLabel(request.channel_id)}?\nReact :${VOTE_YES}: for yes or :${VOTE_NO}: for no. Change your mind by reacting the other way. Only the tally is shown, never who voted.`,
        },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: tallyText(counts) }],
      },
    ],
  };
}

/** Where a request is announced: the channel's own choice, else the main channel. */
export function resolveMainChannel({ channel, settings, environment = {} }) {
  return channel?.main_channel_id || settings?.personal_channel_id || environment.personalChannelId || '';
}

function readAnswers(viewState, questions) {
  const values = viewState?.values || {};
  return questions.map((question) => {
    const block = values[`passthrough_answer_${question.id}`] || {};
    const input = block.passthrough_answer_value || {};
    return {
      question: question.label,
      answer: String(input.value ?? '')
        .trim()
        .slice(0, MAX_ANSWER_LENGTH),
    };
  });
}

export function registerPassthrough({ app, store, client, logger: givenLogger, ownerId, environment = {} }) {
  const logger = givenLogger || app.logger || console;
  const slack = client || app.client;

  async function refreshVoteMessage(requestId) {
    const request = store.getPassthroughRequest(requestId);
    if (!request?.vote_ts || !request.main_channel_id) {
      return;
    }
    const counts = store.countPassthroughVotes(request.id);
    try {
      await slack.chat.update({
        channel: request.main_channel_id,
        ts: request.vote_ts,
        ...buildVoteMessage({ request, counts }),
      });
    } catch (error) {
      logger.error(`Could not update the passthrough vote tally: ${error?.message || error}`);
    }
  }

  function applyReaction({ reaction, userId, itemChannel, itemTs }) {
    if (reaction !== VOTE_YES && reaction !== VOTE_NO) {
      return false;
    }
    const request = store.getPassthroughRequestByVoteTs(itemTs);
    if (!request || request.status !== 'open' || request.main_channel_id !== itemChannel) {
      return false;
    }
    if (userId === request.user_id) {
      // The person asking is not a voter on their own request.
      return false;
    }
    store.recordPassthroughVote(request.id, userId, reaction === VOTE_YES ? 'yes' : 'no');
    return true;
  }

  app.action({ action_id: OPEN_REQUEST_ACTION, type: 'block_actions' }, async ({ ack, body, client: actionClient }) => {
    await ack();
    const channelId = body?.actions?.[0]?.value || '';
    const channel = store.getPassthroughChannel(channelId);
    if (!channel) {
      return;
    }
    const { buildPassthroughRequestModal } = await import('../app-home/modals.js');
    await actionClient.views.open({
      trigger_id: body.trigger_id,
      view: buildPassthroughRequestModal({ channel }),
    });
  });

  app.view('passthrough_request_submit', async ({ ack, body, view, client: viewClient }) => {
    const channelId = view.private_metadata || '';
    const channel = store.getPassthroughChannel(channelId);
    const userId = body.user.id;
    if (!channel || !channel.enabled) {
      // The channel was removed or switched off while the form was open. There
      // is no field to point an error at, so close the modal and say why.
      await ack();
      await viewClient.chat.postMessage({
        channel: userId,
        text: `That entry form is no longer open${channelId ? ` for <#${channelId}>` : ''}. Nothing was sent.`,
      });
      return;
    }
    const answers = readAnswers(view.state, channel.questions || []);
    const missing = (channel.questions || []).filter((question, index) => question.required && !answers[index]?.answer);
    if (missing.length > 0) {
      await ack({
        response_action: 'errors',
        errors: Object.fromEntries(
          missing.map((question) => [`passthrough_answer_${question.id}`, 'This one is required.']),
        ),
      });
      return;
    }
    await ack();

    const alreadyOpen = store
      .listPassthroughRequests({ limit: 200, status: 'open' })
      .find((request) => request.channel_id === channelId && request.user_id === userId);
    if (alreadyOpen) {
      await viewClient.chat.postMessage({
        channel: userId,
        text: `You already have an open request for <#${channelId}>. Give the owner a moment to look at it.`,
      });
      return;
    }

    const settings = store.getSettings();
    const mainChannelId = resolveMainChannel({ channel, settings, environment });
    if (!mainChannelId) {
      logger.error('passthrough_request_unroutable: no main channel configured');
      await viewClient.chat.postMessage({
        channel: userId,
        text: 'I could not file that request: no main channel is set, so there is nowhere to announce it. Tell the owner.',
      });
      return;
    }

    const request = store.createPassthroughRequest({
      channelId,
      userId,
      answers,
      mainChannelId,
    });
    if (!request) {
      return;
    }

    try {
      const announcement = await slack.chat.postMessage({
        channel: mainChannelId,
        ...buildRequestAnnouncement({ userId, channelId, requestId: request.id }),
      });
      store.setPassthroughRequestMessages(request.id, {
        messageTs: announcement.ts,
        threadTs: announcement.ts,
      });
      await slack.chat.postMessage({
        channel: mainChannelId,
        thread_ts: announcement.ts,
        text: `Entry form from <@${userId}>`,
        blocks: buildAnswersBlocks({ request }),
      });
      const vote = await slack.chat.postMessage({
        channel: mainChannelId,
        thread_ts: announcement.ts,
        ...buildVoteMessage({ request, counts: { yes: 0, no: 0 } }),
      });
      store.setPassthroughRequestMessages(request.id, { voteTs: vote.ts });
      // Seed both reactions so the vote is one tap for everyone else, including
      // on mobile where a half-typed emoji name is a wall.
      for (const name of [VOTE_YES, VOTE_NO]) {
        try {
          await slack.reactions.add({ channel: mainChannelId, timestamp: vote.ts, name });
        } catch (error) {
          logger.warn(`Could not add :${name}: to the passthrough vote: ${error?.message || error}`);
        }
      }
      store.recordTriggerLog({
        userId,
        action: 'passthrough_request',
        detail: `${channelId}:${request.id}`,
        channelId,
      });
      await viewClient.chat.postMessage({
        channel: userId,
        text: `Your request for <#${channelId}> is in. The owner can see your answers and the vote in the thread.`,
      });
    } catch (error) {
      logger.error(`Could not announce a passthrough request: ${error?.message || error}`);
      await viewClient.chat.postMessage({
        channel: userId,
        text: `I saved your request for <#${channelId}> but could not post it in the main channel. Tell the owner.`,
      });
    }
  });

  app.action(
    { action_id: DECIDE_REQUEST_ACTION, type: 'block_actions' },
    async ({ ack, body, action, client: actionClient }) => {
      await ack();
      const [rawId, decision] = String(action?.value || '').split(':');
      const request = store.getPassthroughRequest(Number(rawId));
      if (!request) {
        return;
      }
      const settings = store.getSettings();
      const isOwner = body.user.id === (ownerId || settings.personal_channel_owner_id);
      if (!isOwner) {
        await actionClient.chat.postEphemeral({
          channel: request.main_channel_id,
          user: body.user.id,
          text: 'Only the channel owner can approve or deny a request.',
        });
        return;
      }

      if (decision === 'deny') {
        store.setPassthroughRequestStatus(request.id, 'denied');
        await slack.chat.postMessage({
          channel: request.main_channel_id,
          thread_ts: request.thread_ts || request.message_ts,
          text: `<@${request.user_id}>'s request for <#${request.channel_id}> was denied.`,
        });
        return;
      }

      try {
        await slack.conversations.invite({ channel: request.channel_id, users: request.user_id });
        store.setPassthroughRequestStatus(request.id, 'approved');
        await slack.chat.postMessage({
          channel: request.main_channel_id,
          thread_ts: request.thread_ts || request.message_ts,
          text: `:white_check_mark: <@${request.user_id}> was let into <#${request.channel_id}>.`,
        });
      } catch (error) {
        logger.error(`Could not invite a passthrough user: ${error?.message || error}`);
        await slack.chat.postMessage({
          channel: request.main_channel_id,
          thread_ts: request.thread_ts || request.message_ts,
          text: `I could not invite <@${request.user_id}> to <#${request.channel_id}>: \`${error?.data?.error || error?.message || 'unknown error'}\`. Invite them by hand, or give me the scope to do it.`,
        });
      }
    },
  );

  let botUserId = '';
  async function botId() {
    if (botUserId) {
      return botUserId;
    }
    try {
      const who = await slack.auth.test();
      botUserId = who?.user_id || '';
    } catch {
      botUserId = '';
    }
    return botUserId;
  }

  app.event('reaction_added', async ({ event }) => {
    const item = event?.item || {};
    if (item.type !== 'message' || !event?.user) {
      return;
    }
    // The two seed reactions on a fresh vote message are the bot's own, and the
    // bot is not a voter.
    if (event.user === (await botId())) {
      return;
    }
    const changed = applyReaction({
      reaction: event.reaction,
      userId: event.user,
      itemChannel: item.channel,
      itemTs: item.ts,
    });
    if (changed) {
      const request = store.getPassthroughRequestByVoteTs(item.ts);
      if (request) {
        await refreshVoteMessage(request.id);
      }
    }
  });

  app.event('reaction_removed', async ({ event }) => {
    const item = event?.item || {};
    if (item.type !== 'message') {
      return;
    }
    if (event.reaction !== VOTE_YES && event.reaction !== VOTE_NO) {
      return;
    }
    const request = store.getPassthroughRequestByVoteTs(item.ts);
    if (!request || request.status !== 'open') {
      return;
    }
    store.recordPassthroughVote(request.id, event.user, '');
    await refreshVoteMessage(request.id);
  });
}

export { MAX_ANSWER_LENGTH, MAX_QUESTIONS };
