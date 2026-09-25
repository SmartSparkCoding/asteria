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

function createHandlerTestHarness({ store, aiService }) {
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
  const { publishTab } = createHomeHandlers({ app, store, aiService });
  return { ...handlers, publishTab };
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
    assert(
      publishArgs.view.blocks.some((block) =>
        block.text?.text.includes('configured for another personal channel owner'),
      ),
    );
    assert(!publishArgs.view.blocks.some((block) => block.block_id === 'navigation_tabs'));
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

    await handlers.publishTab(client, 'UOWNER', 'settings');

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

    await handlers.publishTab(client, 'UOWNER', 'settings');

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

    await handlers.publishTab(client, 'UOWNER', 'daily-question');

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

    await handlers.publishTab(client, 'UOWNER', 'huddles');

    const publishArgs = client.views.publish.mock.calls[0].arguments[0];
    const messageText = publishArgs.view.blocks.filter((block) => block.type === 'section').at(-1).text.text;
    assert(messageText.includes('<#C123>'));
    assert(!messageText.includes('unknown channel'));
    store.close();
  });
});
