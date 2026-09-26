import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';
import { DEFAULT_QUESTION_PROMPT } from '../services/ai.js';
import { normalizeTimeValue } from '../utils/time.js';

const DEFAULT_SETTINGS = {
  personal_channel_owner_id: '',
  personal_channel_id: '',
  timezone: 'UTC',
  bot_display_name: 'Asteria',
  daily_question_enabled: 1,
  daily_question_prompt: DEFAULT_QUESTION_PROMPT,
  daily_question_include_in_daily_update: 0,
  daily_question_send_time: '09:00',
  daily_question_reply_text: 'Reply to this message in a thread!',
  welcomer_enabled: 1,
  welcome_message_content: 'Welcome {user}! 🎉\n\nPlease make yourself at home.',
  rules_canvas_url: '',
  daily_update_ping_user_group_id: '',
  daily_update_thread_enabled: 0,
  daily_update_thread_message: ':thread: here please!!',
  daily_update_reminder_enabled: 1,
  daily_update_reminder_time: '17:00',
  home_assistant_url: '',
  home_assistant_token: '',
  home_assistant_steps_entity: '',
  updated_at: new Date().toISOString(),
};

const DEFAULT_SYNC_SETTINGS = {
  enabled: 0,
  todoist_api_token: '',
  slack_list_id: '',
  todoist_project_name: 'Public Slack To Do List',
  notification_channel_id: '',
  poll_interval_seconds: 300,
  webhook_secret: '',
  updated_at: new Date().toISOString(),
};

function ensureDirectoryForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function toBooleanInteger(value) {
  return value ? 1 : 0;
}

function parseBoolean(value) {
  return value === 1 || value === '1' || value === true;
}

function sanitizeSettingsPatch(patch) {
  const sanitizedPatch = { ...patch };

  if (sanitizedPatch.timezone) {
    sanitizedPatch.timezone = sanitizedPatch.timezone.trim();
  }

  if ('bot_display_name' in sanitizedPatch) {
    sanitizedPatch.bot_display_name = sanitizedPatch.bot_display_name.trim() || 'Asteria';
  }

  if (sanitizedPatch.daily_question_send_time) {
    sanitizedPatch.daily_question_send_time = normalizeTimeValue(sanitizedPatch.daily_question_send_time, '09:00');
  }

  if (sanitizedPatch.daily_update_reminder_time) {
    sanitizedPatch.daily_update_reminder_time = normalizeTimeValue(sanitizedPatch.daily_update_reminder_time, '17:00');
  }

  if ('daily_question_prompt' in sanitizedPatch) {
    const trimmedPrompt = String(sanitizedPatch.daily_question_prompt ?? '').trim();
    sanitizedPatch.daily_question_prompt = trimmedPrompt || DEFAULT_QUESTION_PROMPT;
  }

  for (const booleanKey of [
    'daily_question_enabled',
    'daily_question_include_in_daily_update',
    'welcomer_enabled',
    'daily_update_thread_enabled',
    'daily_update_reminder_enabled',
  ]) {
    if (booleanKey in sanitizedPatch) {
      sanitizedPatch[booleanKey] = toBooleanInteger(sanitizedPatch[booleanKey]);
    }
  }

  if (sanitizedPatch.daily_question_reply_text) {
    sanitizedPatch.daily_question_reply_text = sanitizedPatch.daily_question_reply_text.trim();
  }

  return sanitizedPatch;
}

function sanitizeSyncSettingsPatch(patch) {
  const sanitizedPatch = { ...patch };

  for (const textKey of [
    'todoist_api_token',
    'slack_list_id',
    'todoist_project_name',
    'notification_channel_id',
    'webhook_secret',
  ]) {
    if (textKey in sanitizedPatch) {
      sanitizedPatch[textKey] = String(sanitizedPatch[textKey] ?? '').trim();
    }
  }

  if ('todoist_project_name' in sanitizedPatch) {
    sanitizedPatch.todoist_project_name =
      sanitizedPatch.todoist_project_name || DEFAULT_SYNC_SETTINGS.todoist_project_name;
  }

  if ('enabled' in sanitizedPatch) {
    sanitizedPatch.enabled = toBooleanInteger(sanitizedPatch.enabled);
  }

  if ('poll_interval_seconds' in sanitizedPatch) {
    const parsedInterval = Number.parseInt(sanitizedPatch.poll_interval_seconds, 10);
    if (Number.isFinite(parsedInterval) && parsedInterval >= 15) {
      sanitizedPatch.poll_interval_seconds = parsedInterval;
    } else {
      sanitizedPatch.poll_interval_seconds = DEFAULT_SYNC_SETTINGS.poll_interval_seconds;
    }
  }

  return sanitizedPatch;
}

function bindAndFetchAll(database, sql, params = {}) {
  const statement = database.prepare(sql);
  try {
    statement.bind(normalizeParams(params));
    const rows = [];
    while (statement.step()) {
      rows.push(statement.getAsObject());
    }
    return rows;
  } finally {
    statement.free();
  }
}

function bindAndFetchOne(database, sql, params = {}) {
  return bindAndFetchAll(database, sql, params)[0] ?? null;
}

function bindAndRun(database, sql, params = {}) {
  const statement = database.prepare(sql);
  try {
    statement.bind(normalizeParams(params));
    while (statement.step()) {
      // consume the statement
    }
  } finally {
    statement.free();
  }
}

function getRowsChanged(database) {
  return bindAndFetchOne(database, 'SELECT changes() AS changes')?.changes ?? 0;
}

function parseOwnerIds(value) {
  if (Array.isArray(value)) {
    return value.filter((id) => typeof id === 'string' && id);
  }
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string' && id) : [];
  } catch {
    return [];
  }
}

function normalizeParams(params) {
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => {
      if (key.startsWith('$') || key.startsWith(':') || key.startsWith('@')) {
        return [key, value];
      }

      return [`$${key}`, value];
    }),
  );
}

