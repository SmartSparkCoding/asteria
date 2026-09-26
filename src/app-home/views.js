import { DateTime } from 'luxon';
import { DEFAULT_QUESTION_PROMPT } from '../services/ai.js';
import { contentToMrkdwn } from '../utils/messages.js';
import { normalizeTimeValue } from '../utils/time.js';

function toBooleanString(value) {
  return value ? 'ON' : 'OFF';
}

function buildTabs(activeTab, isOwner) {
  if (!isOwner) {
    return null;
  }
  const tabs = [
    { id: 'daily-update', label: 'Daily Update' },
    { id: 'daily-question', label: 'Daily Question' },
    { id: 'welcomer', label: 'Welcomer' },
    { id: 'home-assistant', label: 'Home Assistant' },
    { id: 'huddles', label: 'Huddles' },
    { id: 'sync', label: 'Sync' },
    { id: 'settings', label: 'Settings' },
    { id: 'leaderboard', label: 'Leaderboard' },
    { id: 'logs', label: 'Logs' },
    { id: 'delete', label: 'Delete' },
  ];

  return {
    type: 'actions',
    block_id: 'navigation_tabs',
    elements: tabs.map((tab) => ({
      type: 'button',
      action_id: `navigate_${tab.id.replace(/-/g, '_')}`,
      text: {
        type: 'plain_text',
        text: tab.label,
      },
      value: tab.id,
      ...(tab.id === activeTab ? { style: 'primary' } : {}),
    })),
  };
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

function buildDailyUpdateView({ settings, draft, questionPreview, notice }) {
  const draftPreview = draft?.main_update_text ? contentToMrkdwn(draft.main_update_text) : '';

  return {
    type: 'home',
    callback_id: 'asteria_home_daily_update',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Asteria' } },
      ...buildBanner(notice),
      buildTabs('daily-update', true),
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

function buildDailyQuestionView({ settings, notice, recentQuestions }) {
  return {
    type: 'home',
    callback_id: 'asteria_home_daily_question',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Asteria' } },
      ...buildBanner(notice),
      buildTabs('daily-question', true),
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

function buildWelcomerView({ settings, notice }) {
  return {
    type: 'home',
    callback_id: 'asteria_home_welcomer',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Asteria' } },
      ...buildBanner(notice),
      buildTabs('welcomer', true),
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

function buildSyncView({ settings, notice, isOwner }) {
  const configured = Boolean(settings.todoist_api_token && settings.slack_list_id);

  return {
    type: 'home',
    callback_id: 'asteria_home_sync',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Asteria' } },
      ...buildBanner(notice),
      buildTabs('sync', true),
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

function buildHomeAssistantView({ settings, notice, isOwner, stepsSummary }) {
  const configured = Boolean(
    settings.home_assistant_url && settings.home_assistant_token && settings.home_assistant_steps_entity,
  );

  return {
    type: 'home',
    callback_id: 'asteria_home_home_assistant',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Asteria' } },
      ...buildBanner(notice),
      buildTabs('home-assistant', true),
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

function buildSettingsView({ settings, notice }) {
  return {
    type: 'home',
    callback_id: 'asteria_home_settings',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Asteria' } },
      ...buildBanner(notice),
      buildTabs('settings', true),
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

export function buildHuddlesView({ huddles, notice, timezone }) {
  return {
    type: 'home',
    callback_id: 'asteria_home_huddles',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Asteria' } },
      ...buildBanner(notice),
      buildTabs('huddles', true),
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

export function buildLeaderboardView({ leaderboard, notice, isOwner }) {
  const ranked = (leaderboard || []).map((row) => `• <@${row.user_id}> · *${row.points} pts*`);

  return {
    type: 'home',
    callback_id: 'asteria_home_leaderboard',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Asteria' } },
      ...buildBanner(notice),
      ...(isOwner ? [buildTabs('leaderboard', true)] : []),
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
  const detail = entry.detail ? ` · ${entry.detail}` : '';
  return `• ${timeLabel} · ${actor} · *${entry.action}*${detail}`;
}

export function buildLogsView({ logs, notice, timezone }) {
  const lines = (logs || []).map((entry) => formatTriggerLogEntry(entry, timezone));

  return {
    type: 'home',
    callback_id: 'asteria_home_logs',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Asteria' } },
      ...buildBanner(notice),
      buildTabs('logs', true),
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Recent triggers — who started, joined, left, opted out, or asked for huddles stuff.',
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

export function buildDeleteView({ notice }) {
  return {
    type: 'home',
    callback_id: 'asteria_home_delete',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Asteria' } },
      ...buildBanner(notice),
      buildTabs('delete', true),
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
  tab,
  settings,
  draft,
  questionPreview,
  recentQuestions,
  notice,
  isOwner,
  syncSettings,
  huddles,
  leaderboard,
  logs,
}) {
  if (!isOwner) {
    return buildLeaderboardView({ leaderboard: leaderboard || [], notice, isOwner: false });
  }

  if (tab === 'daily-question') {
    return buildDailyQuestionView({
      settings,
      notice,
      recentQuestions: recentQuestions || [],
    });
  }

  if (tab === 'welcomer') {
    return buildWelcomerView({ settings, notice });
  }

  if (tab === 'home-assistant') {
    return buildHomeAssistantView({ settings, notice, isOwner });
  }

  if (tab === 'huddles') {
    return buildHuddlesView({ huddles: huddles || [], notice, timezone: settings.timezone });
  }

  if (tab === 'sync') {
    return buildSyncView({ settings: syncSettings || {}, notice, isOwner });
  }

  if (tab === 'settings') {
    return buildSettingsView({ settings, notice });
  }

  if (tab === 'leaderboard') {
    return buildLeaderboardView({ leaderboard: leaderboard || [], notice, isOwner: true });
  }

  if (tab === 'logs') {
    return buildLogsView({ logs: logs || [], notice, timezone: settings.timezone });
  }

  if (tab === 'delete') {
    return buildDeleteView({ notice });
  }

  return buildDailyUpdateView({ settings, draft, questionPreview, notice });
}
