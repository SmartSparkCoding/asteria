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
// Slack refuses a whole message as `invalid_blocks` when two elements in one
// actions block share an action_id, so every button gets its own.
export const VOTE_YES_ACTION = 'passthrough_vote_yes';
export const VOTE_NO_ACTION = 'passthrough_vote_no';
export const DECIDE_APPROVE_ACTION = 'passthrough_decide_approve';
export const DECIDE_DENY_ACTION = 'passthrough_decide_deny';

const MAX_QUESTIONS = 10;
const MAX_ANSWER_LENGTH = 500;
/** Slack refuses a section whose mrkdwn is longer than this. */
const MAX_SECTION = 2900;

/** How long someone waits after a denial before the form opens for them again. */
export const REAPPLY_DAYS = 10;

/**
 * When a denied person may try again, or null if they are free to apply now.
 * `decided_at` is a SQL timestamp; a request denied before that column existed
 * falls back to when it was filed.
 */
export function reapplyAt({ request, now = DateTime.utc() }) {
  if (!request || request.status !== 'denied') {
    return null;
  }
  const decided = DateTime.fromSQL(request.decided_at || request.created_at || '', { zone: 'utc' });
  if (!decided.isValid) {
    return null;
  }
  const until = decided.plus({ days: REAPPLY_DAYS });
  return until > now ? until : null;
}

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

/**
 * A button carries the channel it belongs to, who the form is for, and whether
 * it is a test. `channelId|userId|test`.
 */
export function encodeOpenValue({ channelId, targetUserId = '', test = false }) {
  return [channelId, targetUserId, test ? 'test' : ''].join('|');
}

export function parseOpenValue(value) {
  const parts = String(value || '').split('|');
  return {
    channelId: parts[0] || '',
    targetUserId: parts[1] || '',
    test: parts[2] === 'test',
  };
}

/**
 * Modal private_metadata is a string, and a form opened from a join message has
 * to keep remembering who it belongs to. Older buttons only had the channel id,
 * so a bare id still parses.
 */
export function encodeRequestMeta({ channelId, targetUserId = '', test = false }) {
  return JSON.stringify({ channelId, targetUserId, test });
}

export function parseRequestMeta(raw) {
  const text = String(raw || '').trim();
  if (!text.startsWith('{')) {
    return { channelId: text, targetUserId: '', test: false };
  }
  try {
    const parsed = JSON.parse(text);
    return {
      channelId: String(parsed?.channelId || ''),
      targetUserId: String(parsed?.targetUserId || ''),
      test: Boolean(parsed?.test),
    };
  } catch {
    return { channelId: '', targetUserId: '', test: false };
  }
}

/**
 * The per-person message Orbit posts when someone joins a pass-through channel.
 * The button value names them, so the form only opens for the person it was
 * written for.
 */
export function buildJoinMessage({ channelId, userId, label = '', questionCount = 0, test = false }) {
  const target = label ? `*${label}* (<#${channelId}>)` : `<#${channelId}>`;
  const questions = questionCount === 1 ? '1 question' : `${questionCount} questions`;
  const body = test
    ? `:passport_control: *Test entry form for ${target}.*\nThis is a test, <@${userId}>. Fill it in (${questions}) and Orbit will show you exactly what the owner sees. Nothing is announced and nobody votes on it.`
    : `:passport_control: *Welcome, <@${userId}>.*\nBefore you go any further, fill in the entry form for ${target} (${questions}). It takes a minute, and only the owner sees your answers.`;
  return {
    text: test
      ? `Test entry form for ${channelLabel(channelId)}.`
      : `Welcome <@${userId}>. Fill in the entry form for ${channelLabel(channelId)} to ask for access.`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: body } },
      {
        type: 'actions',
        block_id: 'passthrough_request_actions',
        elements: [
          {
            type: 'button',
            action_id: OPEN_REQUEST_ACTION,
            text: { type: 'plain_text', text: test ? 'Try the entry form' : 'Fill in the entry form' },
            value: encodeOpenValue({ channelId, targetUserId: userId, test }),
            style: 'primary',
          },
        ],
      },
    ],
  };
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

