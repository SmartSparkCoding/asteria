import { DateTime } from 'luxon';
import { DEFAULT_QUESTION_PROMPT } from '../services/ai.js';
import { contentToMrkdwn } from '../utils/messages.js';
import { normalizeTimeValue } from '../utils/time.js';

function toBooleanString(value) {
  return value ? 'ON' : 'OFF';
}

const CHANNELS_CATEGORY = 'channels';
const HUDDLES_CATEGORY = 'huddles';

const CATEGORY_TABS = [
  { id: CHANNELS_CATEGORY, label: 'Channel Manager', appOwnerOnly: true },
  { id: HUDDLES_CATEGORY, label: 'Huddles' },
];

const SUB_TABS = {
  [CHANNELS_CATEGORY]: [
    { id: 'daily-update', label: 'Daily Update' },
    { id: 'daily-question', label: 'Daily Question' },
    { id: 'welcomer', label: 'Welcomer' },
    { id: 'home-assistant', label: 'Home Assistant' },
    { id: 'sync', label: 'Sync' },
    { id: 'settings', label: 'Settings' },
    { id: 'delete', label: 'Delete' },
  ],
  [HUDDLES_CATEGORY]: [
    { id: 'huddle-channels', label: 'Channels' },
    { id: 'huddles', label: 'Huddles' },
    { id: 'leaderboard', label: 'Leaderboard' },
    { id: 'logs', label: 'Logs', appOwnerOnly: true },
  ],
};

export function defaultCategoryFor(isAppOwner) {
  return isAppOwner ? CHANNELS_CATEGORY : HUDDLES_CATEGORY;
}

export function defaultSubFor(category, isAppOwner) {
  if (category === HUDDLES_CATEGORY) {
    return 'huddle-channels';
  }
  return isAppOwner ? 'daily-update' : 'leaderboard';
}

function buildActionRow(buttons, blockId) {
  return {
    type: 'actions',
    block_id: blockId,
    elements: buttons,
  };
}

/**
 * Two category tabs, each with its own row of sub-category tabs. Channel owners
 * who are not the app owner only ever see the huddle category.
 */
export function buildNavigationBlocks({ category, sub, isAppOwner, isChannelOwner = false }) {
  if (!isAppOwner && !isChannelOwner) {
    return [];
  }
  const activeCategory = SUB_TABS[category] ? category : defaultCategoryFor(isAppOwner);
  const categories = CATEGORY_TABS.filter((entry) => isAppOwner || !entry.appOwnerOnly);
  const subs = SUB_TABS[activeCategory].filter((entry) => isAppOwner || !entry.appOwnerOnly);
  const blocks = [
    buildActionRow(
      categories.map((entry) => ({
        type: 'button',
        action_id: `navigate_category_${entry.id}`,
        text: { type: 'plain_text', text: entry.label },
        value: entry.id,
        ...(entry.id === activeCategory ? { style: 'primary' } : {}),
      })),
      'navigation_categories',
    ),
  ];
  if (subs.length > 1) {
    blocks.push(
      buildActionRow(
        subs.map((entry) => ({
          type: 'button',
          action_id: `navigate_sub_${entry.id.replace(/-/g, '_')}`,
          text: { type: 'plain_text', text: entry.label },
          value: `${activeCategory}/${entry.id}`,
          ...(entry.id === sub ? { style: 'primary' } : {}),
        })),
        'navigation_subs',
      ),
    );
  }
  return blocks;
}

function buildBanner(notice) {
  if (!notice) {
    return [];
  }

  return [
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: notice,
        },
      ],
    },
  ];
}

function buildTopSummary(settings) {
  const summaryLines = [
    `Timezone: *${settings.timezone}*`,
    `Daily Question: *${toBooleanString(settings.daily_question_enabled)}*`,
    `Welcomer: *${toBooleanString(settings.welcomer_enabled)}*`,
    `Reminder: *${toBooleanString(settings.daily_update_reminder_enabled)}*`,
  ];

  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: summaryLines.join('  ·  '),
    },
  };
}

