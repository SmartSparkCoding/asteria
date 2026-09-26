import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import { createHomeHandlers } from '../src/app-home/handlers.js';
import { createStore } from '../src/database/store.js';

let createdPaths = [];

afterEach(() => {
  for (const databasePath of createdPaths) {
    fs.rmSync(path.dirname(databasePath), { recursive: true, force: true });
  }
  createdPaths = [];
});

function createHandlerTestHarness({ store, aiService, botChannelIds = ['Crandom', 'Csecond'] }) {
  const handlers = {};
  const app = {
    action: (actionId, handler) => {
      handlers[`action:${actionId}`] = handler;
    },
    view: (callbackId, handler) => {
      handlers[`view:${callbackId}`] = handler;
    },
    options: (actionId, handler) => {
      handlers[`options:${actionId}`] = handler;
    },
    event: (eventName, handler) => {
      handlers[`event:${eventName}`] = handler;
    },
    error: mock.fn(),
  };
  const botChannels = { list: mock.fn(async () => botChannelIds) };
  const { publishTab, handleHuddleChannelAction } = createHomeHandlers({
    app,
    store,
    aiService,
    botChannels,
  });
  return { ...handlers, publishTab, handleHuddleChannelAction, botChannels };
}

function createClient() {
  return {
    users: {
      profile: {
        get: mock.fn(async () => ({
          profile: {
            display_name: 'Jordan',
            image_192: 'https://example.com/avatar-192.png',
          },
        })),
      },
    },
    chat: {
      postMessage: mock.fn(async () => ({ ts: '111.222' })),
    },
    views: {
      publish: mock.fn(async () => ({})),
      open: mock.fn(async () => ({})),
    },
    usergroups: {
      list: mock.fn(async () => ({ usergroups: [] })),
    },
  };
}

const THREAD_TOGGLE_STATE = {
  daily_update_thread_toggle_block: {
    daily_update_thread_enabled: {
      selected_options: [{ value: 'enabled' }],
    },
  },
};

