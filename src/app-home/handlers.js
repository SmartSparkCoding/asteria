import { fetchUserGroups, sendDailyQuestion, sendDailyUpdate, sendWelcomeMessage, addUserToUserGroup, removeUserFromUserGroup, sendDirectMessage } from '../services/slack.js';
import { createHomeAssistantService } from '../services/home-assistant.js';
import { contentToMrkdwn, formatDailyQuestionMessage } from '../utils/messages.js';
import { getLocalDateKey, isValidTimeZone, normalizeTimeValue } from '../utils/time.js';
import {
  buildDailyUpdateModal,
  buildPersonalChannelModal,
  buildPingGroupModal,
  buildQuestionPreviewModal,
  buildQuestionTestErrorModal,
  buildQuestionTestModal,
  buildThreadMessageModal,
  buildWelcomeMessageModal,
} from './modals.js';
import { buildHomeView } from './views.js';

function getInputValue(viewState, blockId, actionId) {
  return viewState?.[blockId]?.[actionId]?.value ?? '';
}

function getRichTextInputValue(viewState, blockId, actionId) {
  const stateValue = viewState?.[blockId]?.[actionId];
  if (stateValue?.rich_text_value) {
    return JSON.stringify(stateValue.rich_text_value.elements ?? []);
  }
  return stateValue?.value ?? '';
}

function getCheckboxEnabled(viewState, blockId, actionId) {
  return (viewState?.[blockId]?.[actionId]?.selected_options ?? []).length > 0;
}

function getStaticSelectValue(viewState, blockId, actionId) {
  return viewState?.[blockId]?.[actionId]?.selected_option?.value ?? '';
}

function getConversationSelectValue(viewState, blockId, actionId) {
  return viewState?.[blockId]?.[actionId]?.selected_conversation ?? '';
}

async function publishHome(client, userId, view) {
  await client.views.publish({
    user_id: userId,
    view,
  });
}

async function openModal(client, triggerId, view) {
  await client.views.open({
    trigger_id: triggerId,
    view,
  });
}