function buildDailyUpdateView({ settings, draft, questionPreview, notice, navigation }) {
  const draftPreview = draft?.main_update_text ? contentToMrkdwn(draft.main_update_text) : '';

  return {
    type: 'home',
    callback_id: 'asteria_home_daily_update',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Asteria' } },
      ...buildBanner(notice),
      ...(navigation ?? []),
      buildTopSummary(settings),
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: "Compose today's update with full Slack formatting, then press *Send Daily Update*.",
        },
      },
      ...(questionPreview
        ? [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*Daily Question preview*\n${questionPreview}`,
              },
            },
          ]
        : []),
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: draftPreview
            ? `*Current draft*\n${draftPreview}`
            : 'No draft composed yet. Use *Compose Daily Update* to write today’s update.',
        },
      },
      {
        type: 'actions',
        block_id: 'daily_update_compose_actions',
        elements: [
          {
            type: 'button',
            action_id: 'open_daily_update_modal',
            text: {
              type: 'plain_text',
              text: 'Compose Daily Update',
            },
            style: 'primary',
          },
        ],
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Follow-up message*\n${settings.daily_update_thread_enabled ? 'Enabled' : 'Disabled'}`,
        },
      },
      {
        type: 'input',
        block_id: 'daily_update_thread_toggle_block',
        label: {
          type: 'plain_text',
          text: 'Send a follow-up message after the Daily Update',
        },
        element: {
          type: 'checkboxes',
          action_id: 'daily_update_thread_enabled',
          options: [
            {
              text: {
                type: 'plain_text',
                text: 'Send a follow-up message after the Daily Update',
              },
              value: 'enabled',
            },
          ],
          initial_options: settings.daily_update_thread_enabled
            ? [
                {
                  text: {
                    type: 'plain_text',
                    text: 'Send a follow-up message after the Daily Update',
                  },
                  value: 'enabled',
                },
              ]
            : [],
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Follow-up message*\n${
            settings.daily_update_thread_message ? contentToMrkdwn(settings.daily_update_thread_message) : '_not set_'
          }`,
        },
      },
      {
        type: 'actions',
        block_id: 'daily_update_thread_actions',
        elements: [
          {
            type: 'button',
            action_id: 'open_thread_message_modal',
            text: {
              type: 'plain_text',
              text: 'Edit follow-up message',
            },
          },
        ],
      },
      {
        type: 'actions',
        block_id: 'daily_update_actions',
        elements: [
          {
            type: 'button',
            action_id: 'send_daily_update',
            text: {
              type: 'plain_text',
              text: 'Send Daily Update',
            },
            style: 'primary',
          },
        ],
      },
    ],
  };
}

function buildDailyQuestionView({ settings, notice, recentQuestions, navigation }) {
  return {
    type: 'home',
    callback_id: 'asteria_home_daily_question',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Asteria' } },
      ...buildBanner(notice),
      ...(navigation ?? []),
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Write the AI prompt and configure when Asteria posts a Daily Question each day.',
        },
      },
      {
        type: 'input',
        block_id: 'daily_question_enabled_block',
        label: {
          type: 'plain_text',
          text: 'Enable Daily Question',
        },
        element: {
          type: 'checkboxes',
          action_id: 'daily_question_enabled',
          options: [
            {
              text: {
                type: 'plain_text',
                text: 'Generate and post a Daily Question every day',
              },
              value: 'enabled',
            },
          ],
          initial_options: settings.daily_question_enabled
            ? [
                {
                  text: {
                    type: 'plain_text',
                    text: 'Generate and post a Daily Question every day',
                  },
                  value: 'enabled',
                },
              ]
            : [],
        },
      },
      {
        type: 'input',
        block_id: 'daily_question_prompt_block',
        label: {
          type: 'plain_text',
          text: 'AI prompt',
        },
        element: {
          type: 'plain_text_input',
          action_id: 'daily_question_prompt',
          multiline: true,
          initial_value: settings.daily_question_prompt || DEFAULT_QUESTION_PROMPT,
          placeholder: {
            type: 'plain_text',
            text: 'Write the full prompt that is sent to the AI',
          },
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: 'This prompt is sent to the AI exactly as you write it — no tags or variables are inserted.',
          },
        ],
      },
      {
        type: 'input',
        block_id: 'daily_question_include_block',
        label: {
          type: 'plain_text',
          text: 'Include in Daily Update',
        },
        element: {
          type: 'checkboxes',
          action_id: 'daily_question_include_in_update',
          options: [
            {
              text: {
                type: 'plain_text',
                text: 'Also include the Daily Question text inside the Daily Update',
              },
              value: 'enabled',
            },
          ],
          initial_options: settings.daily_question_include_in_daily_update
            ? [
                {
                  text: {
                    type: 'plain_text',
                    text: 'Also include the Daily Question text inside the Daily Update',
                  },
                  value: 'enabled',
                },
              ]
            : [],
        },
      },
      {
        type: 'input',
        block_id: 'daily_question_send_time_block',
        label: {
          type: 'plain_text',
          text: 'Daily Question time',
        },
        element: {
          type: 'plain_text_input',
          action_id: 'daily_question_send_time',
          initial_value: normalizeTimeValue(settings.daily_question_send_time, '09:00'),
          placeholder: {
            type: 'plain_text',
            text: 'HH:MM in the configured timezone',
          },
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            recentQuestions.length > 0
              ? `*Recent questions*\n${recentQuestions
                  .slice(0, 3)
                  .map((question) => `• ${question}`)
                  .join('\n')}`
              : '*Recent questions*\nNo Daily Questions have been generated yet.',
        },
      },
      {
        type: 'actions',
        block_id: 'daily_question_actions',
        elements: [
          {
            type: 'button',
            action_id: 'save_daily_question_settings',
            text: { type: 'plain_text', text: 'Save Daily Question Settings' },
            style: 'primary',
          },
          {
            type: 'button',
            action_id: 'open_question_test_modal',
            text: { type: 'plain_text', text: 'Test Daily Question' },
          },
        ],
      },
    ],
  };
}

function buildWelcomerView({ settings, notice, navigation }) {
  return {
    type: 'home',
    callback_id: 'asteria_home_welcomer',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Asteria' } },
      ...buildBanner(notice),
      ...(navigation ?? []),
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Configure the welcome message that Asteria sends when someone joins the personal channel.',
        },
      },
      {
        type: 'input',
        block_id: 'welcomer_enabled_block',
        label: {
          type: 'plain_text',
          text: 'Enable Welcomer',
        },
        element: {
          type: 'checkboxes',
          action_id: 'welcomer_enabled',
          options: [
            {
              text: {
                type: 'plain_text',
                text: 'Send a welcome message when a user joins the channel',
              },
              value: 'enabled',
            },
          ],
          initial_options: settings.welcomer_enabled
            ? [
                {
                  text: {
                    type: 'plain_text',
                    text: 'Send a welcome message when a user joins the channel',
                  },
                  value: 'enabled',
                },
              ]
            : [],
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Welcome message*\n${
            settings.welcome_message_content
              ? contentToMrkdwn(settings.welcome_message_content)
              : '_not set — a default welcome will be used_'
          }`,
        },
      },
      {
        type: 'actions',
        block_id: 'welcome_message_actions',
        elements: [
          {
            type: 'button',
            action_id: 'open_welcome_message_modal',
            text: { type: 'plain_text', text: 'Edit welcome message' },
            style: 'primary',
          },
        ],
      },
      {
        type: 'input',
        block_id: 'rules_canvas_block',
        optional: true,
        label: {
          type: 'plain_text',
          text: 'Rules Canvas URL',
        },
        element: {
          type: 'plain_text_input',
          action_id: 'rules_canvas_url',
          initial_value: settings.rules_canvas_url || '',
          placeholder: {
            type: 'plain_text',
            text: 'Optional https://... canvas URL',
          },
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: 'Placeholder reference: `{user}` becomes the new Slack member mention.',
          },
        ],
      },
      {
        type: 'actions',
        block_id: 'welcomer_actions',
        elements: [
          {
            type: 'button',
            action_id: 'save_welcomer_settings',
            text: { type: 'plain_text', text: 'Save Welcomer Settings' },
            style: 'primary',
          },
        ],
      },
    ],
  };
}