describe('App Home handlers', () => {
  it('sends the Daily Update from the saved draft and clears it on success', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-apphome-'));
    const databasePath = path.join(tempDir, 'asteria.sqlite');
    createdPaths.push(databasePath);

    const store = await createStore(databasePath);
    store.updateSettings({
      personal_channel_owner_id: 'UOWNER',
      personal_channel_id: 'C123',
      daily_update_ping_user_group_id: 'S123',
      daily_update_thread_enabled: true,
      daily_update_thread_message: ':thread: here please!!',
    });
    store.saveDraft({
      main_update_text: 'Today update',
      song_text: 'Song',
      event_text: 'Event',
    });

    const client = createClient();
    const handlers = createHandlerTestHarness({ store });

    await handlers['action:send_daily_update']({
      ack: mock.fn(),
      body: {
        user: { id: 'UOWNER' },
        view: {
          state: {
            values: THREAD_TOGGLE_STATE,
          },
        },
      },
      client,
      logger: { error: mock.fn() },
    });

    const settings = store.getSettings();
    assert.equal(settings.daily_update_thread_enabled, true);
    assert.equal(settings.daily_update_thread_message, ':thread: here please!!');

    assert.equal(client.chat.postMessage.mock.callCount(), 2);
    const mainCall = client.chat.postMessage.mock.calls[0].arguments[0];
    assert.equal(mainCall.username, 'Jordan');
    assert.equal(mainCall.icon_url, 'https://example.com/avatar-192.png');
    assert(mainCall.text.includes('Today update'));
    const threadCall = client.chat.postMessage.mock.calls[1].arguments[0];
    assert.equal(threadCall.thread_ts, undefined);
    assert.equal(threadCall.username, 'Asteria');
    assert.equal(store.getDraft().main_update_text, '');
    store.close();
  });

  it('requires a composed draft before sending the Daily Update', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-apphome-'));
    const databasePath = path.join(tempDir, 'asteria.sqlite');
    createdPaths.push(databasePath);

    const store = await createStore(databasePath);
    store.updateSettings({
      personal_channel_owner_id: 'UOWNER',
      personal_channel_id: 'C123',
      daily_update_ping_user_group_id: 'S123',
    });

    const client = createClient();
    const handlers = createHandlerTestHarness({ store });

    await handlers['action:send_daily_update']({
      ack: mock.fn(),
      body: {
        user: { id: 'UOWNER' },
        view: { state: { values: {} } },
      },
      client,
      logger: { error: mock.fn() },
    });

    assert.equal(client.chat.postMessage.mock.callCount(), 0);
    const publishArgs = client.views.publish.mock.calls[0].arguments[0];
    assert(publishArgs.view.blocks.some((block) => block.elements?.[0]?.text?.includes('Compose a Daily Update')));
    store.close();
  });

  it('does not let a non-owner send the Daily Update', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-apphome-'));
    const databasePath = path.join(tempDir, 'asteria.sqlite');
    createdPaths.push(databasePath);

    const store = await createStore(databasePath);
    store.updateSettings({
      personal_channel_owner_id: 'UOWNER',
      personal_channel_id: 'C123',
      daily_update_ping_user_group_id: 'S123',
    });

    const client = createClient();
    const handlers = createHandlerTestHarness({ store });

    await handlers['action:send_daily_update']({
      ack: mock.fn(),
      body: {
        user: { id: 'UNOTOWNER' },
        view: { state: { values: {} } },
      },
      client,
      logger: { error: mock.fn() },
    });

    assert.equal(client.views.publish.mock.callCount(), 1);
    assert.equal(client.chat.postMessage.mock.callCount(), 0);
    const publishArgs = client.views.publish.mock.calls[0].arguments[0];
    assert.equal(publishArgs.view.callback_id, 'asteria_home_leaderboard');
    assert(
      !publishArgs.view.blocks.some((block) => String(block.block_id || '').startsWith('navigation')),
      'no navigation at all',
    );
    store.close();
  });

  it('opens the Compose Daily Update modal with a rich text editor', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-apphome-'));
    const databasePath = path.join(tempDir, 'asteria.sqlite');
    createdPaths.push(databasePath);

    const store = await createStore(databasePath);
    store.updateSettings({ personal_channel_owner_id: 'UOWNER' });

    const client = createClient();
    const handlers = createHandlerTestHarness({ store });

    await handlers['action:open_daily_update_modal']({
      ack: mock.fn(),
      body: { user: { id: 'UOWNER' }, trigger_id: 'trig-1' },
      client,
    });

    const callArgs = client.views.open.mock.calls[0].arguments[0];
    assert.equal(callArgs.trigger_id, 'trig-1');
    assert.equal(callArgs.view.type, 'modal');
    assert(callArgs.view.blocks.some((block) => block.element?.type === 'rich_text_input'));
    store.close();
  });

  it('saves the Daily Update draft from the compose modal', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-apphome-'));
    const databasePath = path.join(tempDir, 'asteria.sqlite');
    createdPaths.push(databasePath);

    const store = await createStore(databasePath);
    store.updateSettings({ personal_channel_owner_id: 'UOWNER' });

    const richTextValue = JSON.stringify([
      {
        type: 'rich_text_section',
        elements: [
          { type: 'text', text: 'Shipped ', bold: true },
          { type: 'text', text: 'Asteria' },
        ],
      },
    ]);

    const client = createClient();
    const handlers = createHandlerTestHarness({ store });

    await handlers['view:compose_daily_update_submit']({
      ack: mock.fn(),
      body: { user: { id: 'UOWNER' } },
      view: {
        state: {
          values: {
            daily_update_main_block: {
              daily_update_main_text: {
                type: 'rich_text_input',
                rich_text_value: { type: 'rich_text', elements: JSON.parse(richTextValue) },
              },
            },
            daily_update_song_block: { daily_update_song_text: { value: 'Song' } },
            daily_update_event_block: { daily_update_event_text: { value: 'Event' } },
          },
        },
      },
      client,
    });

    const draft = store.getDraft();
    assert.equal(draft.main_update_text, richTextValue);
    assert.equal(draft.song_text, 'Song');
    assert.equal(draft.event_text, 'Event');
    assert.equal(client.views.publish.mock.callCount(), 1);
    store.close();
  });

  it('saves the thread message from the edit modal', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-apphome-'));
    const databasePath = path.join(tempDir, 'asteria.sqlite');
    createdPaths.push(databasePath);

    const store = await createStore(databasePath);
    store.updateSettings({ personal_channel_owner_id: 'UOWNER' });

    const richTextValue = JSON.stringify([
      {
        type: 'rich_text_section',
        elements: [{ type: 'text', text: ':thread: ', bold: true }],
      },
    ]);

    const client = createClient();
    const handlers = createHandlerTestHarness({ store });

    await handlers['view:edit_thread_message_submit']({
      ack: mock.fn(),
      body: { user: { id: 'UOWNER' } },
      view: {
        state: {
          values: {
            thread_message_block: {
              thread_message_content: {
                type: 'rich_text_input',
                rich_text_value: { type: 'rich_text', elements: JSON.parse(richTextValue) },
              },
            },
          },
        },
      },
      client,
    });

    assert.equal(store.getSettings().daily_update_thread_message, richTextValue);
    store.close();
  });

  it('saves the welcome message from the edit modal', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-apphome-'));
    const databasePath = path.join(tempDir, 'asteria.sqlite');
    createdPaths.push(databasePath);

    const store = await createStore(databasePath);
    store.updateSettings({ personal_channel_owner_id: 'UOWNER' });

    const richTextValue = JSON.stringify([
      {
        type: 'rich_text_section',
        elements: [{ type: 'text', text: 'Welcome to the club!' }],
      },
    ]);

    const client = createClient();
    const handlers = createHandlerTestHarness({ store });

    await handlers['view:edit_welcome_message_submit']({
      ack: mock.fn(),
      body: { user: { id: 'UOWNER' } },
      view: {
        state: {
          values: {
            welcome_message_block: {
              welcome_message_content: {
                type: 'rich_text_input',
                rich_text_value: { type: 'rich_text', elements: JSON.parse(richTextValue) },
              },
            },
          },
        },
      },
      client,
    });

    assert.equal(store.getSettings().welcome_message_content, richTextValue);
    store.close();
  });

  it('saves the personal channel from the settings modal', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-apphome-'));
    const databasePath = path.join(tempDir, 'asteria.sqlite');
    createdPaths.push(databasePath);

    const store = await createStore(databasePath);
    store.updateSettings({ personal_channel_owner_id: 'UOWNER' });

    const client = createClient();
    const handlers = createHandlerTestHarness({ store });

    await handlers['view:edit_personal_channel_submit']({
      ack: mock.fn(),
      body: { user: { id: 'UOWNER' } },
      view: {
        state: {
          values: {
            personal_channel_block: { personal_channel_id: { selected_conversation: 'C456' } },
          },
        },
      },
      client,
    });

    assert.equal(store.getSettings().personal_channel_id, 'C456');
    store.close();
  });

  it('keeps selects out of the Settings home view and uses modal buttons instead', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-apphome-'));
    const databasePath = path.join(tempDir, 'asteria.sqlite');
    createdPaths.push(databasePath);

    const store = await createStore(databasePath);
    store.updateSettings({
      personal_channel_owner_id: 'UOWNER',
      personal_channel_id: 'C123',
    });

    const client = createClient();
    const handlers = createHandlerTestHarness({ store });

    await handlers.publishTab(client, 'UOWNER', 'channels', 'settings');

    const publishArgs = client.views.publish.mock.calls[0].arguments[0];
    const viewJson = JSON.stringify(publishArgs.view);
    assert(!viewJson.includes('conversations_select'));
    assert(!viewJson.includes('static_select'));
    assert(publishArgs.view.blocks.some((block) => block.accessory?.action_id === 'open_personal_channel_modal'));
    assert(publishArgs.view.blocks.some((block) => block.accessory?.action_id === 'open_ping_group_modal'));
    store.close();
  });

  it('opens the ping group modal with the current group preselected', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-apphome-'));
    const databasePath = path.join(tempDir, 'asteria.sqlite');
    createdPaths.push(databasePath);

    const store = await createStore(databasePath);
    store.updateSettings({
      personal_channel_owner_id: 'UOWNER',
      daily_update_ping_user_group_id: 'S123',
    });

    const client = createClient();
    client.usergroups.list = mock.fn(async () => ({
      usergroups: [{ id: 'S123', name: 'Members', handle: 'members' }],
    }));

    const handlers = createHandlerTestHarness({ store });

    await handlers['action:open_ping_group_modal']({
      ack: mock.fn(),
      body: { user: { id: 'UOWNER' }, trigger_id: 'trig-2' },
      client,
    });

    const callArgs = client.views.open.mock.calls[0].arguments[0];
    assert.equal(callArgs.view.callback_id, 'edit_ping_group_submit');
    const select = callArgs.view.blocks.find((block) => block.element?.type === 'external_select');
    assert(select);
    assert.equal(select.element.initial_option.value, 'S123');
    store.close();
  });

  it('returns matching user group options for the searchable select', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-apphome-'));
    const databasePath = path.join(tempDir, 'asteria.sqlite');
    createdPaths.push(databasePath);

    const store = await createStore(databasePath);
    store.updateSettings({ personal_channel_owner_id: 'UOWNER' });

    const client = createClient();
    client.usergroups.list = mock.fn(async () => ({
      usergroups: [
        { id: 'S111', name: 'Hack Clubbers', handle: 'clubbers' },
        { id: 'S222', name: 'Leads', handle: 'leads' },
      ],
    }));

    const handlers = createHandlerTestHarness({ store });
    let ackedOptions = null;
    await handlers['options:select_ping_user_group']({
      ack: (options) => {
        ackedOptions = options;
      },
      payload: { value: 'leads' },
      client,
    });

    assert.equal(ackedOptions.options.length, 1);
    assert.equal(ackedOptions.options[0].value, 'S222');
    store.close();
  });

  it('saves the ping group from the modal', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-apphome-'));
    const databasePath = path.join(tempDir, 'asteria.sqlite');
    createdPaths.push(databasePath);

    const store = await createStore(databasePath);
    store.updateSettings({ personal_channel_owner_id: 'UOWNER' });

    const client = createClient();
    const handlers = createHandlerTestHarness({ store });

    await handlers['view:edit_ping_group_submit']({
      ack: mock.fn(),
      body: { user: { id: 'UOWNER' } },
      view: {
        state: {
          values: {
            ping_group_block: {
              select_ping_user_group: { type: 'external_select', selected_option: { value: 'S999' } },
            },
          },
        },
      },
      client,
    });

    assert.equal(store.getSettings().daily_update_ping_user_group_id, 'S999');
    store.close();
  });

  it('opens the Daily Question test modal with preview and send options', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-apphome-'));
    const databasePath = path.join(tempDir, 'asteria.sqlite');
    createdPaths.push(databasePath);

    const store = await createStore(databasePath);
    store.updateSettings({
      personal_channel_owner_id: 'UOWNER',
      personal_channel_id: 'C123',
      daily_question_enabled: true,
    });

    const client = createClient();
    const handlers = createHandlerTestHarness({ store });

    await handlers['action:open_question_test_modal']({
      ack: mock.fn(),
      body: { user: { id: 'UOWNER' }, trigger_id: 'trig-9' },
      client,
    });

    const callArgs = client.views.open.mock.calls[0].arguments[0];
    assert.equal(callArgs.view.callback_id, 'test_daily_question_submit');
    const radio = callArgs.view.blocks.find((block) => block.element?.type === 'radio_buttons');
    assert(radio);
    assert.deepEqual(radio.element.options.map((option) => option.value).sort(), ['preview', 'send']);
    store.close();
  });

  it('does not let a non-owner open the Daily Question test modal', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-apphome-'));
    const databasePath = path.join(tempDir, 'asteria.sqlite');
    createdPaths.push(databasePath);

    const store = await createStore(databasePath);
    store.updateSettings({ personal_channel_owner_id: 'UOWNER' });

    const client = createClient();
    const handlers = createHandlerTestHarness({
      store,
      aiService: {
        generateDailyQuestion: mock.fn(),
      },
    });

    await handlers['action:open_question_test_modal']({
      ack: mock.fn(),
      body: { user: { id: 'UNOTOWNER' }, trigger_id: 'trig-9' },
      client,
    });

    assert.equal(client.views.open.mock.callCount(), 0);
    assert.equal(client.chat.postMessage.mock.callCount(), 0);
    store.close();
  });

  it('previews a generated Daily Question without posting or recording it', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-apphome-'));
    const databasePath = path.join(tempDir, 'asteria.sqlite');
    createdPaths.push(databasePath);

    const store = await createStore(databasePath);
    store.updateSettings({
      personal_channel_owner_id: 'UOWNER',
      personal_channel_id: 'C123',
      daily_question_enabled: true,
    });

    const client = createClient();
    const handlers = createHandlerTestHarness({
      store,
      aiService: {
        generateDailyQuestion: mock.fn(async () => ({
          questionText: 'What are you curious about?',
          questionHash: 'hash123',
        })),
      },
    });

    let ackArgs = null;
    await handlers['view:test_daily_question_submit']({
      ack: (args) => {
        ackArgs = args;
      },
      body: { user: { id: 'UOWNER' } },
      view: {
        state: {
          values: {
            question_test_mode_block: {
              question_test_mode: { selected_option: { value: 'preview' } },
            },
          },
        },
      },
      client,
      logger: { error: mock.fn() },
    });

    assert.equal(ackArgs.response_action, 'update');
    assert.equal(ackArgs.view.callback_id, 'question_preview_view');
    assert(ackArgs.view.blocks.some((block) => block.text?.text.includes('What are you curious about?')));
    assert.equal(client.chat.postMessage.mock.callCount(), 0);
    assert.equal(store.getRecentDailyQuestionTexts(5).length, 0);
    store.close();
  });

  it('sends a generated Daily Question to the channel when send is chosen', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-apphome-'));
    const databasePath = path.join(tempDir, 'asteria.sqlite');
    createdPaths.push(databasePath);

    const store = await createStore(databasePath);
    store.updateSettings({
      personal_channel_owner_id: 'UOWNER',
      personal_channel_id: 'C123',
      daily_question_enabled: true,
    });

    const client = createClient();
    const handlers = createHandlerTestHarness({
      store,
      aiService: {
        generateDailyQuestion: mock.fn(async () => ({
          questionText: 'What are you curious about?',
          questionHash: 'hash123',
        })),
      },
    });

    await handlers['view:test_daily_question_submit']({
      ack: mock.fn(),
      body: { user: { id: 'UOWNER' } },
      view: {
        state: {
          values: {
            question_test_mode_block: {
              question_test_mode: { selected_option: { value: 'send' } },
            },
          },
        },
      },
      client,
      logger: { error: mock.fn() },
    });

    assert.equal(client.chat.postMessage.mock.callCount(), 1);
    const callArgs = client.chat.postMessage.mock.calls[0].arguments[0];
    assert(callArgs.text.includes('❓ Daily Question'));
    assert(callArgs.text.includes('What are you curious about?'));
    assert.equal(callArgs.icon_emoji, undefined);

    const recentQuestions = store.getRecentDailyQuestionTexts(5);
    assert(recentQuestions.some((question) => question.includes('What are you curious about?')));

    const publishArgs = client.views.publish.mock.calls[0].arguments[0];
    assert(publishArgs.view.blocks.some((block) => block.elements?.[0]?.text?.includes('Test Daily Question sent')));
    store.close();
  });

  it('saves the AI prompt from the Daily Question tab', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-apphome-'));
    const databasePath = path.join(tempDir, 'asteria.sqlite');
    createdPaths.push(databasePath);

    const store = await createStore(databasePath);
    store.updateSettings({
      personal_channel_owner_id: 'UOWNER',
      daily_question_enabled: true,
      daily_question_send_time: '09:00',
    });

    const client = createClient();
    const handlers = createHandlerTestHarness({ store });

    await handlers['action:save_daily_question_settings']({
      ack: mock.fn(),
      body: {
        user: { id: 'UOWNER' },
        view: {
          state: {
            values: {
              daily_question_enabled_block: {
                daily_question_enabled: { selected_options: [{ value: 'enabled' }] },
              },
              daily_question_prompt_block: {
                daily_question_prompt: { value: 'Ask a question about sailing in one sentence.' },
              },
              daily_question_include_block: { daily_question_include_in_update: { selected_options: [] } },
              daily_question_send_time_block: { daily_question_send_time: { value: '10:30' } },
            },
          },
        },
      },
      client,
    });

    const settings = store.getSettings();
    assert.equal(settings.daily_question_prompt, 'Ask a question about sailing in one sentence.');
    assert.equal(settings.daily_question_send_time, '10:30');
    assert.equal(settings.daily_question_enabled, true);
    store.close();
  });

  it('saves the bot name from the general settings tab', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-apphome-'));
    const databasePath = path.join(tempDir, 'asteria.sqlite');
    createdPaths.push(databasePath);

    const store = await createStore(databasePath);
    store.updateSettings({
      personal_channel_owner_id: 'UOWNER',
      timezone: 'UTC',
      daily_update_reminder_enabled: true,
      daily_update_reminder_time: '17:00',
    });

    const client = createClient();
    const handlers = createHandlerTestHarness({ store });

    await handlers['action:save_general_settings']({
      ack: mock.fn(),
      body: {
        user: { id: 'UOWNER' },
        view: {
          state: {
            values: {
              bot_name_block: { bot_display_name: { value: '  Stella  ' } },
              timezone_block: { timezone: { value: 'UTC' } },
              daily_update_reminder_enabled_block: {
                daily_update_reminder_enabled: { selected_options: [{ value: 'enabled' }] },
              },
              daily_update_reminder_time_block: { daily_update_reminder_time: { value: '17:00' } },
            },
          },
        },
      },
      client,
    });

    assert.equal(store.getSettings().bot_display_name, 'Stella');
    store.close();
  });

  it('shows the bot name input in the settings tab', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-apphome-'));
    const databasePath = path.join(tempDir, 'asteria.sqlite');
    createdPaths.push(databasePath);

    const store = await createStore(databasePath);
    store.updateSettings({ personal_channel_owner_id: 'UOWNER', bot_display_name: 'Stella' });

    const client = createClient();
    const handlers = createHandlerTestHarness({ store });

    await handlers.publishTab(client, 'UOWNER', 'channels', 'settings');

    const publishArgs = client.views.publish.mock.calls[0].arguments[0];
    const botNameInput = publishArgs.view.blocks.find((block) => block.block_id === 'bot_name_block');
    assert(botNameInput);
    assert.equal(botNameInput.element.action_id, 'bot_display_name');
    assert.equal(botNameInput.element.initial_value, 'Stella');
    store.close();
  });

  it('shows the editable AI prompt and no topic selectors in the Daily Question tab', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-apphome-'));
    const databasePath = path.join(tempDir, 'asteria.sqlite');
    createdPaths.push(databasePath);

    const store = await createStore(databasePath);
    store.updateSettings({ personal_channel_owner_id: 'UOWNER' });

    const client = createClient();
    const handlers = createHandlerTestHarness({ store });

    await handlers.publishTab(client, 'UOWNER', 'channels', 'daily-question');

    const publishArgs = client.views.publish.mock.calls[0].arguments[0];
    const viewJson = JSON.stringify(publishArgs.view);
    assert(!viewJson.includes('multi_static_select'));
    assert(!viewJson.includes('daily_question_tone'));
    assert(!viewJson.includes('daily_question_custom_instructions'));

    const promptInput = publishArgs.view.blocks.find((block) => block.block_id === 'daily_question_prompt_block');
    assert(promptInput);
    assert.equal(promptInput.element.action_id, 'daily_question_prompt');
    assert.equal(promptInput.element.multiline, true);
    assert(promptInput.element.initial_value.length > 0);

    const testButton = publishArgs.view.blocks.find((block) =>
      block.elements?.some((element) => element.action_id === 'open_question_test_modal'),
    );
    assert(testButton);
    store.close();
  });

  it('generates a fresh AI question for every Daily Update even when the automatic Daily Question is off', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-apphome-'));
    const databasePath = path.join(tempDir, 'asteria.sqlite');
    createdPaths.push(databasePath);

    const store = await createStore(databasePath);
    store.updateSettings({
      personal_channel_owner_id: 'UOWNER',
      personal_channel_id: 'C123',
      daily_update_ping_user_group_id: 'S123',
      daily_question_enabled: false,
      daily_question_include_in_daily_update: true,
    });
    store.saveDraft({ main_update_text: 'Today update' });

    const generateDailyQuestion = mock.fn(async () => ({
      questionText: 'What did you ship today?',
      questionHash: 'hash-fresh',
    }));

    const client = createClient();
    const handlers = createHandlerTestHarness({ store, aiService: { generateDailyQuestion } });

    await handlers['action:send_daily_update']({
      ack: mock.fn(),
      body: { user: { id: 'UOWNER' }, view: { state: { values: {} } } },
      client,
      logger: { error: mock.fn() },
    });

    assert.equal(generateDailyQuestion.mock.callCount(), 1);
    const mainCall = client.chat.postMessage.mock.calls[0].arguments[0];
    assert(mainCall.text.includes('What did you ship today?'));
    assert(store.getRecentDailyQuestionTexts(5).some((question) => question.includes('What did you ship today?')));
    store.close();
  });

  it('still generates the fresh AI question but does not embed it when Include in Daily Update is off', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-apphome-'));
    const databasePath = path.join(tempDir, 'asteria.sqlite');
    createdPaths.push(databasePath);

    const store = await createStore(databasePath);
    store.updateSettings({
      personal_channel_owner_id: 'UOWNER',
      personal_channel_id: 'C123',
      daily_update_ping_user_group_id: 'S123',
      daily_question_enabled: false,
      daily_question_include_in_daily_update: false,
    });
    store.saveDraft({ main_update_text: 'Today update' });

    const generateDailyQuestion = mock.fn(async () => ({
      questionText: 'What did you ship today?',
      questionHash: 'hash-fresh',
    }));

    const client = createClient();
    const handlers = createHandlerTestHarness({ store, aiService: { generateDailyQuestion } });

    await handlers['action:send_daily_update']({
      ack: mock.fn(),
      body: { user: { id: 'UOWNER' }, view: { state: { values: {} } } },
      client,
      logger: { error: mock.fn() },
    });

    assert.equal(generateDailyQuestion.mock.callCount(), 1);
    const mainCall = client.chat.postMessage.mock.calls[0].arguments[0];
    assert(!mainCall.text.includes('What did you ship today?'));
    assert(store.getRecentDailyQuestionTexts(5).some((question) => question.includes('What did you ship today?')));
    store.close();
  });

  it('falls back to the last recorded question when AI generation fails during a Daily Update', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-apphome-'));
    const databasePath = path.join(tempDir, 'asteria.sqlite');
    createdPaths.push(databasePath);

    const store = await createStore(databasePath);
    store.updateSettings({
      personal_channel_owner_id: 'UOWNER',
      personal_channel_id: 'C123',
      daily_update_ping_user_group_id: 'S123',
      daily_question_include_in_daily_update: true,
    });
    store.saveDraft({ main_update_text: 'Today update' });
    store.recordDailyQuestion({
      localDate: '2026-01-01',
      questionText: 'Previous question?',
      topics: [],
      tone: '',
      customInstructions: '',
      questionHash: 'hash-past',
      messageTs: '1.1',
      sentAtUtc: '2026-01-01T10:00:00.000Z',
    });

    const generateDailyQuestion = mock.fn(async () => {
      throw new Error('AI down');
    });

    const client = createClient();
    const handlers = createHandlerTestHarness({ store, aiService: { generateDailyQuestion } });

    await handlers['action:send_daily_update']({
      ack: mock.fn(),
      body: { user: { id: 'UOWNER' }, view: { state: { values: {} } } },
      client,
      logger: { error: mock.fn() },
    });

    const mainCall = client.chat.postMessage.mock.calls[0].arguments[0];
    assert(mainCall.text.includes('Previous question?'));
    store.close();
  });

  it('only lists huddles in channels Asteria is a member of on the huddles tab', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-apphome-'));
    const databasePath = path.join(tempDir, 'asteria.sqlite');
    createdPaths.push(databasePath);

    const store = await createStore(databasePath);
    store.updateSettings({
      personal_channel_owner_id: 'UOWNER',
      personal_channel_id: 'C123',
    });

    store.upsertHuddle({
      callId: 'R1',
      channelId: 'C123',
      startedAt: 1754300000,
      endedAt: 1754301000,
    });
    store.upsertHuddle({
      callId: 'R2',
      startedAt: 1754213600,
    });

    const client = createClient();
    const handlers = createHandlerTestHarness({ store });

    await handlers.publishTab(client, 'UOWNER', 'huddles', 'huddles');

    const publishArgs = client.views.publish.mock.calls[0].arguments[0];
    const messageText = publishArgs.view.blocks.filter((block) => block.type === 'section').at(-1).text.text;
    assert(messageText.includes('<#C123>'));
    assert(!messageText.includes('unknown channel'));
    store.close();
  });
});

