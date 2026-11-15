import { toRichTextInitialValue } from '../utils/messages.js';

function buildRichTextInput({ blockId, actionId, label, initialValue, placeholder, optional = false }) {
  return {
    type: 'input',
    block_id: blockId,
    optional,
    label: {
      type: 'plain_text',
      text: label,
    },
    element: {
      type: 'rich_text_input',
      action_id: actionId,
      ...(initialValue ? { initial_value: initialValue } : {}),
      placeholder: {
        type: 'plain_text',
        text: placeholder,
      },
    },
  };
}

function buildPlainTextInput({ blockId, actionId, label, initialValue, placeholder, optional = false }) {
  return {
    type: 'input',
    block_id: blockId,
    optional,
    label: {
      type: 'plain_text',
      text: label,
    },
    element: {
      type: 'plain_text_input',
      action_id: actionId,
      initial_value: initialValue || '',
      placeholder: {
        type: 'plain_text',
        text: placeholder,
      },
    },
  };
}

function toSelectOption(option) {
  return {
    text: { type: 'plain_text', text: option.label },
    value: option.value,
  };
}

function buildStaticSelect({ blockId, actionId, label, options }) {
  const initial = options.find((option) => option.initial) || options[0];
  return {
    type: 'input',
    block_id: blockId,
    label: {
      type: 'plain_text',
      text: label,
    },
    element: {
      type: 'static_select',
      action_id: actionId,
      // Slack requires initial_option to carry `text`; without it views.open fails with
      // invalid_arguments and the modal never appears, so it has to be the same shape
      // as a real option object rather than our internal { value, label } option.
      initial_option: initial ? toSelectOption(initial) : undefined,
      options: options.map(toSelectOption),
    },
  };
}

const HuddlePauseOptions = [
  { value: '0', label: 'Not paused' },
  { value: '15', label: 'Paused for 15 minutes' },
  { value: '60', label: 'Paused for 1 hour' },
  { value: '240', label: 'Paused for 4 hours' },
  { value: '1440', label: 'Paused for 1 day' },
];

export function buildHuddleChannelModal({ channel, nowSeconds = Math.floor(Date.now() / 1000) }) {
  const pausedUntil = Number(channel.pausedUntil) || 0;
  const activePauseMinutes = pausedUntil > nowSeconds ? Math.max(15, Math.round((pausedUntil - nowSeconds) / 60)) : 0;
  const closestPause = HuddlePauseOptions.reduce((best, option) => {
    const value = Number(option.value);
    const bestValue = Number(best.value);
    return Math.abs(value - activePauseMinutes) < Math.abs(bestValue - activePauseMinutes) ? option : best;
  }, HuddlePauseOptions[0]);
  const owners = (channel.ownerIds || []).join(', ');

  return {
    type: 'modal',
    callback_id: 'huddle_channel_config_submit',
    private_metadata: channel.channelId,
    title: { type: 'plain_text', text: 'Huddle channel settings' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Settings for <#${channel.channelId}> — channel owners can change these from the app home, and every change is logged.`,
          },
        ],
      },
      buildPlainTextInput({
        blockId: 'huddle_channel_owners_block',
        actionId: 'huddle_channel_owners_value',
        label: 'Channel owner Slack IDs (comma separated)',
        initialValue: owners,
        placeholder: 'U012ABCDEF, U987654321',
        optional: true,
      }),
      buildStaticSelect({
        blockId: 'huddle_channel_tracking_block',
        actionId: 'huddle_channel_tracking_value',
        label: 'Track huddles in this channel',
        options: [
          { value: 'on', label: 'On — track, announce and review huddles', initial: !!channel.enabled },
          { value: 'off', label: 'Off — no announcements, reviews or points', initial: !channel.enabled },
        ],
      }),
      buildStaticSelect({
        blockId: 'huddle_channel_replies_block',
        actionId: 'huddle_channel_replies_value',
        label: 'Reply when mentioned',
        options: [
          { value: 'on', label: 'On — answer mentions, even with tracking off', initial: !!channel.autoReplies },
          { value: 'off', label: 'Off — never reply to mentions', initial: !channel.autoReplies },
        ],
      }),
      buildStaticSelect({
        blockId: 'huddle_channel_restrict_block',
        actionId: 'huddle_channel_restrict_value',
        label: 'Who can trigger me',
        options: [
          { value: 'anyone', label: 'Anyone in the channel', initial: !channel.restrictTriggers },
          { value: 'owners', label: 'Only the channel owners listed above', initial: !!channel.restrictTriggers },
        ],
      }),
      buildStaticSelect({
        blockId: 'huddle_channel_pause_block',
        actionId: 'huddle_channel_pause_value',
        label: 'Pause tracking temporarily',
        options: HuddlePauseOptions.map((option) => ({
          ...option,
          initial: option.value === String(closestPause.value),
        })),
      }),
    ],
  };
}