function buildSyncView({ settings, notice, isOwner, navigation }) {
  const configured = Boolean(settings.todoist_api_token && settings.slack_list_id);

  return {
    type: 'home',
    callback_id: 'asteria_home_sync',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Asteria' } },
      ...buildBanner(notice),
      ...(navigation ?? []),
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Two-way sync between a Slack List and Todoist. Items added to the list are created as Todoist tasks; completing a Todoist task marks the list item complete and posts a message.',
        },
      },
      ...(!isOwner
        ? [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: 'Only the configured personal channel owner can change sync settings.',
              },
            },
          ]
        : [
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: configured ? '*Status:* Configured' : '*Status:* Not configured',
                },
              ],
            },
            {
              type: 'input',
              block_id: 'sync_enabled_block',
              label: { type: 'plain_text', text: 'Enable Two-way Sync' },
              element: {
                type: 'checkboxes',
                action_id: 'sync_enabled',
                options: [
                  {
                    text: { type: 'plain_text', text: 'Enable sync between Slack List and Todoist' },
                    value: 'enabled',
                  },
                ],
                initial_options: settings.enabled
                  ? [
                      {
                        text: { type: 'plain_text', text: 'Enable sync between Slack List and Todoist' },
                        value: 'enabled',
                      },
                    ]
                  : [],
              },
            },
            {
              type: 'input',
              block_id: 'sync_todoist_api_token_block',
              label: { type: 'plain_text', text: 'Todoist API token' },
              element: {
                type: 'plain_text_input',
                action_id: 'sync_todoist_api_token',
                initial_value: settings.todoist_api_token || '',
                placeholder: { type: 'plain_text', text: 'Create one in Todoist App Management (read/write scopes)' },
              },
            },
            {
              type: 'input',
              block_id: 'sync_slack_list_id_block',
              label: { type: 'plain_text', text: 'Slack List ID' },
              element: {
                type: 'plain_text_input',
                action_id: 'sync_slack_list_id',
                initial_value: settings.slack_list_id || '',
                placeholder: { type: 'plain_text', text: 'List ID from the list URL, e.g. F0C37D72NNM' },
              },
            },
            {
              type: 'input',
              block_id: 'sync_todoist_project_name_block',
              label: { type: 'plain_text', text: 'Todoist project name' },
              element: {
                type: 'plain_text_input',
                action_id: 'sync_todoist_project_name',
                initial_value: settings.todoist_project_name || 'Public Slack To Do List',
                placeholder: { type: 'plain_text', text: 'Project that tasks are created in' },
              },
            },
            {
              type: 'input',
              block_id: 'sync_notification_channel_id_block',
              label: { type: 'plain_text', text: 'Notification channel ID' },
              element: {
                type: 'plain_text_input',
                action_id: 'sync_notification_channel_id',
                initial_value: settings.notification_channel_id || '',
                placeholder: { type: 'plain_text', text: 'Channel that receives Task Completed messages' },
              },
            },
            {
              type: 'input',
              block_id: 'sync_poll_interval_block',
              label: { type: 'plain_text', text: 'Poll interval (seconds)' },
              element: {
                type: 'plain_text_input',
                action_id: 'sync_poll_interval',
                initial_value: String(settings.poll_interval_seconds || 300),
                placeholder: { type: 'plain_text', text: 'How often Slack is checked for new items' },
              },
            },
            {
              type: 'input',
              block_id: 'sync_webhook_secret_block',
              label: { type: 'plain_text', text: 'Webhook secret' },
              element: {
                type: 'plain_text_input',
                action_id: 'sync_webhook_secret',
                initial_value: settings.webhook_secret || '',
                placeholder: { type: 'plain_text', text: 'Shared secret used to verify Todoist webhooks (HMAC)' },
              },
            },
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: 'For instant updates, create a Todoist webhook pointing at `{public base URL}/webhooks/todoist` with the secret above as the HMAC key.',
                },
              ],
            },
            {
              type: 'actions',
              block_id: 'sync_actions',
              elements: [
                {
                  type: 'button',
                  action_id: 'save_sync_settings',
                  text: { type: 'plain_text', text: 'Save Sync Settings' },
                  style: 'primary',
                },
              ],
            },
          ]),
    ],
  };
}