describe('App Home categories and huddle channel controls', () => {
  async function createHarness({ ownerId = 'UOWNER', botChannelIds = ['Crandom', 'Csecond'] } = {}) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-categories-'));
    const databasePath = path.join(tempDir, 'asteria.sqlite');
    createdPaths.push(databasePath);
    const store = await createStore(databasePath);
    store.updateSettings({ personal_channel_owner_id: ownerId, timezone: 'UTC' });
    return {
      store,
      handlers: createHandlerTestHarness({ store, botChannelIds }),
      client: createClient(),
    };
  }

  function buttonLabels(blocks) {
    return blocks.flatMap((block) =>
      (block.elements || []).filter((element) => element.action_id).map((element) => element.text.text),
    );
  }

  it('gives the app owner two category tabs, each with sub-tabs', async () => {
    const { store, handlers, client } = await createHarness();

    await handlers.publishTab(client, 'UOWNER', 'channels', 'daily-update');
    let labels = buttonLabels(client.views.publish.mock.calls.at(-1).arguments[0].view.blocks);
    assert(labels.includes('Channel Manager'), 'category tab');
    assert(labels.includes('Huddles'), 'category tab');
    assert(labels.includes('Daily Update'), 'sub-category tab');
    assert(labels.includes('Daily Question'));
    assert(!labels.includes('Logs'), 'the channels category has no Logs sub-tab');

    await handlers.publishTab(client, 'UOWNER', 'huddles', 'huddle-channels');
    labels = buttonLabels(client.views.publish.mock.calls.at(-1).arguments[0].view.blocks);
    assert(labels.includes('Channels'), 'huddle channel controls sub-tab');
    assert(labels.includes('Leaderboard'));
    assert(labels.includes('Logs'));
    assert(!labels.includes('Welcomer'), 'no channel-manager sub-tabs leak into huddles');
    store.close();
  });

  it('shows a non-owner who owns a channel the huddle category only', async () => {
    const { store, handlers, client } = await createHarness();
    store.upsertHuddleChannel({ channelId: 'Crandom', ownerIds: ['UOWNER', 'UOTHER'] });

    await handlers.publishTab(client, 'UOTHER', 'huddles', 'huddle-channels');
    const view = client.views.publish.mock.calls.at(-1).arguments[0].view;
    const labels = buttonLabels(view.blocks);
    assert.equal(view.callback_id, 'asteria_home_huddle_channels');
    assert(labels.includes('Huddles'));
    assert(!labels.includes('Channel Manager'), 'no channel manager for a non app owner');
    assert(!labels.includes('Logs'), 'logs stay app-owner only');
    store.close();
  });

  it('never repeats a block_id, which Slack rejects with invalid_arguments', async () => {
    const { store, handlers, client } = await createHarness();
    store.upsertHuddleChannel({ channelId: 'Crandom', name: 'random', ownerIds: ['UOWNER'] });
    store.upsertHuddleChannel({ channelId: 'Csecond', name: 'second', ownerIds: ['UOWNER'] });

    const subTabs = [
      'daily-update',
      'daily-question',
      'welcomer',
      'home-assistant',
      'sync',
      'settings',
      'delete',
      'huddle-channels',
      'huddles',
      'leaderboard',
      'logs',
    ];
    for (const sub of subTabs) {
      for (const category of ['channels', 'huddles']) {
        await handlers.publishTab(client, 'UOWNER', category, sub);
        const view = client.views.publish.mock.calls.at(-1).arguments[0].view;
        const ids = view.blocks.map((block) => block.block_id).filter(Boolean);
        const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
        assert.deepEqual(duplicates, [], `${category}/${sub} repeats a block_id`);

        const actionIds = view.blocks.flatMap((block) =>
          (block.elements || []).map((element) => element.action_id).filter(Boolean),
        );
        const duplicateActions = actionIds.filter((id, index) => actionIds.indexOf(id) !== index);
        assert.deepEqual(duplicateActions, [], `${category}/${sub} repeats an action_id`);
      }
    }
    store.close();
  });

  it('scopes the logs tab to the channels the bot is actually in', async () => {
    const { store, handlers, client } = await createHarness();
    const owner = store.getSettings().personal_channel_owner_id;
    store.recordTriggerLog({ userId: 'U1', action: 'huddle_join', detail: 'Rin', channelId: 'Crandom' });
    store.recordTriggerLog({ userId: 'U2', action: 'huddle_join', detail: 'Rout', channelId: 'Celsewhere' });

    await handlers.publishTab(client, owner, 'huddles', 'logs');
    const view = client.views.publish.mock.calls.at(-1).arguments[0].view;
    const text = JSON.stringify(view);

    assert(text.includes('Rin'), 'shows the huddle in a channel the bot is in');
    assert(!text.includes('Rout'), 'hides the huddle in a channel the bot is not in');
    assert(!text.includes('U2'), 'hides the person from that channel');
    store.close();
  });

  it('shows no logs at all when the bot memberships cannot be verified', async () => {
    const { store, handlers, client } = await createHarness({ botChannelIds: [] });
    const owner = store.getSettings().personal_channel_owner_id;
    store.recordTriggerLog({ userId: 'U1', action: 'huddle_join', detail: 'Rin', channelId: 'Crandom' });

    await handlers.publishTab(client, owner, 'huddles', 'logs');
    const view = client.views.publish.mock.calls.at(-1).arguments[0].view;

    assert(!JSON.stringify(view).includes('Rin'), 'never falls back to every channel we know');
    store.close();
  });

  it('keeps the leaderboard to points earned in the bot channels', async () => {
    const { store, handlers, client } = await createHarness();
    const owner = store.getSettings().personal_channel_owner_id;
    store.awardHuddlePoints('Ubotchannel', 30, 'Crandom');
    store.awardHuddlePoints('Ubotchannel', 5, 'Csecond');
    store.awardHuddlePoints('Uelsewhere', 99, 'Celsewhere');

    await handlers.publishTab(client, owner, 'huddles', 'leaderboard');
    const view = client.views.publish.mock.calls.at(-1).arguments[0].view;
    const text = JSON.stringify(view);

    assert(text.includes('Ubotchannel'), 'shows players from the bot channels');
    assert(text.includes('35'), 'sums their points across the bot channels');
    assert(!text.includes('Uelsewhere'), 'hides players who only show up elsewhere');
    store.close();
  });

  it('gives a random non-owner the leaderboard scoped to the bot channels', async () => {
    const { store, handlers, client } = await createHarness();
    store.awardHuddlePoints('Ubotchannel', 30, 'Crandom');
    store.awardHuddlePoints('Uelsewhere', 99, 'Celsewhere');

    await handlers.publishTab(client, 'USTRANGER', 'huddles', 'leaderboard');
    const view = client.views.publish.mock.calls.at(-1).arguments[0].view;
    const text = JSON.stringify(view);

    assert(text.includes('Ubotchannel'), 'non-owners still get a leaderboard');
    assert(!text.includes('Uelsewhere'), 'but only for the channels the bot is in');
    store.close();
  });

  it('explains an empty leaderboard when the bot memberships cannot be checked', async () => {
    const { handlers, client } = await createHarness({ botChannelIds: [] });

    await handlers.publishTab(client, 'UOWNER', 'huddles', 'leaderboard');
    const view = client.views.publish.mock.calls.at(-1).arguments[0].view;

    assert(JSON.stringify(view).includes("couldn't check which channels I'm in"), 'says why it is empty');
  });

  it('keeps a random non-owner on the leaderboard with no navigation', async () => {
    const { store, handlers, client } = await createHarness();

    await handlers.publishTab(client, 'USTRANGER', 'huddles', 'leaderboard');
    const view = client.views.publish.mock.calls.at(-1).arguments[0].view;
    assert.equal(view.callback_id, 'asteria_home_leaderboard');
    assert.equal(
      view.blocks.filter((block) => String(block.block_id || '').startsWith('navigation')).length,
      0,
      'no tabs for someone with nothing to manage',
    );
    store.close();
  });

  it('only shows a channel owner the channels they own', async () => {
    const { store, handlers, client } = await createHarness();
    store.upsertHuddleChannel({ channelId: 'Cmine', ownerIds: ['UOTHER'] });
    store.upsertHuddleChannel({ channelId: 'Ctheirs', ownerIds: ['USOMEONE'] });
    store.upsertHuddle({ callId: 'R1', channelId: 'Cunconfigured', startedAt: 1000 });

    await handlers.publishTab(client, 'UOTHER', 'huddles', 'huddle-channels');
    let viewText = JSON.stringify(client.views.publish.mock.calls.at(-1).arguments[0].view);
    assert(viewText.includes('Cmine'), 'sees their own channel');
    assert(!viewText.includes('Ctheirs'), 'never sees a channel they do not own');

    await handlers.publishTab(client, 'UOWNER', 'huddles', 'huddle-channels');
    viewText = JSON.stringify(client.views.publish.mock.calls.at(-1).arguments[0].view);
    assert(viewText.includes('Ctheirs'), 'the app owner sees every tracked channel');
    assert(viewText.includes('Cunconfigured'), 'including ones nobody configured yet');
    store.close();
  });

  it('renders per-channel controls for tracking, replies, pause and permissions', async () => {
    const { store, handlers, client } = await createHarness();
    store.upsertHuddleChannel({ channelId: 'Crandom', ownerIds: ['UOWNER'] });

    await handlers.publishTab(client, 'UOWNER', 'huddles', 'huddle-channels');
    const view = client.views.publish.mock.calls.at(-1).arguments[0].view;
    const actionIds = view.blocks.flatMap((block) => (block.elements || []).map((element) => element.action_id));
    assert(actionIds.includes('huddle_channel_configure_Crandom'));
    assert(actionIds.includes('huddle_channel_toggle_tracking_Crandom'));
    assert(actionIds.includes('huddle_channel_toggle_auto_replies_Crandom'));
    assert(actionIds.includes('huddle_channel_toggle_restrict_Crandom'));
    assert(actionIds.includes('huddle_channel_pause_Crandom_15'));
    assert(!actionIds.some((id) => id.startsWith('huddle_channel_resume')), 'no resume while not paused');

    const viewText = JSON.stringify(view);
    assert(viewText.includes('channel owner(s): <@UOWNER>'), 'shows who owns the channel');
    assert(viewText.includes('Pause 15m'), 'offers a temporary pause');
    store.close();
  });

  it('toggles tracking, pauses and resumes from the app home, logging each change', async () => {
    const { store, handlers, client } = await createHarness();
    store.upsertHuddleChannel({ channelId: 'Crandom', ownerIds: ['UOWNER'] });

    await handlers.handleHuddleChannelAction('toggle_tracking', {
      ack: mock.fn(),
      body: { user: { id: 'UOWNER' }, actions: [{ value: 'Crandom' }] },
      client,
    });
    assert.equal(store.getHuddleChannel('Crandom').enabled, 0, 'tracking off');

    await handlers.handleHuddleChannelAction('toggle_auto_replies', {
      ack: mock.fn(),
      body: { user: { id: 'UOWNER' }, actions: [{ value: 'Crandom' }] },
      client,
    });
    assert.equal(store.getHuddleChannel('Crandom').auto_replies, 0, 'replies off');

    await handlers.handleHuddleChannelAction('toggle_restrict', {
      ack: mock.fn(),
      body: { user: { id: 'UOWNER' }, actions: [{ value: 'Crandom' }] },
      client,
    });
    assert.equal(store.getHuddleChannel('Crandom').restrict_triggers, 1, 'owners only');

    await handlers.handleHuddleChannelAction('pause', {
      ack: mock.fn(),
      body: { user: { id: 'UOWNER' }, actions: [{ value: 'Crandom:60' }] },
      client,
    });
    assert(store.getHuddleChannel('Crandom').paused_until > Math.floor(Date.now() / 1000), 'paused for an hour');

    await handlers.handleHuddleChannelAction('resume', {
      ack: mock.fn(),
      body: { user: { id: 'UOWNER' }, actions: [{ value: 'Crandom' }] },
      client,
    });
    assert.equal(store.getHuddleChannel('Crandom').paused_until, 0, 'resumed');

    const logs = store.listTriggerLog(50, ['Crandom']);
    const configLogs = logs.filter((entry) => entry.action === 'huddle_channel_config');
    assert.equal(configLogs.length, 5, 'every change is logged');
    assert.equal(configLogs[0].user_id, 'UOWNER');
    assert(configLogs.some((entry) => entry.detail.includes('tracking off')));
    assert(configLogs.some((entry) => entry.detail.includes('auto replies off')));
    assert(configLogs.some((entry) => entry.detail.includes('trigger access owners only')));
    assert(configLogs.some((entry) => entry.detail.includes('paused')));
    assert(configLogs.some((entry) => entry.detail.includes('resumed')));
    store.close();
  });

  it('lets a channel owner configure their own channel but nobody else', async () => {
    const { store, handlers, client } = await createHarness();
    store.upsertHuddleChannel({ channelId: 'Cmine', ownerIds: ['UOTHER'] });
    store.upsertHuddleChannel({ channelId: 'Ctheirs', ownerIds: ['USOMEONE'] });

    await handlers.handleHuddleChannelAction('toggle_tracking', {
      ack: mock.fn(),
      body: { user: { id: 'UOTHER' }, actions: [{ value: 'Cmine' }] },
      client,
    });
    assert.equal(store.getHuddleChannel('Cmine').enabled, 0, 'a channel owner can pause their own tracking');

    await handlers.handleHuddleChannelAction('toggle_tracking', {
      ack: mock.fn(),
      body: { user: { id: 'UOTHER' }, actions: [{ value: 'Ctheirs' }] },
      client,
    });
    assert.equal(store.getHuddleChannel('Ctheirs').enabled, 1, 'but not touch a channel they do not own');

    await handlers.handleHuddleChannelAction('toggle_tracking', {
      ack: mock.fn(),
      body: { user: { id: 'USTRANGER' }, actions: [{ value: 'Cmine' }] },
      client,
    });
    assert.equal(store.getHuddleChannel('Cmine').enabled, 0, 'a stranger changes nothing');

    const configLogs = store
      .listTriggerLog(50, ['Cmine', 'Ctheirs'])
      .filter((e) => e.action === 'huddle_channel_config');
    assert.equal(configLogs.length, 1, 'only the permitted change is logged');
    assert.equal(configLogs[0].user_id, 'UOTHER');
    store.close();
  });

  it('saves owners and toggles from the config modal and logs it', async () => {
    const { store, handlers, client } = await createHarness();
    store.upsertHuddleChannel({ channelId: 'Crandom', ownerIds: [], enabled: true, autoReplies: true });

    await handlers['view:huddle_channel_config_submit']({
      ack: mock.fn(),
      body: {
        user: { id: 'UOWNER' },
        view: {
          private_metadata: 'Crandom',
          state: {
            values: {
              huddle_channel_owners_block: {
                huddle_channel_owners_value: { value: 'UOTHER, <@UTHIRD>' },
              },
              huddle_channel_tracking_block: {
                huddle_channel_tracking_value: { selected_option: { value: 'off' } },
              },
              huddle_channel_replies_block: {
                huddle_channel_replies_value: { selected_option: { value: 'off' } },
              },
              huddle_channel_restrict_block: {
                huddle_channel_restrict_value: { selected_option: { value: 'owners' } },
              },
              huddle_channel_pause_block: {
                huddle_channel_pause_value: { selected_option: { value: '15' } },
              },
            },
          },
        },
      },
      client,
    });

    const row = store.getHuddleChannel('Crandom');
    assert.deepEqual(JSON.parse(row.owner_ids), ['UOTHER', 'UTHIRD'], 'parses ids out of messy input');
    assert.equal(row.enabled, 0);
    assert.equal(row.auto_replies, 0);
    assert.equal(row.restrict_triggers, 1);
    assert(row.paused_until > Math.floor(Date.now() / 1000), 'paused for 15 minutes');

    const log = store.listTriggerLog(50, ['Crandom']).find((entry) => entry.action === 'huddle_channel_config');
    assert(log.detail.includes('owners set to <@UOTHER> <@UTHIRD>'));
    assert(log.detail.includes('tracking off'));
    assert(log.detail.includes('paused'));
    store.close();
  });

  it('opens the config modal with the current settings for a permitted user only', async () => {
    const { store, handlers, client } = await createHarness();
    store.upsertHuddleChannel({ channelId: 'Cmine', ownerIds: ['UOTHER'], autoReplies: false });

    await handlers.handleHuddleChannelAction('configure', {
      ack: mock.fn(),
      body: { user: { id: 'UOTHER' }, actions: [{ value: 'Cmine' }], trigger_id: 'T1' },
      client,
    });
    const modal = client.views.open.mock.calls.at(-1).arguments[0].view;
    assert.equal(modal.callback_id, 'huddle_channel_config_submit');
    assert.equal(modal.private_metadata, 'Cmine');
    const modalText = JSON.stringify(modal);
    assert(modalText.includes('UOTHER'), 'prefilled with the current owners');
    assert(modalText.includes('owners'), 'can restrict triggers to owners');

    const modalsBefore = client.views.open.mock.callCount();
    await handlers.handleHuddleChannelAction('configure', {
      ack: mock.fn(),
      body: { user: { id: 'USTRANGER' }, actions: [{ value: 'Cmine' }], trigger_id: 'T2' },
      client,
    });
    assert.equal(client.views.open.mock.callCount(), modalsBefore, 'a stranger gets no modal');
    store.close();
  });
});