export function createHomeHandlers({ app, store, aiService, environment, scheduler }) {
  const homeAssistantService = createHomeAssistantService({
    getSettings: () => store.getSettings(),
    logger: app.logger,
  });

  async function publishTab(client, userId, tab, notice = '') {
    const settings = store.getSettings();
    const syncSettings = store.getSyncSettings();
    const draft = store.getDraft();
    const recentQuestions = store.getRecentDailyQuestionTexts(5);
    const lastQuestion = store.getLastDailyQuestion();
    const questionPreview =
      settings.daily_question_enabled && lastQuestion?.question_text
        ? formatDailyQuestionMessage(lastQuestion.question_text, settings.daily_question_reply_text)
        : '';
    const huddles = store.listHuddles().filter((huddle) => huddle.channel_id).slice(0, 10);

    await publishHome(
      client,
      userId,
      buildHomeView({
        tab,
        settings,
        syncSettings,
        draft,
        questionPreview,
        recentQuestions,
        notice,
        huddles,
        isOwner: userId === settings.personal_channel_owner_id,
      }),
    );
  }

  function isOwner(userId) {
    return userId === store.getSettings().personal_channel_owner_id;
  }

  async function handleNavigation(tab, { ack, body, client }) {
    await ack();
    const settings = store.getSettings();
    const activeTab = body.user.id === settings.personal_channel_owner_id ? tab : 'daily-update';
    await publishTab(client, body.user.id, activeTab);
  }

  async function handleOpenDailyUpdateModal({ ack, body, client }) {
    await ack();
    if (!isOwner(body.user.id)) {
      return;
    }

    await openModal(client, body.trigger_id, buildDailyUpdateModal({ draft: store.getDraft() }));
  }

  async function handleOpenThreadMessageModal({ ack, body, client }) {
    await ack();
    if (!isOwner(body.user.id)) {
      return;
    }

    await openModal(client, body.trigger_id, buildThreadMessageModal({ settings: store.getSettings() }));
  }

  async function handleOpenWelcomeMessageModal({ ack, body, client }) {
    await ack();
    if (!isOwner(body.user.id)) {
      return;
    }

    await openModal(client, body.trigger_id, buildWelcomeMessageModal({ settings: store.getSettings() }));
  }

  async function handleOpenPersonalChannelModal({ ack, body, client }) {
    await ack();
    if (!isOwner(body.user.id)) {
      return;
    }

    await openModal(client, body.trigger_id, buildPersonalChannelModal({ settings: store.getSettings() }));
  }

  async function handleOpenPingGroupModal({ ack, body, client }) {
    await ack();
    if (!isOwner(body.user.id)) {
      return;
    }

    const settings = store.getSettings();
    const groups = await fetchUserGroups(client);
    const selectedGroup = groups.find((group) => group.id === settings.daily_update_ping_user_group_id);
    await openModal(
      client,
      body.trigger_id,
      buildPingGroupModal({
        selectedGroup: selectedGroup
          ? {
              id: selectedGroup.id,
              label: selectedGroup.handle ? `@${selectedGroup.handle}` : selectedGroup.name,
            }
          : null,
      }),
    );
  }

  async function handlePingGroupOptions({ ack, payload, client }) {
    const query = (payload.value || '').trim().toLowerCase();
    const groups = await fetchUserGroups(client, { forceRefresh: true });
    const matches = groups.filter((group) =>
      `${group.name} ${group.handle} ${group.description}`.toLowerCase().includes(query),
    );

    await ack({
      options: matches.slice(0, 100).map((group) => ({
        text: {
          type: 'plain_text',
          text: group.handle ? `@${group.handle}` : group.name,
        },
        value: group.id,
      })),
    });
  }

  async function handleEditPingGroupSubmit({ ack, body, view, client }) {
    await ack();
    if (!isOwner(body.user.id)) {
      return;
    }

    const viewState = view.state.values;
    store.updateSettings({
      daily_update_ping_user_group_id: getStaticSelectValue(viewState, 'ping_group_block', 'select_ping_user_group'),
    });

    await publishTab(client, body.user.id, 'settings', ':white_check_mark: Ping group saved.');
  }

  async function handleComposeDailyUpdateSubmit({ ack, body, view, client }) {
    await ack();
    if (!isOwner(body.user.id)) {
      return;
    }

    const viewState = view.state.values;
    store.saveDraft({
      main_update_text: getRichTextInputValue(viewState, 'daily_update_main_block', 'daily_update_main_text'),
      song_text: getInputValue(viewState, 'daily_update_song_block', 'daily_update_song_text'),
      event_text: getInputValue(viewState, 'daily_update_event_block', 'daily_update_event_text'),
    });

    await publishTab(
      client,
      body.user.id,
      'daily-update',
      ':white_check_mark: Draft saved. Send it from the Daily Update tab.',
    );
  }

  async function handleEditThreadMessageSubmit({ ack, body, view, client }) {
    await ack();
    if (!isOwner(body.user.id)) {
      return;
    }

    const viewState = view.state.values;
    store.updateSettings({
      daily_update_thread_message: getRichTextInputValue(viewState, 'thread_message_block', 'thread_message_content'),
    });

    await publishTab(client, body.user.id, 'daily-update', ':white_check_mark: Thread message saved.');
  }

  async function handleEditWelcomeMessageSubmit({ ack, body, view, client }) {
    await ack();
    if (!isOwner(body.user.id)) {
      return;
    }

    const viewState = view.state.values;
    store.updateSettings({
      welcome_message_content: getRichTextInputValue(viewState, 'welcome_message_block', 'welcome_message_content'),
    });

    await publishTab(client, body.user.id, 'welcomer', ':white_check_mark: Welcome message saved.');
  }

  async function handleEditPersonalChannelSubmit({ ack, body, view, client }) {
    await ack();
    if (!isOwner(body.user.id)) {
      return;
    }

    const viewState = view.state.values;
    store.updateSettings({
      personal_channel_id: getConversationSelectValue(viewState, 'personal_channel_block', 'personal_channel_id'),
    });

    await publishTab(client, body.user.id, 'settings', ':white_check_mark: Personal channel saved.');
  }

  async function handleSendDailyUpdate({ ack, body, client, logger }) {
    await ack();
    const initialSettings = store.getSettings();

    if (body.user.id !== initialSettings.personal_channel_owner_id) {
      await publishTab(
        client,
        body.user.id,
        'daily-update',
        ':warning: Only the configured owner can send the Daily Update.',
      );
      return;
    }

    const viewState = body.view.state.values;
    const settings = store.updateSettings({
      daily_update_thread_enabled: getCheckboxEnabled(
        viewState,
        'daily_update_thread_toggle_block',
        'daily_update_thread_enabled',
      ),
    });

    const draft = store.getDraft();

    if (!contentToMrkdwn(draft.main_update_text).trim()) {
      await publishTab(
        client,
        body.user.id,
        'daily-update',
        ':x: Compose a Daily Update first using the Compose button.',
      );
      return;
    }

    if (!settings.personal_channel_id || !settings.daily_update_ping_user_group_id) {
      await publishTab(
        client,
        body.user.id,
        'daily-update',
        ':x: Configure the personal channel and Daily Update ping group first.',
      );
      return;
    }

    try {
      const todayKey = getLocalDateKey(new Date(), settings.timezone);
      const lastQuestion = store.getLastDailyQuestion();
      let questionText = '';

      if (aiService) {
        try {
          const aiResult = await aiService.generateDailyQuestion({
            prompt: settings.daily_question_prompt,
            recentQuestions: store.getRecentDailyQuestionTexts(5),
          });

          if (aiResult?.questionText) {
            questionText = aiResult.questionText;
            store.recordDailyQuestion({
              localDate: todayKey,
              questionText,
              topics: [],
              tone: '',
              customInstructions: '',
              questionHash: aiResult.questionHash,
              messageTs: null,
              sentAtUtc: null,
            });
          }
        } catch (generationError) {
          logger.error('Failed to generate a fresh Daily Question for the Daily Update', generationError);
        }
      }

      if (!questionText && settings.daily_question_include_in_daily_update && lastQuestion?.question_text) {
        questionText = lastQuestion.question_text;
      }

      const stepsResult = await homeAssistantService.fetchSteps();
      const stepsText = stepsResult?.steps != null ? `Today's Steps: ${stepsResult.steps}` : '';

      const sendResult = await sendDailyUpdate(client, settings, draft, questionText, {
        sentByUserId: body.user.id,
        stepsText,
      });

      store.recordDailyUpdateSend({
        sent_at_utc: new Date().toISOString(),
        local_date: todayKey,
        message_ts: sendResult.messageTs,
        thread_ts: settings.daily_update_thread_enabled ? sendResult.threadTs : null,
        main_update_text: draft.main_update_text,
        song_text: draft.song_text,
        event_text: draft.event_text,
        question_text: questionText,
        user_group_id: settings.daily_update_ping_user_group_id,
        sent_by_user_id: body.user.id,
      });
      store.clearDraft();
      await publishTab(client, body.user.id, 'daily-update', ':white_check_mark: Daily Update sent successfully.');
    } catch (error) {
      logger.error('Failed to send Daily Update', error);
      await publishTab(
        client,
        body.user.id,
        'daily-update',
        ':x: Asteria could not send the Daily Update. Your draft was preserved.',
      );
    }
  }

  async function handleSaveDailyQuestionSettings({ ack, body, client }) {
    await ack();
    const settings = store.getSettings();
    if (body.user.id !== settings.personal_channel_owner_id) {
      await publishTab(
        client,
        body.user.id,
        'daily-question',
        ':warning: Only the configured owner can change Daily Question settings.',
      );
      return;
    }

    const viewState = body.view.state.values;

    store.updateSettings({
      daily_question_enabled: getCheckboxEnabled(viewState, 'daily_question_enabled_block', 'daily_question_enabled'),
      daily_question_prompt: getInputValue(viewState, 'daily_question_prompt_block', 'daily_question_prompt'),
      daily_question_include_in_daily_update: getCheckboxEnabled(
        viewState,
        'daily_question_include_block',
        'daily_question_include_in_update',
      ),
      daily_question_send_time: normalizeTimeValue(
        getInputValue(viewState, 'daily_question_send_time_block', 'daily_question_send_time'),
        settings.daily_question_send_time,
      ),
    });

    await publishTab(client, body.user.id, 'daily-question', ':white_check_mark: Daily Question settings saved.');
  }

  async function handleOpenQuestionTestModal({ ack, body, client }) {
    await ack();
    if (!isOwner(body.user.id)) {
      return;
    }

    await openModal(client, body.trigger_id, buildQuestionTestModal());
  }

  async function handleQuestionTestSubmit({ ack, body, view, client, logger }) {
    const settings = store.getSettings();
    if (body.user.id !== settings.personal_channel_owner_id) {
      await ack();
      return;
    }

    if (!settings.personal_channel_id) {
      await ack({
        response_action: 'update',
        view: buildQuestionTestErrorModal({
          text: ':x: Configure the personal channel in Settings before testing the Daily Question.',
        }),
      });
      return;
    }

    if (!aiService) {
      await ack({
        response_action: 'update',
        view: buildQuestionTestErrorModal({ text: ':x: The AI service is not available.' }),
      });
      return;
    }

    const viewState = view.state.values;
    const mode = getStaticSelectValue(viewState, 'question_test_mode_block', 'question_test_mode') || 'preview';

    let aiResult;
    try {
      aiResult = await aiService.generateDailyQuestion({
        prompt: settings.daily_question_prompt,
        recentQuestions: store.getRecentDailyQuestionTexts(5),
      });
    } catch (error) {
      logger.error('Failed to generate a test Daily Question', error);
      await ack({
        response_action: 'update',
        view: buildQuestionTestErrorModal({ text: ':x: Could not generate a question. Please try again.' }),
      });
      return;
    }

    if (mode === 'preview') {
      await ack({
        response_action: 'update',
        view: buildQuestionPreviewModal({ questionText: aiResult.questionText }),
      });
      return;
    }

    await ack();
    try {
      const response = await sendDailyQuestion(client, settings, aiResult.questionText);
      store.recordDailyQuestion({
        localDate: getLocalDateKey(new Date(), settings.timezone),
        questionText: aiResult.questionText,
        topics: [],
        tone: '',
        customInstructions: '',
        questionHash: aiResult.questionHash,
        messageTs: response.messageTs,
        sentAtUtc: new Date().toISOString(),
      });
      await publishTab(client, body.user.id, 'daily-question', ':white_check_mark: Test Daily Question sent.');
    } catch (error) {
      logger.error('Failed to send a test Daily Question', error);
      await publishTab(client, body.user.id, 'daily-question', ':x: Asteria could not send the test Daily Question.');
    }
  }

  async function handleSaveWelcomerSettings({ ack, body, client }) {
    await ack();
    const settings = store.getSettings();
    if (body.user.id !== settings.personal_channel_owner_id) {
      await publishTab(
        client,
        body.user.id,
        'welcomer',
        ':warning: Only the configured owner can change Welcomer settings.',
      );
      return;
    }

    const viewState = body.view.state.values;
    const rulesCanvasUrl = getInputValue(viewState, 'rules_canvas_block', 'rules_canvas_url').trim();

    store.updateSettings({
      welcomer_enabled: getCheckboxEnabled(viewState, 'welcomer_enabled_block', 'welcomer_enabled'),
      rules_canvas_url: rulesCanvasUrl,
    });

    await publishTab(client, body.user.id, 'welcomer', ':white_check_mark: Welcomer settings saved.');
  }

  async function handleSaveGeneralSettings({ ack, body, client }) {
    await ack();
    const settings = store.getSettings();
    if (body.user.id !== settings.personal_channel_owner_id) {
      await publishTab(
        client,
        body.user.id,
        'settings',
        ':warning: Only the configured owner can change general settings.',
      );
      return;
    }

    const viewState = body.view.state.values;
    const timezone = getInputValue(viewState, 'timezone_block', 'timezone').trim();
    const reminderTime = normalizeTimeValue(
      getInputValue(viewState, 'daily_update_reminder_time_block', 'daily_update_reminder_time'),
      settings.daily_update_reminder_time,
    );

    if (!isValidTimeZone(timezone)) {
      await publishTab(
        client,
        body.user.id,
        'settings',
        ':x: Please enter a valid IANA timezone such as Europe/London or America/New_York.',
      );
      return;
    }

    store.updateSettings({
      bot_display_name: getInputValue(viewState, 'bot_name_block', 'bot_display_name'),
      timezone,
      daily_update_reminder_enabled: getCheckboxEnabled(
        viewState,
        'daily_update_reminder_enabled_block',
        'daily_update_reminder_enabled',
      ),
      daily_update_reminder_time: reminderTime,
    });

    await publishTab(client, body.user.id, 'settings', ':white_check_mark: General settings saved.');
  }

  async function handleSaveSyncSettings({ ack, body, client }) {
    await ack();
    const settings = store.getSettings();
    if (body.user.id !== settings.personal_channel_owner_id) {
      await publishTab(client, body.user.id, 'sync', ':warning: Only the configured owner can change sync settings.');
      return;
    }

    const viewState = body.view.state.values;
    const patch = {
      enabled: getCheckboxEnabled(viewState, 'sync_enabled_block', 'sync_enabled'),
      todoist_api_token: getInputValue(viewState, 'sync_todoist_api_token_block', 'sync_todoist_api_token'),
      slack_list_id: getInputValue(viewState, 'sync_slack_list_id_block', 'sync_slack_list_id'),
      todoist_project_name: getInputValue(viewState, 'sync_todoist_project_name_block', 'sync_todoist_project_name'),
      notification_channel_id: getInputValue(
        viewState,
        'sync_notification_channel_id_block',
        'sync_notification_channel_id',
      ),
      poll_interval_seconds: getInputValue(viewState, 'sync_poll_interval_block', 'sync_poll_interval'),
    };
    const webhookSecretInput = getInputValue(viewState, 'sync_webhook_secret_block', 'sync_webhook_secret');
    if (webhookSecretInput) {
      patch.webhook_secret = webhookSecretInput;
    }
    store.updateSyncSettings(patch);

    await publishTab(client, body.user.id, 'sync', ':white_check_mark: Sync settings saved.');
  }

  async function handleSaveHomeAssistantSettings({ ack, body, client }) {
    await ack();
    const settings = store.getSettings();
    if (body.user.id !== settings.personal_channel_owner_id) {
      await publishTab(
        client,
        body.user.id,
        'home-assistant',
        ':warning: Only the configured owner can change Home Assistant settings.',
      );
      return;
    }

    const viewState = body.view.state.values;
    store.updateSettings({
      home_assistant_url: getInputValue(viewState, 'home_assistant_url_block', 'home_assistant_url'),
      home_assistant_token: getInputValue(viewState, 'home_assistant_token_block', 'home_assistant_token'),
      home_assistant_steps_entity: getInputValue(viewState, 'home_assistant_steps_entity_block', 'home_assistant_steps_entity'),
    });

    await publishTab(client, body.user.id, 'home-assistant', ':white_check_mark: Home Assistant settings saved.');
  }

  async function handleTestHomeAssistantSteps({ ack, body, client }) {
    await ack();
    const settings = store.getSettings();
    if (body.user.id !== settings.personal_channel_owner_id) {
      await publishTab(client, body.user.id, 'home-assistant', ':warning: Only the configured owner can test Home Assistant.');
      return;
    }

    const result = await homeAssistantService.fetchSteps();

    if (!result.configured) {
      await publishTab(
        client,
        body.user.id,
        'home-assistant',
        ':x: Configure the Home Assistant URL, token, and steps entity first.',
      );
      return;
    }

    if (result.error) {
      await publishTab(client, body.user.id, 'home-assistant', `:x: Could not fetch steps: ${result.error}`);
      return;
    }

    await publishTab(
      client,
      body.user.id,
      'home-assistant',
      `:white_check_mark: Current step count: *${result.steps}*`,
    );
  }

  async function handleAppHomeOpened({ event, client }) {
    if (event.tab !== 'home') {
      return;
    }

    await publishTab(client, event.user, 'daily-update');
  }

  async function handleMemberJoinedChannel({ event, client, logger }) {
    const settings = store.getSettings();
    if (!settings.welcomer_enabled || !settings.personal_channel_id || event.channel !== settings.personal_channel_id) {
      return;
    }

    if (settings.personal_channel_owner_id && event.user === settings.personal_channel_owner_id) {
      return;
    }

    if (
      event.event_ts &&
      store.hasWelcomeEvent({
        eventTs: event.event_ts,
        channelId: event.channel,
        userId: event.user,
      })
    ) {
      return;
    }

    try {
      const response = await sendWelcomeMessage(client, settings, {
        userId: event.user,
      });
      if (event.event_ts) {
        store.recordWelcomeEvent({
          eventTs: event.event_ts,
          channelId: event.channel,
          userId: event.user,
          messageTs: response.ts,
        });
      }

      const pingGroupId = settings.daily_update_ping_user_group_id;
      if (pingGroupId && !store.hasGroupOptOut({ userId: event.user, userGroupId: pingGroupId })) {
        try {
          await addUserToUserGroup(client, pingGroupId, event.user);
        } catch (groupError) {
          logger.error('Failed to auto-add member to Daily Update group', groupError);
        }

        try {
          await client.chat.postEphemeral({
            channel: event.channel,
            user: event.user,
            text: `You've been automatically added to <!subteam^${pingGroupId}> so you'll get the Daily Update.`,
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `You've been automatically added to <!subteam^${pingGroupId}> so you'll get the Daily Update.`,
                },
              },
              {
                type: 'actions',
                block_id: 'dag_opt_out_block',
                elements: [
                  {
                    type: 'button',
                    text: { type: 'plain_text', text: 'Opt out of the Daily Update' },
                    action_id: 'opt_out_of_dag',
                    value: JSON.stringify({
                      userId: event.user,
                      userGroupId: pingGroupId,
                    }),
                    style: 'danger',
                  },
                ],
              },
            ],
          });
        } catch (ephemeralError) {
          logger.error('Failed to post opt-out ephemeral to new member', ephemeralError);
        }
      }
    } catch (error) {
      logger.error('Failed to send welcome message', error);
    }
  }

  async function handleOptOutOfDag({ ack, body, client, logger }) {
    await ack();

    let payload = { userId: '', userGroupId: '' };
    try {
      payload = JSON.parse(body.actions?.[0]?.value || '{}');
    } catch {
      logger.error('Invalid opt-out payload', body.actions?.[0]?.value);
    }

    const { userId, userGroupId } = payload;
    const settings = store.getSettings();
    const ownerId = settings.personal_channel_owner_id;
    const groupId = userGroupId || settings.daily_update_ping_user_group_id;

    if (!userId || !groupId) {
      return;
    }

    if (groupId && store.hasGroupOptOut({ userId, userGroupId: groupId })) {
      return;
    }

    if (groupId) {
      store.recordGroupOptOut({ userId, userGroupId: groupId, optedOutAtUtc: new Date().toISOString() });
    }

    try {
      await removeUserFromUserGroup(client, groupId, userId);
    } catch (groupError) {
      logger.error('Failed to remove opted-out member from Daily Update group', groupError);
    }

    try {
      await client.chat.postEphemeral({
        channel: body.channel?.id || settings.personal_channel_id,
        user: userId,
        text: "You've opted out of the Daily Update. Someone's been notified.",
      });
    } catch (ephemeralError) {
      logger.error('Failed to confirm opt-out to member', ephemeralError);
    }

    if (ownerId) {
      try {
        await sendDirectMessage(
          client,
          ownerId,
          `<@${userId}> opted out of the Daily Update group (<!subteam^${groupId}>).`,
        );
      } catch (dmError) {
        logger.error('Failed to notify owner of Daily Update opt-out', dmError);
      }
    }
  }

  app.action('navigate_daily_update', (payload) => handleNavigation('daily-update', payload));
  app.action('navigate_daily_question', (payload) => handleNavigation('daily-question', payload));
  app.action('navigate_welcomer', (payload) => handleNavigation('welcomer', payload));
  app.action('navigate_home_assistant', (payload) => handleNavigation('home-assistant', payload));
  app.action('navigate_huddles', (payload) => handleNavigation('huddles', payload));
  app.action('navigate_sync', (payload) => handleNavigation('sync', payload));
  app.action('navigate_settings', (payload) => handleNavigation('settings', payload));
  app.action('open_daily_update_modal', handleOpenDailyUpdateModal);
  app.action('open_thread_message_modal', handleOpenThreadMessageModal);
  app.action('open_welcome_message_modal', handleOpenWelcomeMessageModal);
  app.action('open_personal_channel_modal', handleOpenPersonalChannelModal);
  app.action('open_ping_group_modal', handleOpenPingGroupModal);
  app.options('select_ping_user_group', handlePingGroupOptions);
  app.action('send_daily_update', handleSendDailyUpdate);
  app.action('save_daily_question_settings', handleSaveDailyQuestionSettings);
  app.action('open_question_test_modal', handleOpenQuestionTestModal);
  app.view('test_daily_question_submit', handleQuestionTestSubmit);
  app.action('save_welcomer_settings', handleSaveWelcomerSettings);
  app.action('save_general_settings', handleSaveGeneralSettings);
  app.action('save_sync_settings', handleSaveSyncSettings);
  app.action('save_home_assistant_settings', handleSaveHomeAssistantSettings);
  app.action('test_home_assistant_steps', handleTestHomeAssistantSteps);
  app.action('opt_out_of_dag', handleOptOutOfDag);
  app.view('compose_daily_update_submit', handleComposeDailyUpdateSubmit);
  app.view('edit_thread_message_submit', handleEditThreadMessageSubmit);
  app.view('edit_welcome_message_submit', handleEditWelcomeMessageSubmit);
  app.view('edit_personal_channel_submit', handleEditPersonalChannelSubmit);
  app.view('edit_ping_group_submit', handleEditPingGroupSubmit);
  app.event('app_home_opened', handleAppHomeOpened);
  app.event('member_joined_channel', handleMemberJoinedChannel);

  return {
    publishTab,
  };
}