function buildHomeAssistantView({ settings, notice, isOwner, stepsSummary, navigation }) {
  const configured = Boolean(
    settings.home_assistant_url && settings.home_assistant_token && settings.home_assistant_steps_entity,
  );

  return {
    type: 'home',
    callback_id: 'asteria_home_home_assistant',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Asteria' } },
      ...buildBanner(notice),
      ...(navigation ?? []),
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Pull your daily step count from Home Assistant and include it in the Daily Update.',
        },
      },
      ...(!isOwner
        ? [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: 'Only the configured personal channel owner can change Home Assistant settings.',
              },
            },
          ]
        : [
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: configured ? '*Status:* Configured' : '*Status:* Not configured',
                },
              ],
            },
            ...(stepsSummary
              ? [
                  {
                    type: 'section',
                    text: {
                      type: 'mrkdwn',
                      text: stepsSummary,
                    },
                  },
                ]
              : []),
            {
              type: 'input',
              block_id: 'home_assistant_url_block',
              label: { type: 'plain_text', text: 'Home Assistant URL' },
              element: {
                type: 'plain_text_input',
                action_id: 'home_assistant_url',
                initial_value: settings.home_assistant_url || '',
                placeholder: { type: 'plain_text', text: 'https://home.example.com' },
              },
            },
            {
              type: 'input',
              block_id: 'home_assistant_token_block',
              label: { type: 'plain_text', text: 'Long-lived access token' },
              element: {
                type: 'plain_text_input',
                action_id: 'home_assistant_token',
                initial_value: settings.home_assistant_token || '',
                placeholder: { type: 'plain_text', text: 'Long-lived access token' },
              },
            },
            {
              type: 'input',
              block_id: 'home_assistant_steps_entity_block',
              label: { type: 'plain_text', text: 'Steps counter entity ID' },
              element: {
                type: 'plain_text_input',
                action_id: 'home_assistant_steps_entity',
                initial_value: settings.home_assistant_steps_entity || '',
                placeholder: { type: 'plain_text', text: 'sensor.step_counter' },
              },
            },
            {
              type: 'actions',
              block_id: 'home_assistant_actions',
              elements: [
                {
                  type: 'button',
                  action_id: 'save_home_assistant_settings',
                  text: { type: 'plain_text', text: 'Save Home Assistant Settings' },
                  style: 'primary',
                },
              ],
            },
            ...(configured
              ? [
                  {
                    type: 'actions',
                    block_id: 'home_assistant_test_actions',
                    elements: [
                      {
                        type: 'button',
                        action_id: 'test_home_assistant_steps',
                        text: { type: 'plain_text', text: ':mag: Test steps fetch' },
                      },
                    ],
                  },
                ]
              : []),
          ]),
    ],
  };
}