/**
 * The one-line announcement in the main channel. Deliberately short: the answers
 * and the vote live in the thread, so the channel itself stays readable.
 */
export function buildRequestAnnouncement({ userId, channelId }) {
  return {
    text: `<@${userId}> wants to join ${channelLabel(channelId)}! See the thread for details.`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:inbox_tray: *<@${userId}> wants to join ${channelLabel(channelId)}!* See the thread for details.`,
        },
      },
    ],
  };
}

/** The owner-only message that ends a request. */
export function buildDecisionMessage({ request, ownerId = '' }) {
  const who = ownerId ? `<@${ownerId}>` : 'the channel manager';
  return {
    text: `Final say for ${who}: should <@${request.user_id}> join ${channelLabel(request.channel_id)}?`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:scales: *Final say for ${who}.* Approve or deny <@${request.user_id}> for ${channelLabel(request.channel_id)}.`,
        },
      },
      {
        type: 'actions',
        block_id: 'passthrough_decide_actions',
        elements: [
          {
            type: 'button',
            action_id: DECIDE_APPROVE_ACTION,
            text: { type: 'plain_text', text: 'Approve and invite' },
            value: `${request.id}:approve`,
            style: 'primary',
          },
          {
            type: 'button',
            action_id: DECIDE_DENY_ACTION,
            text: { type: 'plain_text', text: 'Deny' },
            value: `${request.id}:deny`,
            style: 'danger',
          },
        ],
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: 'Only the channel manager can press these.' }],
      },
    ],
  };
}

