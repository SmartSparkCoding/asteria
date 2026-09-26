import { createHomeAssistantService } from '../services/home-assistant.js';
import {
  addUserToUserGroup,
  fetchUserGroups,
  removeUserFromUserGroup,
  sendDailyQuestion,
  sendDailyUpdate,
  sendDirectMessage,
  sendWelcomeMessage,
} from '../services/slack.js';
import { contentToMrkdwn, formatDailyQuestionMessage, parseMessageLink } from '../utils/messages.js';
import { getLocalDateKey, isValidTimeZone, normalizeTimeValue } from '../utils/time.js';
import {
  buildDailyUpdateModal,
  buildHuddleChannelModal,
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

const SLACK_USER_ID_PATTERN = /^[UW][0-9A-Z]{2,}$/;

/** Accepts "U123, U456", "<@U123>", whitespace — keeps only plausible Slack IDs, in order. */
function parseOwnerIdList(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.filter((id) => typeof id === 'string' && SLACK_USER_ID_PATTERN.test(id)))];
  }
  const text = typeof value === 'string' ? value : '';
  const found = text.match(/[UW][0-9A-Z]{2,}/g) || [];
  return [...new Set(found)];
}

const HUDDLE_CHANNEL_OPS = [
  'configure',
  'toggle_tracking',
  'toggle_auto_replies',
  'toggle_restrict',
  'pause',
  'resume',
];

/**
 * Per-channel huddle controls suffix their action_id with the channel (and pause
 * duration), because Slack rejects a view that repeats an action_id. The channel
 * itself travels in the button value.
 */
const HUDDLE_CHANNEL_ACTION_PATTERN = new RegExp(`^huddle_channel_(?:${HUDDLE_CHANNEL_OPS.join('|')})(?:_[A-Z0-9]+)*$`);