function buildSettingsView({ settings, notice, navigation }) {
  return {
    type: 'home',
    callback_id: 'asteria_home_settings',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Asteria' } },
      ...buildBanner(notice),
      ...(navigation ?? []),
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'General settings for Asteria, including timezone, reminder timing, the personal channel, and the Daily Update ping group.',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Configured owner*\n<@${settings.personal_channel_owner_id}>`,
        },
      },
      {
        type: 'input',
        block_id: 'bot_name_block',
        label: { type: 'plain_text', text: 'Bot name' },
        element: {
          type: 'plain_text_input',
          action_id: 'bot_display_name',
          initial_value: settings.bot_display_name || 'Asteria',
          placeholder: {
            type: 'plain_text',
            text: 'Name shown when Asteria posts as the bot',
          },
        },
      },
      {
        type: 'input',
        block_id: 'timezone_block',
        label: { type: 'plain_text', text: 'Timezone' },
        element: {
          type: 'plain_text_input',
          action_id: 'timezone',
          initial_value: settings.timezone || 'UTC',
          placeholder: {
            type: 'plain_text',
            text: 'Use an IANA timezone like Europe/London',
          },
        },
      },
      {
        type: 'input',
        block_id: 'daily_update_reminder_enabled_block',
        label: {
          type: 'plain_text',
          text: 'Daily Update reminder',
        },
        element: {
          type: 'checkboxes',
          action_id: 'daily_update_reminder_enabled',
          options: [
            {
              text: {
                type: 'plain_text',
                text: 'Send a DM reminder if no Daily Update has been sent by the deadline',
              },
              value: 'enabled',
            },
          ],
          initial_options: settings.daily_update_reminder_enabled
            ? [
                {
                  text: {
                    type: 'plain_text',
                    text: 'Send a DM reminder if no Daily Update has been sent by the deadline',
                  },
                  value: 'enabled',
                },
              ]
            : [],
        },
      },
      {
        type: 'input',
        block_id: 'daily_update_reminder_time_block',
        label: { type: 'plain_text', text: 'Reminder deadline' },
        element: {
          type: 'plain_text_input',
          action_id: 'daily_update_reminder_time',
          initial_value: normalizeTimeValue(settings.daily_update_reminder_time, '17:00'),
          placeholder: {
            type: 'plain_text',
            text: 'HH:MM in the configured timezone',
          },
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Personal channel*\n${
            settings.personal_channel_id ? `\`${settings.personal_channel_id}\`` : '_not set_'
          }`,
        },
        accessory: {
          type: 'button',
          action_id: 'open_personal_channel_modal',
          text: {
            type: 'plain_text',
            text: 'Change channel',
          },
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Daily Update ping group*\n${
            settings.daily_update_ping_user_group_id
              ? `<!subteam^${settings.daily_update_ping_user_group_id}>`
              : '_not set_'
          }`,
        },
        accessory: {
          type: 'button',
          action_id: 'open_ping_group_modal',
          text: {
            type: 'plain_text',
            text: 'Change group',
          },
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Configured personal channel: \`${settings.personal_channel_id || 'not set'}\`\nDaily update ping group: ${settings.daily_update_ping_user_group_id ? `<!subteam^${settings.daily_update_ping_user_group_id}>` : '_not set_'}`,
        },
      },
      {
        type: 'actions',
        block_id: 'settings_actions',
        elements: [
          {
            type: 'button',
            action_id: 'save_general_settings',
            text: { type: 'plain_text', text: 'Save Settings' },
            style: 'primary',
          },
        ],
      },
    ],
  };
}