/** What the decision message turns into once it has been pressed. */
export function buildDecisionResult({ request, decision, byUserId = '' }) {
  const who = byUserId ? `<@${byUserId}>` : 'The channel manager';
  const verdict = decision === 'approve' ? 'approved' : 'denied';
  return {
    text: `${who} ${verdict} <@${request.user_id}> for ${channelLabel(request.channel_id)}.`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${decision === 'approve' ? ':white_check_mark:' : ':no_entry:'} ${who} ${verdict} <@${request.user_id}> for ${channelLabel(request.channel_id)}.`,
        },
      },
    ],
  };
}

/**
 * Slack rejects a whole message with `invalid_blocks` over one stray control
 * character or one over-long section, so text is cleaned and cut first.
 */
export function cleanText(value, limit = MAX_SECTION) {
  let out = '';
  for (const char of String(value ?? '')) {
    const code = char.codePointAt(0);
    // Tabs and newlines are fine; the rest of the control range is not.
    if ((code < 32 && code !== 9 && code !== 10) || code === 127) {
      continue;
    }
    out += char;
  }
  return out.slice(0, limit);
}

/** The plain-text version of a block message, for when Slack refuses the blocks. */
export function blocksToText(blocks, fallback = '') {
  const parts = (blocks || [])
    .map((block) => {
      if (block?.text?.text) {
        return block.text.text;
      }
      if (Array.isArray(block?.elements)) {
        return block.elements
          .map((element) => element?.text?.text || (typeof element?.text === 'string' ? element.text : ''))
          .filter(Boolean)
          .join(' · ');
      }
      return '';
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join('\n\n') : fallback;
}

export function buildAnswersBlocks({ request }) {
  const when = request?.created_at
    ? DateTime.fromSQL(request.created_at, { zone: 'utc' }).toUTC().toFormat('d LLL yyyy, HH:mm')
    : '';
  const header = `*Entry form from <@${request.user_id}>*${when ? ` · ${when} UTC` : ''}`;
  const lines = (request.answers || []).map((entry) => {
    const question = cleanText(entry?.question, 300);
    const answer = cleanText(entry?.answer, MAX_ANSWER_LENGTH);
    return answer ? `*${question}*\n${answer}` : `*${question}*\n_not answered_`;
  });
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
    text: `Vote: should <@${request.user_id}> join ${channelLabel(request.channel_id)}? ${tallyText(counts)}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:ballot_box: *Should <@${request.user_id}> join ${channelLabel(request.channel_id)}?*\nPress a button. The tally updates here, and nobody can see how you voted.`,
        },
      },
      {
        type: 'actions',
        block_id: 'passthrough_vote_actions',
        elements: [
          {
            type: 'button',
            action_id: VOTE_YES_ACTION,
            text: { type: 'plain_text', text: 'Yes' },
            value: `${request.id}:yes`,
            style: 'primary',
          },
          {
            type: 'button',
            action_id: VOTE_NO_ACTION,
            text: { type: 'plain_text', text: 'No' },
            value: `${request.id}:no`,
            style: 'danger',
          },
        ],
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: tallyText(counts) }] },
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

  /**
   * Slack answers `invalid_blocks` for the whole message over one stray control
   * character or one over-long section, which used to leave a request announced
   * with a half-built thread. Log the payload, then post the same words as plain
   * text so the request still finishes.
   */
  async function postBlocks({ channel, thread_ts, text, blocks }) {
    try {
      return await slack.chat.postMessage({ channel, thread_ts, text, blocks });
    } catch (error) {
      if (error?.data?.error !== 'invalid_blocks') {
        throw error;
      }
      // Slack names the offending field in response_metadata.messages.
      const why = (error?.data?.response_metadata?.messages || []).join('; ');
      logger.error(`invalid_blocks in ${channel}${why ? ` (${why})` : ''}: ${JSON.stringify(blocks).slice(0, 1200)}`);
      return await slack.chat.postMessage({
        channel,
        thread_ts,
        text: blocksToText(blocks, text),
      });
    }
  }

  /**
   * Getting someone in: join the channel if we are not in it, then invite them.
   * A private channel cannot be joined, and a missing scope shows up on the
   * invite, which is the error worth reporting.
   */
  async function inviteUser(channelId, userId) {
    try {
      await slack.conversations.join({ channel: channelId });
    } catch {
      // Already in it, private, or no scope to join. The invite below is the
      // call whose error is worth surfacing.
    }
    try {
      await slack.conversations.invite({ channel: channelId, users: userId });
    } catch (error) {
      if (error?.data?.error === 'already_in_channel') {
        return;
      }
      throw error;
    }
  }

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
    const { channelId, targetUserId, test } = parseOpenValue(body?.actions?.[0]?.value);
    const channel = store.getPassthroughChannel(channelId);
    if (!channel || !channel.enabled) {
      await actionClient.chat
        .postEphemeral({
          channel: body.channel?.id || channelId,
          user: body.user.id,
          text: 'That entry form is not open right now.',
        })
        .catch(() => {});
      return;
    }
    if (targetUserId && body.user.id !== targetUserId) {
      // The join message names one person. Anyone else pressing it gets told,
      // rather than filling in a form that was never theirs.
      await actionClient.chat
        .postEphemeral({
          channel: body.channel?.id || channelId,
          user: body.user.id,
          text: `That form is <@${targetUserId}>'s. Join <#${channelId}> to get your own, or ask the owner to send you one.`,
        })
        .catch(() => {});
      return;
    }
    const { buildPassthroughRequestModal } = await import('../app-home/modals.js');
    await actionClient.views.open({
      trigger_id: body.trigger_id,
      view: buildPassthroughRequestModal({
        channel,
        meta: encodeRequestMeta({ channelId, targetUserId, test }),
      }),
    });
  });

  app.view('passthrough_request_submit', async ({ ack, body, view, client: viewClient }) => {
    const meta = parseRequestMeta(view.private_metadata);
    const channelId = meta.channelId;
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

    if (meta.test) {
      // A test run: the owner sees exactly what a real submission looks like,
      // and nothing is filed, announced or voted on.
      const owner = ownerId || store.getSettings().personal_channel_owner_id;
      const preview = { user_id: userId, channel_id: channelId, answers, created_at: null };
      if (owner) {
        await viewClient.chat
          .postMessage({
            channel: owner,
            text: `Test entry form from <@${userId}> for <#${channelId}>. Nothing was filed.`,
            blocks: buildAnswersBlocks({ request: preview }),
          })
          .catch((error) => logger.warn(`Could not DM the test form: ${error?.message || error}`));
      }
      await viewClient.chat
        .postMessage({ channel: userId, text: 'That was the test. Nothing was announced and no request was filed.' })
        .catch(() => {});
      return;
    }

    // A denial starts a wait. Anyone else, including someone with a request
    // already open, can fill the form in as many times as they like.
    const lastDenied = store.getLatestPassthroughRequest({ channelId, userId, status: 'denied' });
    const waitUntil = reapplyAt({ request: lastDenied });
    if (waitUntil) {
      await viewClient.chat.postMessage({
        channel: userId,
        text: `Your last request for <#${channelId}> was denied, so the form opens again on ${waitUntil.toFormat('d LLL yyyy')}. Nothing was sent.`,
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

    // Each step is tracked so a failure can say what actually broke. The old
    // catch-all blamed the main channel for anything that went wrong after it.
    let step = 'announce';
    try {
      const announcement = await postBlocks({
        channel: mainChannelId,
        ...buildRequestAnnouncement({ userId, channelId }),
      });
      step = 'record';
      store.setPassthroughRequestMessages(request.id, {
        messageTs: announcement.ts,
        threadTs: announcement.ts,
      });
      step = 'answers';
      await postBlocks({
        channel: mainChannelId,
        thread_ts: announcement.ts,
        text: `Entry form from <@${userId}>`,
        blocks: buildAnswersBlocks({ request }),
      });
      step = 'vote';
      const vote = await postBlocks({
        channel: mainChannelId,
        thread_ts: announcement.ts,
        ...buildVoteMessage({ request, counts: { yes: 0, no: 0 } }),
      });
      store.setPassthroughRequestMessages(request.id, { voteTs: vote.ts });
      step = 'decide';
      const manager = ownerId || settings.personal_channel_owner_id;
      const decision = await postBlocks({
        channel: mainChannelId,
        thread_ts: announcement.ts,
        ...buildDecisionMessage({ request, ownerId: manager }),
      });
      store.setPassthroughRequestMessages(request.id, { decisionTs: decision.ts });
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
      const code = error?.data?.error || error?.message || 'unknown error';
      logger.error(`passthrough_request_failed step=${step} channel=${mainChannelId}: ${code}`);
      const announced = step !== 'announce';
      await viewClient.chat
        .postMessage({
          channel: userId,
          text: announced
            ? `Your request for <#${channelId}> is posted in <#${mainChannelId}>, but I could not finish the thread: \`${code}\`. Tell the owner.`
            : `I saved your request for <#${channelId}> but Slack would not let me post in <#${mainChannelId}>: \`${code}\`. Tell the owner.`,
        })
        .catch(() => {});
      if (!announced) {
        // The announcement never landed, so the owner would never see this.
        const owner = ownerId || settings.personal_channel_owner_id;
        if (owner) {
          await slack.chat
            .postMessage({
              channel: owner,
              text: `Request #${request.id} from <@${userId}> for <#${channelId}> could not be posted in <#${mainChannelId}>: \`${code}\`. Here are the answers.`,
              blocks: buildAnswersBlocks({ request }),
            })
            .catch((dmError) => logger.error(`Could not DM the owner: ${dmError?.message || dmError}`));
        }
      }
    }
  });

  /**
   * The anonymous vote. Buttons rather than reactions, because a reaction shows
   * everyone who pressed it. Only the tally is ever rendered.
   */
  app.action(
    { action_id: /^passthrough_vote_(yes|no)$/, type: 'block_actions' },
    async ({ ack, body, action, client: actionClient }) => {
      await ack();
      const [rawId, rawVote] = String(action?.value || '').split(':');
      const vote = rawVote === 'yes' ? 'yes' : 'no';
      const request = store.getPassthroughRequest(Number(rawId));
      if (!request || request.status !== 'open') {
        await actionClient.chat.postEphemeral({
          channel: request?.main_channel_id || body.channel?.id,
          user: body.user.id,
          text: 'That request is already settled, so the vote is closed.',
        });
        return;
      }
      if (body.user.id === request.user_id) {
        await actionClient.chat.postEphemeral({
          channel: request.main_channel_id,
          user: body.user.id,
          text: 'You cannot vote on your own request.',
        });
        return;
      }
      store.recordPassthroughVote(request.id, body.user.id, vote);
      await refreshVoteMessage(request.id);
      await actionClient.chat.postEphemeral({
        channel: request.main_channel_id,
        user: body.user.id,
        text: `Vote counted: ${vote}. Press the other button to change it. Nobody can see how you voted.`,
      });
    },
  );

  app.action(
    { action_id: /^passthrough_decide_(approve|deny)$/, type: 'block_actions' },
    async ({ ack, body, action, client: actionClient }) => {
      await ack();
      const [rawId, decision] = String(action?.value || '').split(':');
      const request = store.getPassthroughRequest(Number(rawId));
      if (!request) {
        return;
      }
      const settings = store.getSettings();
      const manager = ownerId || settings.personal_channel_owner_id;
      if (body.user.id !== manager) {
        await actionClient.chat.postEphemeral({
          channel: request.main_channel_id,
          user: body.user.id,
          text: 'Only the channel manager can approve or deny a request.',
        });
        return;
      }

      // The message sits in the main channel where everyone can see it, but the
      // check above is the gate: only the manager's press does anything.
      const stampDecision = async (applied) => {
        if (!request.decision_ts) {
          return;
        }
        try {
          await slack.chat.update({
            channel: request.main_channel_id,
            ts: request.decision_ts,
            ...buildDecisionResult({ request, decision: applied, byUserId: body.user.id }),
          });
        } catch (error) {
          logger.error(`Could not update the passthrough decision message: ${error?.message || error}`);
        }
      };

      if (decision === 'deny') {
        store.setPassthroughRequestStatus(request.id, 'denied');
        await stampDecision('deny');
        await slack.chat.postMessage({
          channel: request.main_channel_id,
          thread_ts: request.thread_ts || request.message_ts,
          text: `<@${request.user_id}>'s request for <#${request.channel_id}> was denied. They can fill the form in again in ${REAPPLY_DAYS} days.`,
        });
        return;
      }

      try {
        await inviteUser(request.channel_id, request.user_id);
        store.setPassthroughRequestStatus(request.id, 'approved');
        await stampDecision('approve');
        await slack.chat.postMessage({
          channel: request.main_channel_id,
          thread_ts: request.thread_ts || request.message_ts,
          text: `:white_check_mark: <@${request.user_id}> was let into <#${request.channel_id}>.`,
        });
      } catch (error) {
        logger.error(`Could not invite a passthrough user: ${error?.message || error}`);
        const code = error?.data?.error || error?.message || 'unknown error';
        const hint =
          code === 'missing_scope'
            ? 'I need the `channels:manage` and `groups:write` scopes, then a reinstall.'
            : 'Invite them by hand, or give me the scope to do it.';
        await slack.chat.postMessage({
          channel: request.main_channel_id,
          thread_ts: request.thread_ts || request.message_ts,
          text: `I could not invite <@${request.user_id}> to <#${request.channel_id}>: \`${code}\`. ${hint}`,
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

  /**
   * Someone walked into a pass-through channel, so they get their own entry
   * form. The message names them and only their button opens it.
   */
  app.event('member_joined_channel', async ({ event }) => {
    const channelId = event?.channel || '';
    const userId = event?.user || '';
    if (!channelId || !userId) {
      return;
    }
    const channel = store.getPassthroughChannel(channelId);
    if (!channel || !channel.enabled) {
      return;
    }
    if (userId === (await botId())) {
      return;
    }
    // Already let in: no form needed. Everything else gets one, even if they
    // have asked before. Filling it in again is fine.
    const approved = store
      .listPassthroughRequests({ limit: 200, status: 'approved' })
      .some((request) => request.channel_id === channelId && request.user_id === userId);
    if (approved) {
      return;
    }
    try {
      await slack.chat.postMessage({
        channel: channelId,
        ...buildJoinMessage({
          channelId,
          userId,
          label: channel.label,
          questionCount: (channel.questions || []).length,
        }),
      });
    } catch (error) {
      logger.warn(
        `Could not post the entry form for ${userId} in ${channelId}: ${error?.data?.error || error?.message || error}`,
      );
    }
  });

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