function huddleChannelOpFromActionId(actionId) {
  const rest = String(actionId ?? '').replace(/^huddle_channel_/, '');
  return HUDDLE_CHANNEL_OPS.find((op) => rest === op || rest.startsWith(`${op}_`)) ?? '';
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

  let botChannelIdsCache = { ids: [], fetchedAt: 0 };
  const BOT_CHANNEL_CACHE_MS = 5 * 60 * 1000;

  /**
   * The channels the bot itself is a member of. Huddle events are workspace-wide, so the
   * Logs tab is filtered down to these. Falls back to channels we have seen huddles in.
   */
  async function listBotChannelIds(client) {
    const now = Date.now();
    if (botChannelIdsCache.ids.length > 0 && now - botChannelIdsCache.fetchedAt < BOT_CHANNEL_CACHE_MS) {
      return botChannelIdsCache.ids;
    }
    let ids = [];
    try {
      let cursor = '';
      do {
        const page = await client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        for (const conversation of page?.channels || []) {
          if (conversation.is_member) {
            ids.push(conversation.id);
          }
        }
        cursor = page?.response_metadata?.next_cursor || '';
      } while (cursor);
    } catch {
      ids = [];
    }
    if (ids.length === 0) {
      ids = store.listHuddleChannelIds();
    }
    botChannelIdsCache = { ids, fetchedAt: now };
    return ids;
  }

  function configuredChannelOwnerIds() {
    return new Set(
      store
        .listHuddleChannels()
        .flatMap((row) => (typeof row.owner_ids === 'string' ? parseOwnerIdList(row.owner_ids) : row.owner_ids || [])),
    );
  }

  function isChannelOwner(userId) {
    return configuredChannelOwnerIds().has(userId);
  }

  function mayConfigureChannel(userId, channelId) {
    if (isOwner(userId)) {
      return true;
    }
    const owners = parseOwnerIdList(store.getHuddleChannel(channelId)?.owner_ids);
    return owners.includes(userId);
  }

  function visibleHuddleChannels(userId) {
    const now = Math.floor(Date.now() / 1000);
    return store
      .listTrackedHuddleChannels()
      .filter((channel) => isOwner(userId) || (channel.owner_ids || []).includes(userId))
      .map((channel) => ({
        channelId: channel.channel_id,
        name: channel.name || '',
        enabled: !!channel.enabled,
        autoReplies: !!channel.auto_replies,
        restrictTriggers: !!channel.restrict_triggers,
        ownerIds: channel.owner_ids || [],
        pausedUntil: channel.paused_until || 0,
        paused: (channel.paused_until || 0) > now,
        configured: channel.configured,
      }));
  }

  async function publishTab(client, userId, category, sub, notice = '') {
    const settings = store.getSettings();
    const syncSettings = store.getSyncSettings();
    const draft = store.getDraft();
    const recentQuestions = store.getRecentDailyQuestionTexts(5);
    const lastQuestion = store.getLastDailyQuestion();
    const questionPreview =
      settings.daily_question_enabled && lastQuestion?.question_text
        ? formatDailyQuestionMessage(lastQuestion.question_text, settings.daily_question_reply_text)
        : '';
    const huddles = store
      .listHuddles()
      .filter((huddle) => huddle.channel_id && huddle.status !== 'opted_out')
      .slice(0, 10);
    const leaderboard = store.listHuddleLeaderboard(20);
    const isOwnerUser = userId === settings.personal_channel_owner_id;
    const isChannelOwnerUser = !isOwnerUser && isChannelOwner(userId);
    const logs =
      isOwnerUser && category === 'huddles' && sub === 'logs'
        ? store.listTriggerLog(30, await listBotChannelIds(client))
        : [];
    const huddleChannels = isOwnerUser || isChannelOwnerUser ? visibleHuddleChannels(userId) : [];

    await publishHome(
      client,
      userId,
      buildHomeView({
        category,
        sub,
        settings,
        syncSettings,
        draft,
        questionPreview,
        recentQuestions,
        notice,
        huddles,
        huddleChannels,
        leaderboard,
        logs,
        isOwner: isOwnerUser,
        isChannelOwner: isChannelOwnerUser,
      }),
    );
  }

  function isOwner(userId) {
    return userId === store.getSettings().personal_channel_owner_id;
  }

  async function handleNavigation(category, sub, { ack, body, client }) {
    await ack();
    const appOwner = isOwner(body.user.id);
    const channelOwner = !appOwner && isChannelOwner(body.user.id);
    if (!appOwner && !channelOwner) {
      await publishTab(client, body.user.id, 'huddles', 'leaderboard');
      return;
    }
    const nextCategory = category === 'channels' && !appOwner ? 'huddles' : category;
    await publishTab(client, body.user.id, nextCategory, sub);
  }

  function describeChannelChange(before, after) {
    const changes = [];
    if (before.enabled !== after.enabled) {
      changes.push(`tracking ${after.enabled ? 'on' : 'off'}`);
    }
    if (before.autoReplies !== after.autoReplies) {
      changes.push(`auto replies ${after.autoReplies ? 'on' : 'off'}`);
    }
    if (before.restrictTriggers !== after.restrictTriggers) {
      changes.push(`trigger access ${after.restrictTriggers ? 'owners only' : 'anyone'}`);
    }
    if (before.pausedUntil !== after.pausedUntil) {
      changes.push(after.pausedUntil > Math.floor(Date.now() / 1000) ? 'paused' : 'resumed');
    }
    if (before.ownerIds.join(',') !== after.ownerIds.join(',')) {
      changes.push(
        after.ownerIds.length > 0
          ? `owners set to ${after.ownerIds.map((id) => `<@${id}>`).join(' ')}`
          : 'owners cleared',
      );
    }
    return changes.join(', ') || 'no changes';
  }

  function currentChannelState(channelId) {
    const row = store.getHuddleChannel(channelId);
    return {
      enabled: !!row?.enabled,
      autoReplies: !!row?.auto_replies,
      restrictTriggers: !!row?.restrict_triggers,
      pausedUntil: Number(row?.paused_until) || 0,
      ownerIds: parseOwnerIdList(row?.owner_ids),
      name: row?.name || '',
    };
  }

  function logChannelConfigChange(userId, channelId, before, after) {
    store.recordTriggerLog({
      userId,
      action: 'huddle_channel_config',
      detail: `${channelId}: ${describeChannelChange(before, after)}`,
      channelId,
    });
  }

  async function applyChannelConfigChange({ ack, body, client, channelId, mutate }) {
    await ack();
    if (!channelId) {
      return;
    }
    if (!mayConfigureChannel(body.user.id, channelId)) {
      return;
    }
    const before = currentChannelState(channelId);
    mutate();
    const after = currentChannelState(channelId);
    logChannelConfigChange(body.user.id, channelId, before, after);
    await publishTab(client, body.user.id, 'huddles', 'huddle-channels', 'Saved :white_check_mark:');
  }

  async function handleToggleTracking({ ack, body, client }) {
    const channelId = body?.actions?.[0]?.value;
    const next = !currentChannelState(channelId).enabled;
    await applyChannelConfigChange({
      ack,
      body,
      client,
      channelId,
      mutate: () => store.setHuddleChannelFlag(channelId, 'enabled', next),
    });
  }

  async function handleToggleAutoReplies({ ack, body, client }) {
    const channelId = body?.actions?.[0]?.value;
    const next = !currentChannelState(channelId).autoReplies;
    await applyChannelConfigChange({
      ack,
      body,
      client,
      channelId,
      mutate: () => store.setHuddleChannelFlag(channelId, 'auto_replies', next),
    });
  }

  async function handleToggleRestrict({ ack, body, client }) {
    const channelId = body?.actions?.[0]?.value;
    const next = !currentChannelState(channelId).restrictTriggers;
    await applyChannelConfigChange({
      ack,
      body,
      client,
      channelId,
      mutate: () => store.setHuddleChannelFlag(channelId, 'restrict_triggers', next),
    });
  }

  async function handlePauseChannel({ ack, body, client }) {
    const raw = body?.actions?.[0]?.value || '';
    const [channelId, minutesRaw] = raw.split(':');
    const minutes = Number(minutesRaw);
    if (!channelId || !Number.isFinite(minutes) || minutes <= 0) {
      await ack();
      return;
    }
    await applyChannelConfigChange({
      ack,
      body,
      client,
      channelId,
      mutate: () => store.setHuddleChannelFlag(channelId, 'paused_until', Math.floor(Date.now() / 1000) + minutes * 60),
    });
  }

  async function handleResumeChannel({ ack, body, client }) {
    const channelId = body?.actions?.[0]?.value;
    await applyChannelConfigChange({
      ack,
      body,
      client,
      channelId,
      mutate: () => store.setHuddleChannelFlag(channelId, 'paused_until', 0),
    });
  }

  const HUDDLE_CHANNEL_HANDLERS = {
    configure: handleOpenHuddleChannelConfig,
    toggle_tracking: handleToggleTracking,
    toggle_auto_replies: handleToggleAutoReplies,
    toggle_restrict: handleToggleRestrict,
    pause: handlePauseChannel,
    resume: handleResumeChannel,
  };

  async function handleHuddleChannelAction(op, payload) {
    const handler = HUDDLE_CHANNEL_HANDLERS[op];
    if (!handler) {
      return undefined;
    }
    return handler(payload);
  }

  async function handleOpenHuddleChannelConfig({ ack, body, client }) {
    await ack();
    const channelId = body?.actions?.[0]?.value;
    if (!channelId || !mayConfigureChannel(body.user.id, channelId)) {
      return;
    }
    const state = currentChannelState(channelId);
    await openModal(
      client,
      body.trigger_id,
      buildHuddleChannelModal({
        channel: { channelId, ...state },
      }),
    );
  }

  async function handleHuddleChannelConfigSubmit({ ack, body, client, view }) {
    await ack();
    const channelId = view?.private_metadata || body?.view?.private_metadata || '';
    if (!channelId || !mayConfigureChannel(body.user.id, channelId)) {
      return;
    }
    const values = body?.view?.state?.values || {};
    const ownerIds = parseOwnerIdList(values.huddle_channel_owners_block?.huddle_channel_owners_value?.value);
    const tracking = values.huddle_channel_tracking_block?.huddle_channel_tracking_value?.selected_option?.value;
    const replies = values.huddle_channel_replies_block?.huddle_channel_replies_value?.selected_option?.value;
    const restrict = values.huddle_channel_restrict_block?.huddle_channel_restrict_value?.selected_option?.value;
    const pauseMinutes = Number(
      values.huddle_channel_pause_block?.huddle_channel_pause_value?.selected_option?.value ?? '0',
    );
    const before = currentChannelState(channelId);
    store.upsertHuddleChannel({
      channelId,
      name: before.name,
      enabled: tracking !== 'off',
      autoReplies: replies !== 'off',
      restrictTriggers: restrict === 'owners',
      ownerIds,
      pausedUntil:
        Number.isFinite(pauseMinutes) && pauseMinutes > 0 ? Math.floor(Date.now() / 1000) + pauseMinutes * 60 : 0,
    });
    const after = currentChannelState(channelId);
    logChannelConfigChange(body.user.id, channelId, before, after);
    await publishTab(client, body.user.id, 'huddles', 'huddle-channels', 'Saved :white_check_mark:');
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

    await publishTab(client, body.user.id, 'channels', 'settings', ':white_check_mark: Ping group saved.');
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
      'channels',
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

    await publishTab(client, body.user.id, 'channels', 'daily-update', ':white_check_mark: Thread message saved.');
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

    await publishTab(client, body.user.id, 'channels', 'welcomer', ':white_check_mark: Welcome message saved.');
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

    await publishTab(client, body.user.id, 'channels', 'settings', ':white_check_mark: Personal channel saved.');
  }

  async function handleSendDailyUpdate({ ack, body, client, logger }) {
    await ack();
    const initialSettings = store.getSettings();

    if (body.user.id !== initialSettings.personal_channel_owner_id) {
      await publishTab(
        client,
        body.user.id,
        'channels',
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
        'channels',
        'daily-update',
        ':x: Compose a Daily Update first using the Compose button.',
      );
      return;
    }

    if (!settings.personal_channel_id || !settings.daily_update_ping_user_group_id) {
      await publishTab(
        client,
        body.user.id,
        'channels',
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
      await publishTab(
        client,
        body.user.id,
        'channels',
        'daily-update',
        ':white_check_mark: Daily Update sent successfully.',
      );
    } catch (error) {
      logger.error('Failed to send Daily Update', error);
      await publishTab(
        client,
        body.user.id,
        'channels',
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
        'channels',
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

    await publishTab(
      client,
      body.user.id,
      'channels',
      'daily-question',
      ':white_check_mark: Daily Question settings saved.',
    );
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
      await publishTab(
        client,
        body.user.id,
        'channels',
        'daily-question',
        ':white_check_mark: Test Daily Question sent.',
      );
    } catch (error) {
      logger.error('Failed to send a test Daily Question', error);
      await publishTab(
        client,
        body.user.id,
        'channels',
        'daily-question',
        ':x: Asteria could not send the test Daily Question.',
      );
    }
  }

  async function handleSaveWelcomerSettings({ ack, body, client }) {
    await ack();
    const settings = store.getSettings();
    if (body.user.id !== settings.personal_channel_owner_id) {
      await publishTab(
        client,
        body.user.id,
        'channels',
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

    await publishTab(client, body.user.id, 'channels', 'welcomer', ':white_check_mark: Welcomer settings saved.');
  }

  async function handleSaveGeneralSettings({ ack, body, client }) {
    await ack();
    const settings = store.getSettings();
    if (body.user.id !== settings.personal_channel_owner_id) {
      await publishTab(
        client,
        body.user.id,
        'channels',
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
        'channels',
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

    await publishTab(client, body.user.id, 'channels', 'settings', ':white_check_mark: General settings saved.');
  }

  async function handleSaveSyncSettings({ ack, body, client }) {
    await ack();
    const settings = store.getSettings();
    if (body.user.id !== settings.personal_channel_owner_id) {
      await publishTab(
        client,
        body.user.id,
        'channels',
        'sync',
        ':warning: Only the configured owner can change sync settings.',
      );
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

    await publishTab(client, body.user.id, 'channels', 'sync', ':white_check_mark: Sync settings saved.');
  }

  async function handleSaveHomeAssistantSettings({ ack, body, client }) {
    await ack();
    const settings = store.getSettings();
    if (body.user.id !== settings.personal_channel_owner_id) {
      await publishTab(
        client,
        body.user.id,
        'channels',
        'home-assistant',
        ':warning: Only the configured owner can change Home Assistant settings.',
      );
      return;
    }

    const viewState = body.view.state.values;
    store.updateSettings({
      home_assistant_url: getInputValue(viewState, 'home_assistant_url_block', 'home_assistant_url'),
      home_assistant_token: getInputValue(viewState, 'home_assistant_token_block', 'home_assistant_token'),
      home_assistant_steps_entity: getInputValue(
        viewState,
        'home_assistant_steps_entity_block',
        'home_assistant_steps_entity',
      ),
    });

    await publishTab(
      client,
      body.user.id,
      'channels',
      'home-assistant',
      ':white_check_mark: Home Assistant settings saved.',
    );
  }

  async function handleTestHomeAssistantSteps({ ack, body, client }) {
    await ack();
    const settings = store.getSettings();
    if (body.user.id !== settings.personal_channel_owner_id) {
      await publishTab(
        client,
        body.user.id,
        'channels',
        'home-assistant',
        ':warning: Only the configured owner can test Home Assistant.',
      );
      return;
    }

    const result = await homeAssistantService.fetchSteps();

    if (!result.configured) {
      await publishTab(
        client,
        body.user.id,
        'channels',
        'home-assistant',
        ':x: Configure the Home Assistant URL, token, and steps entity first.',
      );
      return;
    }

    if (result.error) {
      await publishTab(
        client,
        body.user.id,
        'channels',
        'home-assistant',
        `:x: Could not fetch steps: ${result.error}`,
      );
      return;
    }

    await publishTab(
      client,
      body.user.id,
      'channels',
      'home-assistant',
      `:white_check_mark: Current step count: *${result.steps}*`,
    );
  }

  async function handleAppHomeOpened({ event, client }) {
    if (event.tab !== 'home') {
      return;
    }

    if (isOwner(event.user)) {
      await publishTab(client, event.user, 'channels', 'daily-update');
      return;
    }
    await publishTab(client, event.user, 'huddles', isChannelOwner(event.user) ? 'huddle-channels' : 'leaderboard');
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
    store.recordTriggerLog({ userId: body?.user?.id, action: 'daily_update_opt_out', detail: groupId });

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

  async function handleDeleteMessageSubmit({ ack, body, client, logger }) {
    await ack();
    if (!isOwner(body.user.id)) {
      return;
    }
    const link = getInputValue(body.view?.state?.values, 'delete_message_link_block', 'delete_message_link');
    const parsed = parseMessageLink(link);
    if (!parsed) {
      await publishTab(client, body.user.id, 'channels', 'delete', "That doesn't look like a Slack message link.");
      return;
    }
    store.recordTriggerLog({
      userId: body.user.id,
      action: 'delete_message',
      detail: `${parsed.channel}/${parsed.ts}`,
      channelId: parsed.channel,
    });
    try {
      await client.chat.delete({ channel: parsed.channel, ts: parsed.ts });
      await publishTab(client, body.user.id, 'channels', 'delete', `Deleted <#${parsed.channel}> ts \`${parsed.ts}\`.`);
    } catch (error) {
      logger.error('Failed to delete message', error);
      await publishTab(
        client,
        body.user.id,
        'channels',
        'delete',
        "I couldn't delete that one — it may not be a message I sent.",
      );
    }
  }

  app.action('navigate_category_channels', (payload) => handleNavigation('channels', 'daily-update', payload));
  app.action('navigate_category_huddles', (payload) => handleNavigation('huddles', 'huddle-channels', payload));
  for (const sub of [
    'daily-update',
    'daily-question',
    'welcomer',
    'home-assistant',
    'sync',
    'settings',
    'delete',
    'huddle_channels',
    'huddles',
    'leaderboard',
    'logs',
  ]) {
    app.action(`navigate_sub_${sub}`, (payload) => {
      const value = payload?.body?.actions?.[0]?.value || '';
      const [category, target] = value.includes('/') ? value.split('/') : ['huddles', sub.replace(/_/g, '-')];
      return handleNavigation(category, target, payload);
    });
  }

  app.action(HUDDLE_CHANNEL_ACTION_PATTERN, (payload) =>
    handleHuddleChannelAction(huddleChannelOpFromActionId(payload?.body?.actions?.[0]?.action_id), payload),
  );
  app.view('huddle_channel_config_submit', handleHuddleChannelConfigSubmit);
  app.action('delete_message_submit', handleDeleteMessageSubmit);
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
    handleHuddleChannelAction,
  };
}