function formatHuddleSummary(huddle, timezone) {
  const startLabel = huddle.started_at
    ? DateTime.fromSeconds(huddle.started_at, { zone: timezone || 'UTC' }).toFormat('d LLL yyyy, HH:mm')
    : 'unknown date';
  const channelId = huddle.channel_id || '';
  const channel =
    channelId.startsWith('D') || channelId.startsWith('G') ? 'a DM' : channelId ? `<#${channelId}>` : 'unknown channel';
  const status = huddle.status === 'active' ? ' · :large_blue_circle: active now' : '';
  return `• ${channel} · ${startLabel}${status}`;
}

export function buildHuddlesView({ huddles, notice, timezone, navigation }) {
  return {
    type: 'home',
    callback_id: 'asteria_home_huddles',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Asteria' } },
      ...buildBanner(notice),
      ...(navigation ?? []),
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Huddles from channels Asteria is in, most recent first. Every ended huddle can generate a review from its DM prompt.',
        },
      },
      ...(huddles.length > 0
        ? [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: huddles.map((huddle) => formatHuddleSummary(huddle, timezone)).join('\n'),
              },
            },
          ]
        : [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: '_No huddles recorded yet._',
              },
            },
          ]),
    ],
  };
}

export function buildLeaderboardView({ leaderboard, notice, navigation }) {
  const ranked = (leaderboard || []).map((row) => `• <@${row.user_id}> · *${row.points} pts*`);

  return {
    type: 'home',
    callback_id: 'asteria_home_leaderboard',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Asteria' } },
      ...buildBanner(notice),
      ...(navigation ?? []),
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Huddle points: stay in huddles, beat the longest/shortest message prizes, and start huddles to climb the board.',
        },
      },
      ...(ranked.length > 0
        ? [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: ranked.join('\n'),
              },
            },
          ]
        : [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: '_No huddle points awarded yet._',
              },
            },
          ]),
    ],
  };
}

function formatTriggerLogEntry(entry, timezone) {
  const timeLabel = entry.created_at
    ? DateTime.fromSQL(entry.created_at, { zone: timezone || 'UTC' }).toFormat('d LLL HH:mm')
    : 'unknown time';
  const actor = entry.user_id ? `<@${entry.user_id}>` : '_the bot_';
  const channel = entry.channel_id ? ` · <#${entry.channel_id}>` : '';
  const detail = entry.detail ? ` · ${entry.detail}` : '';
  return `• ${timeLabel} · ${actor} · *${entry.action}*${channel}${detail}`;
}

const HuddleChannelActionPrefix = 'huddle_channel_';