export function buildDailyUpdateModal({ draft }) {
  return {
    type: 'modal',
    callback_id: 'compose_daily_update_submit',
    title: { type: 'plain_text', text: 'Compose Daily Update' },
    submit: { type: 'plain_text', text: 'Save draft' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: 'Format with Slack styling — bold, links, lists, mentions and code all render when sent.',
          },
        ],
      },
      buildRichTextInput({
        blockId: 'daily_update_main_block',
        actionId: 'daily_update_main_text',
        label: 'Daily Update',
        initialValue: toRichTextInitialValue(draft?.main_update_text),
        placeholder: "Write today's update here",
      }),
      buildPlainTextInput({
        blockId: 'daily_update_song_block',
        actionId: 'daily_update_song_text',
        label: 'Song of the Day',
        initialValue: draft?.song_text,
        placeholder: 'Optional: a track title or link',
        optional: true,
      }),
      buildPlainTextInput({
        blockId: 'daily_update_event_block',
        actionId: 'daily_update_event_text',
        label: 'Event of the Day',
        initialValue: draft?.event_text,
        placeholder: 'Optional: anything you want to announce',
        optional: true,
      }),
    ],
  };
}

export function buildThreadMessageModal({ settings }) {
  return {
    type: 'modal',
    callback_id: 'edit_thread_message_submit',
    title: { type: 'plain_text', text: 'Follow-up message' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      buildRichTextInput({
        blockId: 'thread_message_block',
        actionId: 'thread_message_content',
        label: 'Follow-up message',
        initialValue: toRichTextInitialValue(settings.daily_update_thread_message),
        placeholder: 'For example: :sparkles: anything else worth sharing?',
      }),
    ],
  };
}

export function buildWelcomeMessageModal({ settings }) {
  return {
    type: 'modal',
    callback_id: 'edit_welcome_message_submit',
    title: { type: 'plain_text', text: 'Welcome message' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      buildRichTextInput({
        blockId: 'welcome_message_block',
        actionId: 'welcome_message_content',
        label: 'Welcome message',
        initialValue: toRichTextInitialValue(settings.welcome_message_content),
        placeholder: 'Welcome to the channel!',
      }),
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: 'Type `{user}` where you want the new member mention to appear.',
          },
        ],
      },
    ],
  };
}

export function buildPingGroupModal({ selectedGroup = null }) {
  return {
    type: 'modal',
    callback_id: 'edit_ping_group_submit',
    title: { type: 'plain_text', text: 'Daily Update ping group' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'ping_group_block',
        label: { type: 'plain_text', text: 'Ping group' },
        element: {
          type: 'external_select',
          action_id: 'select_ping_user_group',
          min_query_length: 1,
          placeholder: {
            type: 'plain_text',
            text: 'Start typing a user group name or handle',
          },
          ...(selectedGroup
            ? {
                initial_option: {
                  text: { type: 'plain_text', text: selectedGroup.label },
                  value: selectedGroup.id,
                },
              }
            : {}),
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: 'Search for the group by name or handle, then pick it from the list.',
          },
        ],
      },
    ],
  };
}

export function buildPersonalChannelModal({ settings }) {
  return {
    type: 'modal',
    callback_id: 'edit_personal_channel_submit',
    title: { type: 'plain_text', text: 'Personal channel' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'personal_channel_block',
        label: {
          type: 'plain_text',
          text: 'Personal channel',
        },
        element: {
          type: 'conversations_select',
          action_id: 'personal_channel_id',
          filter: {
            include: ['public', 'private'],
            exclude_bot_users: true,
          },
          ...(settings.personal_channel_id ? { initial_conversation: settings.personal_channel_id } : {}),
          placeholder: {
            type: 'plain_text',
            text: 'Choose the personal channel',
          },
        },
      },
    ],
  };
}

export function buildQuestionTestModal() {
  return {
    type: 'modal',
    callback_id: 'test_daily_question_submit',
    title: { type: 'plain_text', text: 'Test Daily Question' },
    submit: { type: 'plain_text', text: 'Generate' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: 'Generates a new question from your AI prompt, then either shows it to you or posts it to the personal channel.',
          },
        ],
      },
      {
        type: 'input',
        block_id: 'question_test_mode_block',
        label: { type: 'plain_text', text: 'What should happen with the question?' },
        element: {
          type: 'radio_buttons',
          action_id: 'question_test_mode',
          options: [
            {
              text: { type: 'plain_text', text: 'Preview only — just show me the output' },
              value: 'preview',
            },
            {
              text: { type: 'plain_text', text: 'Send it to the personal channel' },
              value: 'send',
            },
          ],
          initial_option: {
            text: { type: 'plain_text', text: 'Preview only — just show me the output' },
            value: 'preview',
          },
        },
      },
    ],
  };
}

export function buildQuestionPreviewModal({ questionText }) {
  return {
    type: 'modal',
    callback_id: 'question_preview_view',
    title: { type: 'plain_text', text: 'Daily Question Preview' },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: questionText || '_No question was generated._' },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: 'This is only a preview. Nothing was posted to the channel.',
          },
        ],
      },
    ],
  };
}

export function buildQuestionTestErrorModal({ text }) {
  return {
    type: 'modal',
    callback_id: 'question_test_error_view',
    title: { type: 'plain_text', text: 'Test Daily Question' },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
  };
}