export async function createStore(databasePath, options = {}) {
  ensureDirectoryForFile(databasePath);

  const sqlJsDistDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../node_modules/sql.js/dist');
  const SQL = await initSqlJs({
    locateFile: (fileName) => path.join(sqlJsDistDir, fileName),
  });

  const databaseBytes = fs.existsSync(databasePath) ? fs.readFileSync(databasePath) : null;
  const database = databaseBytes ? new SQL.Database(databaseBytes) : new SQL.Database();

  database.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      personal_channel_owner_id TEXT NOT NULL DEFAULT '',
      personal_channel_id TEXT NOT NULL DEFAULT '',
      timezone TEXT NOT NULL DEFAULT 'UTC',
      bot_display_name TEXT NOT NULL DEFAULT 'Asteria',
      daily_question_enabled INTEGER NOT NULL DEFAULT 1,
      daily_question_prompt TEXT NOT NULL DEFAULT '',
      daily_question_include_in_daily_update INTEGER NOT NULL DEFAULT 0,
      daily_question_send_time TEXT NOT NULL DEFAULT '09:00',
      daily_question_reply_text TEXT NOT NULL DEFAULT 'Reply to this message in a thread!',
      welcomer_enabled INTEGER NOT NULL DEFAULT 1,
      welcome_message_content TEXT NOT NULL DEFAULT 'Welcome {user}! 🎉\n\nPlease make yourself at home.',
      rules_canvas_url TEXT NOT NULL DEFAULT '',
      daily_update_ping_user_group_id TEXT NOT NULL DEFAULT '',
      daily_update_thread_enabled INTEGER NOT NULL DEFAULT 0,
      daily_update_thread_message TEXT NOT NULL DEFAULT ':thread: here please!!',
      daily_update_reminder_enabled INTEGER NOT NULL DEFAULT 1,
      daily_update_reminder_time TEXT NOT NULL DEFAULT '17:00',
      home_assistant_url TEXT NOT NULL DEFAULT '',
      home_assistant_token TEXT NOT NULL DEFAULT '',
      home_assistant_steps_entity TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS daily_update_drafts (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      main_update_text TEXT NOT NULL DEFAULT '',
      song_text TEXT NOT NULL DEFAULT '',
      event_text TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS daily_update_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sent_at_utc TEXT NOT NULL,
      local_date TEXT NOT NULL,
      message_ts TEXT NOT NULL,
      thread_ts TEXT,
      main_update_text TEXT NOT NULL,
      song_text TEXT NOT NULL DEFAULT '',
      event_text TEXT NOT NULL DEFAULT '',
      question_text TEXT NOT NULL DEFAULT '',
      user_group_id TEXT NOT NULL DEFAULT '',
      sent_by_user_id TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS daily_question_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      local_date TEXT NOT NULL,
      question_text TEXT NOT NULL,
      topics_json TEXT NOT NULL,
      tone TEXT NOT NULL,
      custom_instructions TEXT NOT NULL DEFAULT '',
      question_hash TEXT NOT NULL,
      message_ts TEXT,
      generated_at_utc TEXT NOT NULL,
      sent_at_utc TEXT
    );

    CREATE TABLE IF NOT EXISTS scheduled_job_runs (
      job_name TEXT NOT NULL,
      local_date TEXT NOT NULL,
      status TEXT NOT NULL,
      claimed_at_utc TEXT NOT NULL,
      completed_at_utc TEXT,
      error_text TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (job_name, local_date)
    );

    CREATE TABLE IF NOT EXISTS welcome_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_ts TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      sent_at_utc TEXT NOT NULL,
      message_ts TEXT NOT NULL,
      UNIQUE(event_ts, channel_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS group_opt_outs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      user_group_id TEXT NOT NULL,
      opted_out_at_utc TEXT NOT NULL,
      UNIQUE(user_id, user_group_id)
    );

    CREATE TABLE IF NOT EXISTS sync_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0,
      todoist_api_token TEXT NOT NULL DEFAULT '',
      slack_list_id TEXT NOT NULL DEFAULT '',
      todoist_project_name TEXT NOT NULL DEFAULT 'Public Slack To Do List',
      notification_channel_id TEXT NOT NULL DEFAULT '',
      poll_interval_seconds INTEGER NOT NULL DEFAULT 300,
      webhook_secret TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sync_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slack_item_id TEXT NOT NULL,
      todoist_task_id TEXT NOT NULL,
      last_synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      added_by TEXT NOT NULL DEFAULT '',
      is_completed INTEGER NOT NULL DEFAULT 0,
      name_hash TEXT NOT NULL DEFAULT '',
      UNIQUE(slack_item_id),
      UNIQUE(todoist_task_id)
    );

    CREATE TABLE IF NOT EXISTS huddles (
      call_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL DEFAULT '',
      channel_name TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT '',
      started_at INTEGER NOT NULL DEFAULT 0,
      ended_at INTEGER,
      thread_root_ts TEXT NOT NULL DEFAULT '',
      participant_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS huddle_members (
      call_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      first_seen_at INTEGER,
      last_seen_at INTEGER,
      is_in INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (call_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS huddle_user_state (
      user_id TEXT PRIMARY KEY,
      call_id TEXT NOT NULL DEFAULT '',
      is_in INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS huddle_leaderboard (
      user_id TEXT PRIMARY KEY,
      points INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS huddle_channel_points (
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      points INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (channel_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS huddle_channels (
      channel_id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      auto_replies INTEGER NOT NULL DEFAULT 1,
      restrict_triggers INTEGER NOT NULL DEFAULT 0,
      owner_ids TEXT NOT NULL DEFAULT '[]',
      paused_until INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS trigger_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const existingSettingColumns = bindAndFetchAll(database, 'PRAGMA table_info(app_settings)').map(
    (column) => column.name,
  );
  if (!existingSettingColumns.includes('bot_display_name')) {
    bindAndRun(database, "ALTER TABLE app_settings ADD COLUMN bot_display_name TEXT NOT NULL DEFAULT 'Asteria'");
  }
  if (!existingSettingColumns.includes('daily_question_prompt')) {
    bindAndRun(database, "ALTER TABLE app_settings ADD COLUMN daily_question_prompt TEXT NOT NULL DEFAULT ''");
    bindAndRun(
      database,
      "UPDATE app_settings SET daily_question_prompt = $prompt WHERE daily_question_prompt = '' OR daily_question_prompt IS NULL",
      { prompt: DEFAULT_QUESTION_PROMPT },
    );
  }
  if (!existingSettingColumns.includes('home_assistant_url')) {
    bindAndRun(database, "ALTER TABLE app_settings ADD COLUMN home_assistant_url TEXT NOT NULL DEFAULT ''");
  }
  if (!existingSettingColumns.includes('home_assistant_token')) {
    bindAndRun(database, "ALTER TABLE app_settings ADD COLUMN home_assistant_token TEXT NOT NULL DEFAULT ''");
  }
  if (!existingSettingColumns.includes('home_assistant_steps_entity')) {
    bindAndRun(database, "ALTER TABLE app_settings ADD COLUMN home_assistant_steps_entity TEXT NOT NULL DEFAULT ''");
  }

  const huddleColumns = bindAndFetchAll(database, 'PRAGMA table_info(huddles)').map((column) => column.name);
  if (!huddleColumns.includes('last_reply_ts')) {
    bindAndRun(database, "ALTER TABLE huddles ADD COLUMN last_reply_ts TEXT NOT NULL DEFAULT ''");
  }

  const triggerLogColumns = bindAndFetchAll(database, 'PRAGMA table_info(trigger_log)').map((column) => column.name);
  if (!triggerLogColumns.includes('channel_id')) {
    bindAndRun(database, "ALTER TABLE trigger_log ADD COLUMN channel_id TEXT NOT NULL DEFAULT ''");
  }

  bindAndRun(
    database,
    `
    INSERT OR IGNORE INTO app_settings (
      id,
      personal_channel_owner_id,
      personal_channel_id,
      timezone,
      bot_display_name,
      daily_question_enabled,
      daily_question_prompt,
      daily_question_include_in_daily_update,
      daily_question_send_time,
      daily_question_reply_text,
      welcomer_enabled,
      welcome_message_content,
      rules_canvas_url,
      daily_update_ping_user_group_id,
      daily_update_thread_enabled,
      daily_update_thread_message,
      daily_update_reminder_enabled,
      daily_update_reminder_time,
      home_assistant_url,
      home_assistant_token,
      home_assistant_steps_entity,
      updated_at
    ) VALUES (
      1,
      $personal_channel_owner_id,
      $personal_channel_id,
      $timezone,
      $bot_display_name,
      $daily_question_enabled,
      $daily_question_prompt,
      $daily_question_include_in_daily_update,
      $daily_question_send_time,
      $daily_question_reply_text,
      $welcomer_enabled,
      $welcome_message_content,
      $rules_canvas_url,
      $daily_update_ping_user_group_id,
      $daily_update_thread_enabled,
      $daily_update_thread_message,
      $daily_update_reminder_enabled,
      $daily_update_reminder_time,
      $home_assistant_url,
      $home_assistant_token,
      $home_assistant_steps_entity,
      $updated_at
    )
  `,
    DEFAULT_SETTINGS,
  );

  bindAndRun(
    database,
    `
    INSERT OR IGNORE INTO daily_update_drafts (id, main_update_text, song_text, event_text, created_at, updated_at)
    VALUES (1, '', '', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `,
  );

  bindAndRun(
    database,
    `
    INSERT OR IGNORE INTO sync_settings (
      id,
      enabled,
      todoist_api_token,
      slack_list_id,
      todoist_project_name,
      notification_channel_id,
      poll_interval_seconds,
      webhook_secret,
      updated_at
    ) VALUES (
      1,
      $enabled,
      $todoist_api_token,
      $slack_list_id,
      $todoist_project_name,
      $notification_channel_id,
      $poll_interval_seconds,
      $webhook_secret,
      $updated_at
    )
  `,
    DEFAULT_SYNC_SETTINGS,
  );
  const syncSettingsSeedAppliedThisBoot = getRowsChanged(database) > 0;

  const persist = () => {
    fs.writeFileSync(databasePath, Buffer.from(database.export()));
  };

  const getSettingsRow = () => bindAndFetchOne(database, 'SELECT * FROM app_settings WHERE id = 1');
  const updateSettingsRow = (params) => {
    bindAndRun(
      database,
      `
      UPDATE app_settings SET
        personal_channel_owner_id = $personal_channel_owner_id,
        personal_channel_id = $personal_channel_id,
        timezone = $timezone,
        bot_display_name = $bot_display_name,
        daily_question_enabled = $daily_question_enabled,
        daily_question_prompt = $daily_question_prompt,
        daily_question_include_in_daily_update = $daily_question_include_in_daily_update,
        daily_question_send_time = $daily_question_send_time,
        daily_question_reply_text = $daily_question_reply_text,
        welcomer_enabled = $welcomer_enabled,
        welcome_message_content = $welcome_message_content,
        rules_canvas_url = $rules_canvas_url,
        daily_update_ping_user_group_id = $daily_update_ping_user_group_id,
        daily_update_thread_enabled = $daily_update_thread_enabled,
        daily_update_thread_message = $daily_update_thread_message,
        daily_update_reminder_enabled = $daily_update_reminder_enabled,
        daily_update_reminder_time = $daily_update_reminder_time,
        home_assistant_url = $home_assistant_url,
        home_assistant_token = $home_assistant_token,
        home_assistant_steps_entity = $home_assistant_steps_entity,
        updated_at = $updated_at
      WHERE id = 1
    `,
      params,
    );
    persist();
  };

  const getDraftRow = () => bindAndFetchOne(database, 'SELECT * FROM daily_update_drafts WHERE id = 1');
  const upsertDraftRow = (params) => {
    bindAndRun(
      database,
      `
      INSERT INTO daily_update_drafts (id, main_update_text, song_text, event_text, created_at, updated_at)
      VALUES (1, $main_update_text, $song_text, $event_text, $created_at, $updated_at)
      ON CONFLICT(id) DO UPDATE SET
        main_update_text = excluded.main_update_text,
        song_text = excluded.song_text,
        event_text = excluded.event_text,
        updated_at = excluded.updated_at
    `,
      params,
    );
    persist();
  };

  const insertDailyUpdateRow = (params) => {
    bindAndRun(
      database,
      `
      INSERT INTO daily_update_history (
        sent_at_utc,
        local_date,
        message_ts,
        thread_ts,
        main_update_text,
        song_text,
        event_text,
        question_text,
        user_group_id,
        sent_by_user_id
      ) VALUES (
        $sent_at_utc,
        $local_date,
        $message_ts,
        $thread_ts,
        $main_update_text,
        $song_text,
        $event_text,
        $question_text,
        $user_group_id,
        $sent_by_user_id
      )
    `,
      params,
    );
    persist();
  };

  const insertDailyQuestionRow = (params) => {
    bindAndRun(
      database,
      `
      INSERT INTO daily_question_history (
        local_date,
        question_text,
        topics_json,
        tone,
        custom_instructions,
        question_hash,
        message_ts,
        generated_at_utc,
        sent_at_utc
      ) VALUES (
        $local_date,
        $question_text,
        $topics_json,
        $tone,
        $custom_instructions,
        $question_hash,
        $message_ts,
        $generated_at_utc,
        $sent_at_utc
      )
    `,
      params,
    );
    persist();
  };

  const claimJobRow = (params) => {
    const existingRow = bindAndFetchOne(
      database,
      'SELECT status, completed_at_utc FROM scheduled_job_runs WHERE job_name = $job_name AND local_date = $local_date',
      params,
    );

    if (existingRow) {
      if (existingRow.status === 'completed') {
        return false;
      }

      bindAndRun(
        database,
        `
        UPDATE scheduled_job_runs SET
          status = $status,
          claimed_at_utc = $claimed_at_utc,
          completed_at_utc = NULL,
          error_text = NULL,
          payload_json = $payload_json
        WHERE job_name = $job_name AND local_date = $local_date
      `,
        params,
      );
      persist();
      return true;
    }

    bindAndRun(
      database,
      `
      INSERT OR IGNORE INTO scheduled_job_runs (job_name, local_date, status, claimed_at_utc, payload_json)
      VALUES ($job_name, $local_date, $status, $claimed_at_utc, $payload_json)
    `,
      params,
    );
    const changes = getRowsChanged(database);
    persist();
    return changes > 0;
  };

  const updateJobRow = (params) => {
    bindAndRun(
      database,
      `
      UPDATE scheduled_job_runs SET
        status = $status,
        completed_at_utc = $completed_at_utc,
        error_text = $error_text,
        payload_json = $payload_json
      WHERE job_name = $job_name AND local_date = $local_date
    `,
      params,
    );
    persist();
  };

  const insertWelcomeEvent = (params) => {
    bindAndRun(
      database,
      `
      INSERT OR IGNORE INTO welcome_events (event_ts, channel_id, user_id, sent_at_utc, message_ts)
      VALUES ($event_ts, $channel_id, $user_id, $sent_at_utc, $message_ts)
    `,
      params,
    );
    const changes = getRowsChanged(database);
    persist();
    return changes > 0;
  };

  const getSyncSettingsRow = () => bindAndFetchOne(database, 'SELECT * FROM sync_settings WHERE id = 1');

  const updateSyncSettingsRow = (params) => {
    bindAndRun(
      database,
      `
      UPDATE sync_settings SET
        enabled = $enabled,
        todoist_api_token = $todoist_api_token,
        slack_list_id = $slack_list_id,
        todoist_project_name = $todoist_project_name,
        notification_channel_id = $notification_channel_id,
        poll_interval_seconds = $poll_interval_seconds,
        webhook_secret = $webhook_secret,
        updated_at = $updated_at
      WHERE id = 1
    `,
      params,
    );
    persist();
  };

  const store = {
    getSettings() {
      const settingsRow = getSettingsRow();
      return {
        ...settingsRow,
        daily_question_enabled: parseBoolean(settingsRow.daily_question_enabled),
        daily_question_include_in_daily_update: parseBoolean(settingsRow.daily_question_include_in_daily_update),
        welcomer_enabled: parseBoolean(settingsRow.welcomer_enabled),
        daily_update_thread_enabled: parseBoolean(settingsRow.daily_update_thread_enabled),
        daily_update_reminder_enabled: parseBoolean(settingsRow.daily_update_reminder_enabled),
      };
    },

    updateSettings(patch) {
      const currentSettings = this.getSettings();
      const mergedSettings = sanitizeSettingsPatch({
        ...currentSettings,
        ...patch,
        updated_at: new Date().toISOString(),
      });
      updateSettingsRow(mergedSettings);
      return this.getSettings();
    },

    getDraft() {
      return getDraftRow();
    },

    saveDraft(payload = {}) {
      const mainUpdateText = payload.mainUpdateText ?? payload.main_update_text ?? '';
      const songText = payload.songText ?? payload.song_text ?? '';
      const eventText = payload.eventText ?? payload.event_text ?? '';
      const existingDraft = getDraftRow();
      const nowIso = new Date().toISOString();
      upsertDraftRow({
        $main_update_text: mainUpdateText,
        $song_text: songText,
        $event_text: eventText,
        $created_at: existingDraft?.created_at ?? nowIso,
        $updated_at: nowIso,
      });
      return getDraftRow();
    },

    clearDraft() {
      const nowIso = new Date().toISOString();
      upsertDraftRow({
        $main_update_text: '',
        $song_text: '',
        $event_text: '',
        $created_at: getDraftRow()?.created_at ?? nowIso,
        $updated_at: nowIso,
      });
      return getDraftRow();
    },

    recordDailyUpdateSend(payload) {
      insertDailyUpdateRow(payload);
    },

    hasDailyUpdateOnDate(localDate) {
      const row = bindAndFetchOne(
        database,
        'SELECT COUNT(1) AS count FROM daily_update_history WHERE local_date = $local_date',
        { $local_date: localDate },
      );
      return row.count > 0;
    },

    getRecentDailyQuestionTexts(limit = 5) {
      const rows = bindAndFetchAll(
        database,
        'SELECT question_text FROM daily_question_history ORDER BY id DESC LIMIT $limit',
        { $limit: limit },
      );
      return rows.map((row) => row.question_text);
    },

    getLastDailyQuestion() {
      return bindAndFetchOne(database, 'SELECT * FROM daily_question_history ORDER BY id DESC LIMIT 1');
    },

    recordDailyQuestion({
      localDate,
      questionText,
      topics,
      tone,
      customInstructions,
      questionHash,
      messageTs = null,
      sentAtUtc = null,
    }) {
      insertDailyQuestionRow({
        $local_date: localDate,
        $question_text: questionText,
        $topics_json: JSON.stringify(topics),
        $tone: tone,
        $custom_instructions: customInstructions,
        $question_hash: questionHash,
        $message_ts: messageTs,
        $generated_at_utc: new Date().toISOString(),
        $sent_at_utc: sentAtUtc,
      });
    },

    claimScheduledJob(jobName, localDate, payload = {}) {
      return claimJobRow({
        $job_name: jobName,
        $local_date: localDate,
        $status: 'claimed',
        $claimed_at_utc: new Date().toISOString(),
        $payload_json: JSON.stringify(payload),
      });
    },

    completeScheduledJob(jobName, localDate, payload = {}) {
      updateJobRow({
        $job_name: jobName,
        $local_date: localDate,
        $status: 'completed',
        $completed_at_utc: new Date().toISOString(),
        $error_text: null,
        $payload_json: JSON.stringify(payload),
      });
    },

    failScheduledJob(jobName, localDate, errorText, payload = {}) {
      updateJobRow({
        $job_name: jobName,
        $local_date: localDate,
        $status: 'failed',
        $completed_at_utc: new Date().toISOString(),
        $error_text: errorText,
        $payload_json: JSON.stringify(payload),
      });
    },

    getScheduledJob(jobName, localDate) {
      return bindAndFetchOne(
        database,
        'SELECT * FROM scheduled_job_runs WHERE job_name = $job_name AND local_date = $local_date',
        {
          $job_name: jobName,
          $local_date: localDate,
        },
      );
    },

    recordWelcomeEvent({ eventTs, channelId, userId, messageTs }) {
      return insertWelcomeEvent({
        $event_ts: eventTs,
        $channel_id: channelId,
        $user_id: userId,
        $sent_at_utc: new Date().toISOString(),
        $message_ts: messageTs,
      });
    },

    hasWelcomeEvent({ eventTs, channelId, userId }) {
      const row = bindAndFetchOne(
        database,
        'SELECT COUNT(1) AS count FROM welcome_events WHERE event_ts = $event_ts AND channel_id = $channel_id AND user_id = $user_id',
        {
          $event_ts: eventTs,
          $channel_id: channelId,
          $user_id: userId,
        },
      );

      return row.count > 0;
    },

    hasGroupOptOut({ userId, userGroupId }) {
      const row = bindAndFetchOne(
        database,
        'SELECT COUNT(1) AS count FROM group_opt_outs WHERE user_id = $user_id AND user_group_id = $user_group_id',
        {
          $user_id: userId,
          $user_group_id: userGroupId,
        },
      );

      return row.count > 0;
    },

    recordGroupOptOut({ userId, userGroupId, optedOutAtUtc }) {
      bindAndRun(
        database,
        `
        INSERT OR IGNORE INTO group_opt_outs (user_id, user_group_id, opted_out_at_utc)
        VALUES ($user_id, $user_group_id, $opted_out_at_utc)
      `,
        {
          $user_id: userId,
          $user_group_id: userGroupId,
          $opted_out_at_utc: optedOutAtUtc || new Date().toISOString(),
        },
      );
      persist();
    },

    getSyncSettings() {
      const syncSettingsRow = getSyncSettingsRow();
      return {
        ...syncSettingsRow,
        enabled: parseBoolean(syncSettingsRow.enabled),
      };
    },

    updateSyncSettings(patch) {
      const currentSyncSettings = this.getSyncSettings();
      const mergedSyncSettings = sanitizeSyncSettingsPatch({
        ...currentSyncSettings,
        ...patch,
        updated_at: new Date().toISOString(),
      });
      updateSyncSettingsRow(mergedSyncSettings);
      return this.getSyncSettings();
    },

    listSyncItems() {
      return bindAndFetchAll(database, 'SELECT * FROM sync_items ORDER BY id ASC');
    },

    getSyncItemBySlackItemId(slackItemId) {
      return bindAndFetchOne(database, 'SELECT * FROM sync_items WHERE slack_item_id = $slack_item_id', {
        $slack_item_id: slackItemId,
      });
    },

    getSyncItemByTodoistTaskId(todoistTaskId) {
      return bindAndFetchOne(database, 'SELECT * FROM sync_items WHERE todoist_task_id = $todoist_task_id', {
        $todoist_task_id: todoistTaskId,
      });
    },

    upsertSyncItem({ slackItemId, todoistTaskId, addedBy = '', isCompleted = false, nameHash = '' }) {
      const nowIso = new Date().toISOString();
      bindAndRun(
        database,
        `
        INSERT INTO sync_items (
          slack_item_id,
          todoist_task_id,
          last_synced_at,
          created_at,
          added_by,
          is_completed,
          name_hash
        ) VALUES (
          $slack_item_id,
          $todoist_task_id,
          $last_synced_at,
          $created_at,
          $added_by,
          $is_completed,
          $name_hash
        )
        ON CONFLICT(slack_item_id) DO UPDATE SET
          todoist_task_id = excluded.todoist_task_id,
          last_synced_at = excluded.last_synced_at,
          added_by = excluded.added_by,
          is_completed = excluded.is_completed,
          name_hash = excluded.name_hash
      `,
        {
          $slack_item_id: slackItemId,
          $todoist_task_id: todoistTaskId,
          $last_synced_at: nowIso,
          $created_at: nowIso,
          $added_by: addedBy,
          $is_completed: toBooleanInteger(isCompleted),
          $name_hash: nameHash,
        },
      );
      persist();
      return this.getSyncItemBySlackItemId(slackItemId);
    },

    updateSyncItemCompletion(todoistTaskId, isCompleted, nameHash = '') {
      bindAndRun(
        database,
        `
        UPDATE sync_items SET
          is_completed = $is_completed,
          name_hash = $name_hash,
          last_synced_at = $last_synced_at
        WHERE todoist_task_id = $todoist_task_id
      `,
        {
          $todoist_task_id: todoistTaskId,
          $is_completed: toBooleanInteger(isCompleted),
          $name_hash: nameHash,
          $last_synced_at: new Date().toISOString(),
        },
      );
      persist();
      return this.getSyncItemByTodoistTaskId(todoistTaskId);
    },

    getHuddle(callId) {
      return bindAndFetchOne(database, 'SELECT * FROM huddles WHERE call_id = $call_id', {
        $call_id: callId,
      });
    },

    listHuddles() {
      return bindAndFetchAll(database, 'SELECT * FROM huddles ORDER BY started_at DESC');
    },

    upsertHuddle({
      callId,
      channelId = '',
      channelName = '',
      createdBy = '',
      startedAt = 0,
      endedAt = null,
      threadRootTs = '',
      participantHistory = [],
    }) {
      const currentHuddle = this.getHuddle(callId);
      const mergedStartedAt =
        startedAt > 0 ? startedAt : currentHuddle?.started_at > 0 ? currentHuddle.started_at : startedAt;
      const mergedEndedAt = endedAt ?? currentHuddle?.ended_at ?? null;
      const mergedStatus = currentHuddle?.status || 'active';
      bindAndRun(
        database,
        `
        INSERT INTO huddles (call_id, channel_id, channel_name, created_by, started_at, ended_at, thread_root_ts, participant_json, status, last_seen_at, created_at)
        VALUES ($call_id, $channel_id, $channel_name, $created_by, $started_at, $ended_at, $thread_root_ts, $participant_json, $status, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(call_id) DO UPDATE SET
          channel_id = excluded.channel_id,
          channel_name = excluded.channel_name,
          created_by = excluded.created_by,
          started_at = excluded.started_at,
          ended_at = excluded.ended_at,
          thread_root_ts = excluded.thread_root_ts,
          participant_json = excluded.participant_json,
          status = excluded.status,
          last_seen_at = CURRENT_TIMESTAMP
      `,
        {
          $call_id: callId,
          $channel_id: channelId,
          $channel_name: channelName,
          $created_by: createdBy,
          $started_at: mergedStartedAt,
          $ended_at: mergedEndedAt,
          $thread_root_ts: threadRootTs,
          $participant_json: JSON.stringify(participantHistory ?? []),
          $status: mergedStatus,
        },
      );
      persist();
      return this.getHuddle(callId);
    },

    setHuddleStatus(callId, status, endedAt = null) {
      bindAndRun(
        database,
        `
        UPDATE huddles SET
          status = $status,
          ended_at = COALESCE($ended_at, ended_at),
          last_seen_at = CURRENT_TIMESTAMP
        WHERE call_id = $call_id AND status IN ('active', 'opted_out')
      `,
        {
          $call_id: callId,
          $status: status,
          $ended_at: endedAt,
        },
      );
      const changes = getRowsChanged(database);
      persist();
      return changes > 0;
    },

    markHuddlePrompted(callId) {
      bindAndRun(
        database,
        `
        UPDATE huddles SET status = 'prompted', last_seen_at = CURRENT_TIMESTAMP
        WHERE call_id = $call_id
      `,
        {
          $call_id: callId,
        },
      );
      persist();
    },

    setHuddleOptedOut(callId) {
      bindAndRun(
        database,
        `
        UPDATE huddles SET status = 'opted_out', last_seen_at = CURRENT_TIMESTAMP
        WHERE call_id = $call_id
      `,
        {
          $call_id: callId,
        },
      );
      const changes = getRowsChanged(database);
      persist();
      return changes > 0;
    },

    reactivateHuddle(callId) {
      bindAndRun(
        database,
        `
        UPDATE huddles SET status = 'active', ended_at = NULL, last_seen_at = CURRENT_TIMESTAMP
        WHERE call_id = $call_id AND status IN ('opted_out', 'ended')
      `,
        {
          $call_id: callId,
        },
      );
      const changes = getRowsChanged(database);
      persist();
      return changes > 0;
    },

    listStaleActiveHuddles(beforeStartedAt) {
      return bindAndFetchAll(
        database,
        `
        SELECT * FROM huddles
        WHERE status = 'active' AND started_at > 0 AND started_at < $before_started_at
      `,
        {
          $before_started_at: beforeStartedAt,
        },
      );
    },

    setHuddleLastReplyTs(callId, ts) {
      bindAndRun(
        database,
        `
        UPDATE huddles SET last_reply_ts = $ts, last_seen_at = CURRENT_TIMESTAMP
        WHERE call_id = $call_id
      `,
        {
          $call_id: callId,
          $ts: ts,
        },
      );
      persist();
    },

    awardHuddlePoints(userId, points, channelId = '') {
      const award = Math.max(0, Math.floor(points));
      bindAndRun(
        database,
        `
        INSERT INTO huddle_leaderboard (user_id, points, updated_at)
        VALUES ($user_id, $points, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET
          points = huddle_leaderboard.points + excluded.points,
          updated_at = CURRENT_TIMESTAMP
      `,
        {
          $user_id: userId,
          $points: award,
        },
      );
      // Attributed copy, so the leaderboard can be scoped to the channels the bot is in.
      if (channelId) {
        bindAndRun(
          database,
          `
          INSERT INTO huddle_channel_points (channel_id, user_id, points, updated_at)
          VALUES ($channel_id, $user_id, $points, CURRENT_TIMESTAMP)
          ON CONFLICT(channel_id, user_id) DO UPDATE SET
            points = huddle_channel_points.points + excluded.points,
            updated_at = CURRENT_TIMESTAMP
        `,
          {
            $channel_id: channelId,
            $user_id: userId,
            $points: award,
          },
        );
      }
      persist();
    },

    listHuddleLeaderboard(limit = 50, channelIds = null) {
      if (Array.isArray(channelIds)) {
        if (channelIds.length === 0) {
          return [];
        }
        const placeholders = channelIds.map((_, index) => `$channel_${index}`).join(', ');
        const params = { $limit: Math.max(1, Math.min(100, limit)) };
        channelIds.forEach((channelId, index) => {
          params[`$channel_${index}`] = channelId;
        });
        return bindAndFetchAll(
          database,
          `
          SELECT user_id, SUM(points) AS points FROM huddle_channel_points
          WHERE channel_id IN (${placeholders})
          GROUP BY user_id
          ORDER BY points DESC, updated_at ASC, user_id ASC
          LIMIT $limit
        `,
          params,
        );
      }

      return bindAndFetchAll(
        database,
        `
        SELECT user_id, points FROM huddle_leaderboard
        ORDER BY points DESC, updated_at ASC, user_id ASC
        LIMIT $limit
      `,
        {
          $limit: Math.max(1, Math.min(100, limit)),
        },
      );
    },

    recordTriggerLog({ userId = '', action, detail = '', channelId = '' }) {
      if (!action) {
        return;
      }
      bindAndRun(
        database,
        `
        INSERT INTO trigger_log (user_id, action, detail, channel_id, created_at)
        VALUES ($user_id, $action, $detail, $channel_id, CURRENT_TIMESTAMP)
      `,
        {
          $user_id: userId,
          $action: action,
          $detail: detail,
          $channel_id: channelId,
        },
      );
      persist();
    },

    listTriggerLog(limit = 50, channelIds = null) {
      if (Array.isArray(channelIds)) {
        if (channelIds.length === 0) {
          return [];
        }
        const placeholders = channelIds.map((_, index) => `$channel_${index}`).join(', ');
        const params = {
          $limit: Math.max(1, Math.min(100, limit)),
        };
        channelIds.forEach((channelId, index) => {
          params[`$channel_${index}`] = channelId;
        });
        // Rows logged before the channel was known resolve it through the huddle they belong to.
        return bindAndFetchAll(
          database,
          `
          SELECT t.id, t.user_id, t.action, t.detail, t.created_at,
                 COALESCE(NULLIF(t.channel_id, ''), h.channel_id, '') AS channel_id
          FROM trigger_log t
          LEFT JOIN huddles h ON h.call_id = t.detail
          WHERE COALESCE(NULLIF(t.channel_id, ''), h.channel_id, '') IN (${placeholders})
          ORDER BY t.id DESC
          LIMIT $limit
        `,
          params,
        );
      }

      return bindAndFetchAll(
        database,
        `
        SELECT id, user_id, action, detail, channel_id, created_at FROM trigger_log
        ORDER BY id DESC
        LIMIT $limit
      `,
        {
          $limit: Math.max(1, Math.min(100, limit)),
        },
      );
    },

    listHuddleChannelIds() {
      return bindAndFetchAll(
        database,
        `
        SELECT DISTINCT channel_id FROM huddles
        WHERE channel_id != ''
        ORDER BY channel_id
      `,
      ).map((row) => row.channel_id);
    },

    getHuddleChannel(channelId) {
      if (!channelId) {
        return null;
      }
      return bindAndFetchOne(database, 'SELECT * FROM huddle_channels WHERE channel_id = $channel_id', {
        $channel_id: channelId,
      });
    },

    listHuddleChannels() {
      return bindAndFetchAll(database, 'SELECT * FROM huddle_channels ORDER BY channel_id');
    },

    /**
     * Channels we know about: explicitly configured ones plus any channel we have
     * recorded a huddle in. Unconfigured channels report sensible defaults.
     */
    listTrackedHuddleChannels() {
      const configured = new Map(
        bindAndFetchAll(database, 'SELECT * FROM huddle_channels').map((row) => [row.channel_id, row]),
      );
      for (const row of bindAndFetchAll(
        database,
        `
        SELECT channel_id, MAX(channel_name) AS channel_name FROM huddles
        WHERE channel_id != ''
        GROUP BY channel_id
      `,
      )) {
        if (!configured.has(row.channel_id)) {
          configured.set(row.channel_id, {
            channel_id: row.channel_id,
            name: row.channel_name || '',
            enabled: 1,
            auto_replies: 1,
            restrict_triggers: 0,
            owner_ids: '[]',
            paused_until: 0,
            configured: false,
          });
        } else if (row.channel_name && !configured.get(row.channel_id).name) {
          configured.get(row.channel_id).name = row.channel_name;
        }
      }
      return [...configured.values()].map((row) => ({
        ...row,
        configured: row.configured !== false,
        owner_ids: parseOwnerIds(row.owner_ids),
      }));
    },

    upsertHuddleChannel({
      channelId,
      name = '',
      enabled = true,
      autoReplies = true,
      restrictTriggers = false,
      ownerIds = [],
      pausedUntil = 0,
    }) {
      bindAndRun(
        database,
        `
        INSERT INTO huddle_channels (
          channel_id, name, enabled, auto_replies, restrict_triggers, owner_ids, paused_until, updated_at
        )
        VALUES ($channel_id, $name, $enabled, $auto_replies, $restrict_triggers, $owner_ids, $paused_until, CURRENT_TIMESTAMP)
        ON CONFLICT(channel_id) DO UPDATE SET
          name = excluded.name,
          enabled = excluded.enabled,
          auto_replies = excluded.auto_replies,
          restrict_triggers = excluded.restrict_triggers,
          owner_ids = excluded.owner_ids,
          paused_until = excluded.paused_until,
          updated_at = CURRENT_TIMESTAMP
      `,
        {
          $channel_id: channelId,
          $name: name,
          $enabled: enabled ? 1 : 0,
          $auto_replies: autoReplies ? 1 : 0,
          $restrict_triggers: restrictTriggers ? 1 : 0,
          $owner_ids: JSON.stringify(Array.isArray(ownerIds) ? ownerIds : []),
          $paused_until: Math.max(0, Math.floor(pausedUntil || 0)),
        },
      );
      persist();
    },

    setHuddleChannelFlag(channelId, field, value) {
      const allowed = new Set(['enabled', 'auto_replies', 'restrict_triggers', 'paused_until']);
      if (!allowed.has(field)) {
        return false;
      }
      bindAndRun(
        database,
        `
        INSERT INTO huddle_channels (channel_id, ${field}) VALUES ($channel_id, $value)
        ON CONFLICT(channel_id) DO UPDATE SET ${field} = excluded.${field}, updated_at = CURRENT_TIMESTAMP
      `,
        {
          $channel_id: channelId,
          $value: field === 'paused_until' ? Math.max(0, Math.floor(value || 0)) : value ? 1 : 0,
        },
      );
      persist();
      return true;
    },

    getUserHuddleState(userId) {
      return (
        bindAndFetchOne(database, 'SELECT * FROM huddle_user_state WHERE user_id = $user_id', {
          $user_id: userId,
        }) ?? { user_id: userId, call_id: '', is_in: 0 }
      );
    },

    setUserHuddleState({ userId, callId, isIn }) {
      bindAndRun(
        database,
        `
        INSERT INTO huddle_user_state (user_id, call_id, is_in, updated_at)
        VALUES ($user_id, $call_id, $is_in, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET
          call_id = excluded.call_id,
          is_in = excluded.is_in,
          updated_at = CURRENT_TIMESTAMP
      `,
        {
          $user_id: userId,
          $call_id: callId,
          $is_in: toBooleanInteger(isIn),
        },
      );
      persist();
    },

    upsertHuddleMember({ callId, userId, firstSeenAt, lastSeenAt, isIn }) {
      bindAndRun(
        database,
        `
        INSERT INTO huddle_members (call_id, user_id, first_seen_at, last_seen_at, is_in)
        VALUES ($call_id, $user_id, $first_seen_at, $last_seen_at, $is_in)
        ON CONFLICT(call_id, user_id) DO UPDATE SET
          first_seen_at = CASE
            WHEN huddle_members.first_seen_at IS NULL
              OR (excluded.first_seen_at IS NOT NULL AND excluded.first_seen_at < huddle_members.first_seen_at)
            THEN excluded.first_seen_at
            ELSE huddle_members.first_seen_at
          END,
          last_seen_at = CASE
            WHEN huddle_members.last_seen_at IS NULL
              OR (excluded.last_seen_at IS NOT NULL AND excluded.last_seen_at > huddle_members.last_seen_at)
            THEN excluded.last_seen_at
            ELSE huddle_members.last_seen_at
          END,
          is_in = excluded.is_in
      `,
        {
          $call_id: callId,
          $user_id: userId,
          $first_seen_at: firstSeenAt ?? null,
          $last_seen_at: lastSeenAt ?? null,
          $is_in: toBooleanInteger(isIn),
        },
      );
      persist();
    },

    listHuddleMembers(callId) {
      return bindAndFetchAll(database, 'SELECT * FROM huddle_members WHERE call_id = $call_id', {
        $call_id: callId,
      });
    },

    countActiveHuddleMembers(callId) {
      const row = bindAndFetchOne(
        database,
        'SELECT COUNT(1) AS count FROM huddle_members WHERE call_id = $call_id AND is_in = 1',
        {
          $call_id: callId,
        },
      );
      return row.count;
    },

    close() {
      persist();
      database.close();
    },
  };

  const { ownerId = '', channelId = '' } = options;
  const currentSettings = store.getSettings();
  const seedPatch = {};
  if (!currentSettings.personal_channel_owner_id && ownerId) {
    seedPatch.personal_channel_owner_id = ownerId;
  }
  if (!currentSettings.personal_channel_id && channelId) {
    seedPatch.personal_channel_id = channelId;
  }
  if (Object.keys(seedPatch).length > 0) {
    store.updateSettings(seedPatch);
  }

  const currentSyncSettings = store.getSyncSettings();
  const seedSyncPatch = {};
  if (!currentSyncSettings.todoist_api_token && options.todoistApiToken) {
    seedSyncPatch.todoist_api_token = options.todoistApiToken;
  }
  if (!currentSyncSettings.slack_list_id && options.slackListId) {
    seedSyncPatch.slack_list_id = options.slackListId;
  }
  if (!currentSyncSettings.notification_channel_id && options.notificationChannelId) {
    seedSyncPatch.notification_channel_id = options.notificationChannelId;
  }
  if (!currentSyncSettings.todoist_project_name && options.todoistProjectName) {
    seedSyncPatch.todoist_project_name = options.todoistProjectName;
  }
  if (!currentSyncSettings.webhook_secret && options.todoistWebhookSecret) {
    seedSyncPatch.webhook_secret = options.todoistWebhookSecret;
  }
  if (syncSettingsSeedAppliedThisBoot && options.syncEnabled !== undefined && options.syncEnabled !== null) {
    seedSyncPatch.enabled = options.syncEnabled;
  }
  if (
    syncSettingsSeedAppliedThisBoot &&
    options.syncPollIntervalSeconds !== undefined &&
    options.syncPollIntervalSeconds !== null
  ) {
    seedSyncPatch.poll_interval_seconds = options.syncPollIntervalSeconds;
  }
  if (Object.keys(seedSyncPatch).length > 0) {
    store.updateSyncSettings(seedSyncPatch);
  }

  return store;
}