function describeHuddleChannel(channel, now) {
  const pausedUntil = Number(channel.pausedUntil) || 0;
  const paused = pausedUntil > now;
  const owners = (channel.ownerIds || []).map((id) => `<@${id}>`).join(' ') || '_nobody yet_';
  const status = paused
    ? `:pause_button: *paused* until <!date^${pausedUntil}^{date_short_pretty} at {time}|falling back to the stored time>>`
    : channel.enabled
      ? ':green_circle: *tracking on*'
      : ':red_circle: *tracking off*';
  return [
    status,
    `auto replies: ${channel.autoReplies ? ':white_check_mark: on' : ':no_entry: off'}`,
    `only owners can trigger: ${channel.restrictTriggers ? ':white_check_mark: on' : ':no_entry: off'}`,
    `channel owner(s): ${owners}`,
  ].join('\n');
}

function buildHuddleChannelBlocks(channel, now) {
  const paused = (Number(channel.pausedUntil) || 0) > now;
  const value = channel.channelId;
  // action_ids must be unique across the whole view, so every control is suffixed
  // with the channel it belongs to. The channel itself travels in `value`.
  const mainButtons = [
    {
      type: 'button',
      action_id: `${HuddleChannelActionPrefix}configure_${value}`,
      text: { type: 'plain_text', text: 'Configure' },
      value,
    },
    {
      type: 'button',
      action_id: `${HuddleChannelActionPrefix}toggle_tracking_${value}`,
      text: { type: 'plain_text', text: channel.enabled ? 'Tracking: on' : 'Tracking: off' },
      value,
    },
    {
      type: 'button',
      action_id: `${HuddleChannelActionPrefix}toggle_auto_replies_${value}`,
      text: { type: 'plain_text', text: channel.autoReplies ? 'Replies: on' : 'Replies: off' },
      value,
    },
    {
      type: 'button',
      action_id: `${HuddleChannelActionPrefix}toggle_restrict_${value}`,
      text: { type: 'plain_text', text: channel.restrictTriggers ? 'Owners only: on' : 'Owners only: off' },
      value,
    },
  ];
  const pauseButtons = paused
    ? [
        {
          type: 'button',
          action_id: `${HuddleChannelActionPrefix}resume_${value}`,
          text: { type: 'plain_text', text: 'Resume now' },
          value,
          style: 'primary',
        },
      ]
    : [15, 60, 240, 1440].map((minutes) => ({
        type: 'button',
        action_id: `${HuddleChannelActionPrefix}pause_${value}_${minutes}`,
        text: {
          type: 'plain_text',
          text: minutes >= 1440 ? 'Pause 1 day' : `Pause ${minutes >= 60 ? `${minutes / 60}h` : `${minutes}m`}`,
        },
        value: `${value}:${minutes}`,
      }));
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*<#${channel.channelId}>*${channel.name ? ` · _${channel.name}_` : ''}\n${describeHuddleChannel(channel, now)}`,
      },
    },
    buildActionRow(mainButtons, `huddle_channel_actions_${channel.channelId}`),
    buildActionRow(pauseButtons, `huddle_channel_pause_${channel.channelId}`),
  ];
}

export function buildHuddleChannelsView({ channels, notice, navigation, canConfigureAll = false }) {
  const now = Math.floor(Date.now() / 1000);
  const visible = (channels || []).slice(0, 25);

  return {
    type: 'home',
    callback_id: 'asteria_home_huddle_channels',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Huddle channels' } },
      ...buildBanner(notice),
      ...(navigation ?? []),
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: canConfigureAll
            ? 'Every channel I track huddles in. Turn tracking on or off, pause me for a while, silence my replies, or limit who can trigger me — channel owners can do the same for their own channel from here.'
            : 'The channels you are the owner of. You can turn tracking on or off, pause me, silence my replies, or limit who can trigger me here.',
        },
      },
      ...(visible.length > 0
        ? visible.flatMap((channel) => buildHuddleChannelBlocks(channel, now))
        : [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: '_No huddle channels yet — I will show up here once I am in a channel with a huddle._',
              },
            },
          ]),
      ...((channels || []).length > visible.length
        ? [
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: `_showing the first ${visible.length} of ${channels.length} channels_`,
                },
              ],
            },
          ]
        : []),
    ],
  };
}