/**
 * The owner's side: pick the pass-through channel and write its form.
 *
 * `questions` is one question per line; a line ending in `| required` has to be
 * answered before the form submits.
 */
export function buildPassthroughChannelModal({ channel = null, mainChannelId = '' } = {}) {
  const editing = Boolean(channel?.channel_id);
  const questionLines =
    (channel?.questions || []).length > 0
      ? channel.questions
          .map((question) => (question.required ? `${question.label} | required` : question.label))
          .join('\n')
      : '';
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: editing
          ? `Editing the entry form for <#${channel.channel_id}>. Requests are announced in the main channel and voted on in the thread.`
          : 'Pick the channel people should be able to request access to. Requests are announced in the main channel and voted on in the thread.',
      },
    },
    {
      type: 'input',
      block_id: 'passthrough_channel_block',
      label: { type: 'plain_text', text: 'Channel' },
      element: {
        type: 'conversations_select',
        action_id: 'passthrough_channel_value',
        ...(editing ? { initial_conversation: channel.channel_id } : {}),
        filter: { include: ['public', 'private'], exclude_bot_users: true },
        placeholder: { type: 'plain_text', text: 'Pick a channel' },
      },
    },
    {
      type: 'input',
      block_id: 'passthrough_label_block',
      optional: true,
      label: { type: 'plain_text', text: 'Label (optional)' },
      element: {
        type: 'plain_text_input',
        action_id: 'passthrough_label_value',
        initial_value: channel?.label || '',
        placeholder: { type: 'plain_text', text: 'What this channel is for' },
      },
    },
    {
      type: 'input',
      block_id: 'passthrough_questions_block',
      label: { type: 'plain_text', text: 'Entry form questions' },
      element: {
        type: 'plain_text_input',
        action_id: 'passthrough_questions_value',
        multiline: true,
        initial_value: questionLines,
        placeholder: {
          type: 'plain_text',
          text: 'One question per line.\nWhy do you want in?\nWhat do you build | required',
        },
      },
      hint: {
        type: 'plain_text',
        text: 'One question per line. Add "| required" to a line to make it mandatory. Up to 10.',
      },
    },
    {
      type: 'input',
      block_id: 'passthrough_main_block',
      optional: true,
      label: { type: 'plain_text', text: 'Announce requests in (optional)' },
      element: {
        type: 'conversations_select',
        action_id: 'passthrough_main_value',
        ...(channel?.main_channel_id || mainChannelId
          ? { initial_conversation: channel?.main_channel_id || mainChannelId }
          : {}),
        filter: { include: ['public', 'private'], exclude_bot_users: true },
        placeholder: { type: 'plain_text', text: 'The main channel' },
      },
      hint: { type: 'plain_text', text: 'Leave empty to use the main channel.' },
    },
  ];

  return {
    type: 'modal',
    callback_id: 'passthrough_channel_submit',
    private_metadata: channel?.channel_id || '',
    title: { type: 'plain_text', text: editing ? 'Edit entry form' : 'Pass-through channel' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks,
  };
}

/** The person's side: whatever questions the owner wrote, as real inputs. */
export function buildPassthroughRequestModal({ channel, meta = '' }) {
  const questions = channel?.questions || [];
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Your answers go to the owner of <#${channel.channel_id}> and anyone they ask to vote. They are not posted in the channel.`,
      },
    },
    ...questions.map((question) => ({
      type: 'input',
      block_id: `passthrough_answer_${question.id}`,
      optional: !question.required,
      label: { type: 'plain_text', text: question.label.slice(0, 150) },
      element: {
        type: 'plain_text_input',
        action_id: 'passthrough_answer_value',
        multiline: true,
        max_length: 500,
      },
    })),
  ];

  if (questions.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_This channel has no questions yet, so there is nothing to ask._' },
    });
  }

  return {
    type: 'modal',
    callback_id: 'passthrough_request_submit',
    private_metadata: meta || channel?.channel_id || '',
    title: { type: 'plain_text', text: 'Request access' },
    submit: { type: 'plain_text', text: 'Send request' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks,
  };
}

/**
 * The owner's test run: one field, who to send it to. Everything else about the
 * form is already decided by the channel's settings.
 */
export function buildPassthroughTestModal({ channel, defaultUserId = '' } = {}) {
  return {
    type: 'modal',
    callback_id: 'passthrough_test_submit',
    private_metadata: channel?.channel_id || '',
    title: { type: 'plain_text', text: 'Send a test form' },
    submit: { type: 'plain_text', text: 'Send test' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Orbit will DM that person a real copy of the entry form for <#${channel?.channel_id}>. Filling it in shows you what a submission looks like, and files nothing.`,
        },
      },
      {
        type: 'input',
        block_id: 'passthrough_test_user_block',
        label: { type: 'plain_text', text: 'Send the test to' },
        element: {
          type: 'users_select',
          action_id: 'passthrough_test_user',
          ...(defaultUserId ? { initial_user: defaultUserId } : {}),
          placeholder: { type: 'plain_text', text: 'Pick a person' },
        },
      },
    ],
  };
}