export function buildLogsView({ logs, notice, timezone, navigation }) {
  const lines = (logs || []).map((entry) => formatTriggerLogEntry(entry, timezone));

  return {
    type: 'home',
    callback_id: 'asteria_home_logs',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Asteria' } },
      ...buildBanner(notice),
      ...(navigation ?? []),
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Recent triggers in the channels I am in — who joined, left, opted out, asked for huddles stuff, or had a message deleted.',
        },
      },
      ...(lines.length > 0
        ? [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: lines.join('\n'),
              },
            },
          ]
        : [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: '_No triggers logged yet._',
              },
            },
          ]),
    ],
  };
}

export function buildDeleteView({ notice, navigation }) {
  return {
    type: 'home',
    callback_id: 'asteria_home_delete',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Asteria' } },
      ...buildBanner(notice),
      ...(navigation ?? []),
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Paste a link to any message I (Asteria) sent and I will delete it — no matter what it is or where it lives.',
        },
      },
      {
        type: 'input',
        block_id: 'delete_message_link_block',
        label: {
          type: 'plain_text',
          text: 'Message link',
        },
        element: {
          type: 'plain_text_input',
          action_id: 'delete_message_link',
          placeholder: {
            type: 'plain_text',
            text: 'https://hackclub.slack.com/archives/C09RQFJCJ4U/p1790380910506989',
          },
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            action_id: 'delete_message_submit',
            text: { type: 'plain_text', text: 'Delete it' },
            style: 'danger',
          },
        ],
      },
    ],
  };
}

export function buildHomeView({
  category,
  sub,
  settings,
  draft,
  questionPreview,
  recentQuestions,
  notice,
  isOwner,
  isChannelOwner = false,
  syncSettings,
  huddles,
  huddleChannels,
  leaderboard,
  logs,
}) {
  const activeCategory =
    SUB_TABS[category] && (isOwner || category !== CHANNELS_CATEGORY) ? category : defaultCategoryFor(isOwner);
  const activeSub = SUB_TABS[activeCategory].some((entry) => entry.id === sub)
    ? sub
    : defaultSubFor(activeCategory, isOwner);
  const navigation = buildNavigationBlocks({
    category: activeCategory,
    sub: activeSub,
    isAppOwner: isOwner,
    isChannelOwner,
  });
  const canConfigureHuddleChannels = isOwner || isChannelOwner;

  if (!isOwner && !isChannelOwner) {
    return buildLeaderboardView({ leaderboard: leaderboard || [], notice, navigation });
  }

  if (activeCategory === HUDDLES_CATEGORY) {
    if (activeSub === 'huddle-channels') {
      if (!canConfigureHuddleChannels) {
        return buildLeaderboardView({ leaderboard: leaderboard || [], notice, navigation });
      }
      return buildHuddleChannelsView({
        channels: huddleChannels || [],
        notice,
        navigation,
        canConfigureAll: isOwner,
      });
    }
    if (activeSub === 'huddles') {
      if (!isOwner) {
        return buildLeaderboardView({ leaderboard: leaderboard || [], notice, navigation });
      }
      return buildHuddlesView({ huddles: huddles || [], notice, timezone: settings.timezone, navigation });
    }
    if (activeSub === 'leaderboard') {
      return buildLeaderboardView({ leaderboard: leaderboard || [], notice, navigation });
    }
    if (activeSub === 'logs') {
      if (!isOwner) {
        return buildLeaderboardView({ leaderboard: leaderboard || [], notice, navigation });
      }
      return buildLogsView({ logs: logs || [], notice, timezone: settings.timezone, navigation });
    }
  }

  if (activeCategory === CHANNELS_CATEGORY) {
    if (activeSub === 'daily-question') {
      return buildDailyQuestionView({ settings, notice, recentQuestions: recentQuestions || [], navigation });
    }
    if (activeSub === 'welcomer') {
      return buildWelcomerView({ settings, notice, navigation });
    }
    if (activeSub === 'home-assistant') {
      return buildHomeAssistantView({ settings, notice, isOwner, navigation });
    }
    if (activeSub === 'sync') {
      return buildSyncView({ settings: syncSettings || {}, notice, isOwner, navigation });
    }
    if (activeSub === 'settings') {
      return buildSettingsView({ settings, notice, navigation });
    }
    if (activeSub === 'delete') {
      return buildDeleteView({ notice, navigation });
    }
    return buildDailyUpdateView({ settings, draft, questionPreview, notice, navigation });
  }

  return buildLeaderboardView({ leaderboard: leaderboard || [], notice, navigation });
}
