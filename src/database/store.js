import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';
import { summariseAttendance } from '../huddles/attendance.js';
import { parseParticipantHistory } from '../huddles/points.js';
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

/**
 * Epoch seconds from whatever a timestamp column happens to hold.
 *
 * The two huddle tables disagree and both are load bearing: `huddle_members`
 * is written with epoch seconds from the tracker, while `huddles.last_seen_at`
 * is filled in by `CURRENT_TIMESTAMP`, which SQLite stores as `YYYY-MM-DD
 * HH:MM:SS` in UTC. Comparing the two directly in SQL puts every integer before
 * every string, so a mixed `MAX()` silently returns the wrong column. Read them
 * separately and normalise here instead.
 */
function toEpochSeconds(value) {
  if (value === null || value === undefined || value === '') {
    return 0;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) {
    return Number(raw);
  }
  const parsed = Date.parse(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
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

    -- One row per stretch of time somebody was actually in a huddle.
    --
    -- huddle_members only keeps a single (first_seen_at, last_seen_at) pair per
    -- person, which silently assumes they never left: rejoining overwrote the
    -- leave and the gap was destroyed, so a 58 second appearance was billed as
    -- 182 minutes. Intervals keep the gaps, and attendance is their sum.
    CREATE TABLE IF NOT EXISTS huddle_attendance (
      call_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      left_at INTEGER,
      -- 1 when we filled the leave time in ourselves because Slack never sent
      -- one. The span is a ceiling, not a measurement, so it is never awarded
      -- as points and never counted as proven.
      inferred INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (call_id, user_id, joined_at)
    );

    CREATE INDEX IF NOT EXISTS idx_huddle_attendance_call
      ON huddle_attendance (call_id);

    -- Frozen copy of the leaderboard as it stood before attendance was
    -- recomputed from real intervals, so the old totals can still be audited.
    CREATE TABLE IF NOT EXISTS huddle_leaderboard_v1 (
      user_id TEXT PRIMARY KEY,
      points INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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

    CREATE TABLE IF NOT EXISTS dashboard_sessions (
      token TEXT PRIMARY KEY,
      slack_user_id TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS dashboard_users (
      slack_user_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL DEFAULT '',
      leaderboard_opt_in INTEGER NOT NULL DEFAULT 1,
      last_login_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS huddle_channels (
      channel_id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      auto_replies INTEGER NOT NULL DEFAULT 1,
      restrict_triggers INTEGER NOT NULL DEFAULT 0,
      owner_ids TEXT NOT NULL DEFAULT '[]',
      paused_until INTEGER NOT NULL DEFAULT 0,
      -- 0 = the channel is public, 1 = private, -1 = we have not been told yet.
      -- Anything other than 0 is treated as private, so an unanswered Slack
      -- lookup hides detail rather than publishing a private channel.
      is_private INTEGER NOT NULL DEFAULT -1,
      -- When on, the bot posts only the one line summary and leaves the detail
      -- on the huddle's own page.
      condensed_review INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Why each person got the points they got, per huddle.
    --
    -- huddle_leaderboard only ever held a running total, which made it
    -- impossible to answer "why does this person have 808 points" or to show the
    -- breakdown on a huddle's own page. Reasons are kept as written by
    -- computeHuddlePoints ("12m", "rank 1", "longest message") so the wording
    -- on the page is the wording the rules produced.
    CREATE TABLE IF NOT EXISTS huddle_awards (
      huddle_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL DEFAULT '',
      points INTEGER NOT NULL DEFAULT 0,
      reasons TEXT NOT NULL DEFAULT '[]',
      awarded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (huddle_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_huddle_awards_user ON huddle_awards(user_id);
    CREATE INDEX IF NOT EXISTS idx_huddle_awards_channel ON huddle_awards(channel_id);

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

  // Added after the first release, so existing databases need them backfilled.
  // is_private defaults to -1 (unknown) rather than 0, because guessing "public"
  // for a channel we have not checked would publish a private channel's detail.
  const huddleChannelColumns = bindAndFetchAll(database, 'PRAGMA table_info(huddle_channels)').map(
    (column) => column.name,
  );
  if (!huddleChannelColumns.includes('is_private')) {
    bindAndRun(database, 'ALTER TABLE huddle_channels ADD COLUMN is_private INTEGER NOT NULL DEFAULT -1');
  }
  if (!huddleChannelColumns.includes('condensed_review')) {
    bindAndRun(database, 'ALTER TABLE huddle_channels ADD COLUMN condensed_review INTEGER NOT NULL DEFAULT 0');
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

    /** Huddles the bot still believes are running, oldest first. */
    /**
     * Drop placeholders for huddles whose channel was never confirmed.
     *
     * A join event can arrive before the thread message that names the channel.
     * The placeholder is held unverified, and if that message never turns up the
     * huddle was never in a channel the bot is in, so it is discarded rather than
     * left lying around in the database.
     */
    purgeUnverifiedHuddles(olderThanSeconds) {
      const cutoff = Math.floor(Date.now() / 1000) - Math.max(60, Number(olderThanSeconds) || 3600);
      // Any huddle still open with no channel, plus every unverified placeholder.
      // An ended row is left alone: history that is already closed is not this
      // sweep's business, and the migration decides what to do with it.
      const rows = bindAndFetchAll(
        database,
        `
        SELECT call_id FROM huddles
        WHERE (status = 'unverified' OR (channel_id = '' AND status IN ('active', 'opted_out')))
          AND started_at > 0 AND started_at < $cutoff
        `,
        { $cutoff: cutoff },
      );
      for (const row of rows) {
        bindAndRun(database, 'DELETE FROM huddle_members WHERE call_id = $call_id', { $call_id: row.call_id });
        bindAndRun(database, 'DELETE FROM huddle_attendance WHERE call_id = $call_id', { $call_id: row.call_id });
        bindAndRun(database, 'DELETE FROM huddles WHERE call_id = $call_id', { $call_id: row.call_id });
      }
      if (rows.length > 0) {
        persist();
      }
      return rows.length;
    },

    listActiveHuddles() {
      // A channel_id is required, so the reconciler never touches a huddle the
      // bot has not confirmed it is inside.
      return bindAndFetchAll(
        database,
        `
        SELECT * FROM huddles
        WHERE status = 'active' AND started_at > 0 AND channel_id <> ''
        ORDER BY started_at ASC
        `,
      );
    },

    /**
     * When we last heard anything about a huddle, as epoch seconds, or 0.
     *
     * Used to decide whether a huddle has gone quiet enough to be worth asking
     * Slack about. A huddle people are still joining and leaving in is never
     * polled, which keeps the reconciler off Slack almost entirely.
     */
    lastHuddleActivityAt(callId) {
      const row = bindAndFetchOne(
        database,
        `
        SELECT MAX(m.last_seen_at) AS member_at, h.last_seen_at AS huddle_at
        FROM huddles h
        LEFT JOIN huddle_members m ON m.call_id = h.call_id
        WHERE h.call_id = $call_id
      `,
        { $call_id: callId },
      );
      return Math.max(toEpochSeconds(row?.member_at), toEpochSeconds(row?.huddle_at));
    },

    /** Everyone still flagged as in a huddle is not in it any more. */
    clearHuddleMembers(callId) {
      bindAndRun(database, 'UPDATE huddle_members SET is_in = 0 WHERE call_id = $call_id AND is_in = 1', {
        $call_id: callId,
      });
      persist();
    },

    /**
     * Rewrite huddles that were closed at exactly the stale window's length.
     *
     * The old sweep gave up on a huddle and wrote `started_at + 12h` as its end,
     * so the stored duration says nothing about how long the huddle actually
     * ran. The last time any member was recorded as present bounds it from
     * above, and that is what these rows are moved to.
     *
     * Only rows matching the exact placeholder are touched, so this is safe to
     * run repeatedly and cannot shorten a huddle that ended normally.
     */
    repairPlaceholderHuddleEnds(windowSeconds = 12 * 60 * 60) {
      const rows = bindAndFetchAll(
        database,
        `
        SELECT h.call_id, h.started_at, MAX(m.last_seen_at) AS last_seen
        FROM huddles h
        JOIN huddle_members m ON m.call_id = h.call_id
        WHERE h.status = 'ended' AND (h.ended_at - h.started_at) = $window
        GROUP BY h.call_id
      `,
        { $window: windowSeconds },
      );
      let changed = 0;
      for (const row of rows) {
        const endedAt = toEpochSeconds(row.last_seen);
        // Only accept something inside the window, otherwise the row was closed
        // for a real reason and the placeholder length is a coincidence.
        if (!Number.isFinite(endedAt) || endedAt <= row.started_at || endedAt >= row.started_at + windowSeconds) {
          continue;
        }
        bindAndRun(database, "UPDATE huddles SET ended_at = $ended_at WHERE call_id = $call_id AND status = 'ended'", {
          $ended_at: endedAt,
          $call_id: row.call_id,
        });
        changed += 1;
      }
      persist();
      const durations = bindAndFetchAll(
        database,
        "SELECT (ended_at - started_at) AS d FROM huddles WHERE status = 'ended' AND ended_at > started_at ORDER BY d",
      ).map((row) => Number(row.d));
      return {
        rows: changed,
        medianSeconds: durations[Math.floor(durations.length / 2)] ?? 0,
        total: durations.length,
      };
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
      // When Slack last told us about this huddle, as epoch seconds. Defaults to
      // now, which is right for a row we have just created. It is passed
      // explicitly when replaying an older huddle_thread message, because
      // CURRENT_TIMESTAMP would otherwise make a two hour old huddle look like
      // it was reported on a moment ago and the reconciler would never poll it.
      lastSeenAt = 0,
      // Only used when the row is created. 'unverified' marks a huddle that was
      // seen joining before we knew which channel it was in; it may not be scored,
      // reviewed, shown or linked until a thread message proves the bot is inside.
      status = 'active',
    }) {
      const currentHuddle = this.getHuddle(callId);
      const mergedStartedAt =
        startedAt > 0 ? startedAt : currentHuddle?.started_at > 0 ? currentHuddle.started_at : startedAt;
      const mergedEndedAt = endedAt ?? currentHuddle?.ended_at ?? null;
      const mergedStatus = currentHuddle?.status || status;
      bindAndRun(
        database,
        `
        INSERT INTO huddles (call_id, channel_id, channel_name, created_by, started_at, ended_at, thread_root_ts, participant_json, status, last_seen_at, created_at)
        VALUES ($call_id, $channel_id, $channel_name, $created_by, $started_at, $ended_at, $thread_root_ts, $participant_json, $status, $last_seen_at, CURRENT_TIMESTAMP)
        ON CONFLICT(call_id) DO UPDATE SET
          -- A huddle row is created by the join event, which carries no channel,
          -- and the channel only arrives with the later thread message. Updating
          -- unconditionally meant any event without a channel wiped a channel we
          -- already knew, losing the attribution that points and per-channel
          -- stats depend on.
          channel_id = CASE
            WHEN excluded.channel_id <> '' THEN excluded.channel_id
            ELSE huddles.channel_id
          END,
          channel_name = excluded.channel_name,
          created_by = excluded.created_by,
          started_at = excluded.started_at,
          ended_at = excluded.ended_at,
          thread_root_ts = excluded.thread_root_ts,
          participant_json = excluded.participant_json,
          status = excluded.status,
          last_seen_at = excluded.last_seen_at
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
          $last_seen_at: lastSeenAt > 0 ? lastSeenAt : Math.floor(Date.now() / 1000),
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
        WHERE call_id = $call_id AND status IN ('active', 'opted_out', 'unverified')
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
        // Scope off the attributed copy only. huddle_channel_points is written
        // alongside huddle_leaderboard for every award that has a channel, so it
        // is the only table that can answer "points in THESE channels". Starting
        // from the lifetime total and subtracting the points we can prove landed
        // elsewhere cannot work: any untracked channel that was never attributed
        // stays in the total, which is exactly how untracked people ended up on
        // the board. rebuildHuddleChannelPoints backfills the attribution for
        // huddles that predate it.
        return bindAndFetchAll(
          database,
          `
          SELECT user_id, SUM(points) AS points
          FROM huddle_channel_points
          WHERE channel_id IN (${placeholders})
            AND user_id NOT IN (SELECT slack_user_id FROM dashboard_users WHERE leaderboard_opt_in = 0)
          GROUP BY user_id
          HAVING SUM(points) > 0
          ORDER BY points DESC, user_id ASC
          LIMIT $limit
        `,
          params,
        );
      }

      return bindAndFetchAll(
        database,
        `
        SELECT user_id, points FROM huddle_leaderboard
        WHERE user_id NOT IN (SELECT slack_user_id FROM dashboard_users WHERE leaderboard_opt_in = 0)
        ORDER BY points DESC, updated_at ASC, user_id ASC
        LIMIT $limit
      `,
        {
          $limit: Math.max(1, Math.min(100, limit)),
        },
      );
    },

    /**
     * Lifetime points vs the attributed per-channel copy. The attributed table is
     * what a scoped leaderboard is built from, so a lifetime total with nothing
     * attributed means every scoped query silently degrades to "no data".
     */
    huddlePointTotals() {
      const lifetime = bindAndFetchOne(database, 'SELECT COALESCE(SUM(points), 0) AS points FROM huddle_leaderboard');
      const attributed = bindAndFetchOne(
        database,
        'SELECT COALESCE(SUM(points), 0) AS points, COUNT(1) AS rows FROM huddle_channel_points',
      );
      return {
        lifetime: Number(lifetime.points) || 0,
        attributed: Number(attributed.points) || 0,
        rows: Number(attributed.rows) || 0,
      };
    },

    /**
     * Rebuild huddle_channel_points from the huddles themselves. `computeAwards`
     * is injected (rather than imported) so the store keeps no dependency on the
     * scoring layer, and so a full replace can never double count: this wipes
     * the attributed copy and rewrites it from the source huddles.
     */
    rebuildHuddleChannelPoints(computeAwards) {
      if (typeof computeAwards !== 'function') {
        throw new TypeError('rebuildHuddleChannelPoints requires a computeAwards function');
      }
      const huddles = bindAndFetchAll(
        database,
        "SELECT * FROM huddles WHERE status = 'ended' AND channel_id IS NOT NULL AND channel_id != ''",
      );
      const totals = new Map();
      let failed = 0;
      for (const huddle of huddles) {
        let awards;
        try {
          awards = computeAwards(huddle, this.listHuddleMembers(huddle.call_id));
        } catch {
          // One unreadable huddle must not abandon the whole rebuild.
          failed++;
          continue;
        }
        if (!awards) {
          failed++;
          continue;
        }
        const entries = awards instanceof Map ? awards : new Map(Object.entries(awards));
        for (const [userId, value] of entries) {
          if (!userId || !huddle.channel_id) {
            continue;
          }
          const raw = typeof value === 'object' && value !== null ? value.points : value;
          const points = Math.max(0, Math.floor(Number(raw) || 0));
          if (!points) {
            continue;
          }
          const key = `${huddle.channel_id}\u0000${userId}`;
          totals.set(key, (totals.get(key) || 0) + points);
        }
      }
      // The delete below is destructive, and a scoring bug that made every huddle
      // fail would otherwise replace a working board with an empty one. Refuse
      // instead, so the next run can try again with the same old data intact.
      if (huddles.length && !totals.size) {
        throw new Error(
          `rebuildHuddleChannelPoints computed no points from ${huddles.length} huddle(s); keeping the existing table`,
        );
      }
      bindAndRun(database, 'DELETE FROM huddle_channel_points');
      let points = 0;
      for (const [key, total] of totals) {
        const [channelId, userId] = key.split('\u0000');
        points += total;
        bindAndRun(
          database,
          `
          INSERT INTO huddle_channel_points (channel_id, user_id, points, updated_at)
          VALUES ($channel_id, $user_id, $points, CURRENT_TIMESTAMP)
          ON CONFLICT(channel_id, user_id) DO UPDATE SET
            points = excluded.points,
            updated_at = CURRENT_TIMESTAMP
        `,
          { $channel_id: channelId, $user_id: userId, $points: total },
        );
      }
      return { huddles: huddles.length, rows: totals.size, points, failed };
    },

    /** Remember a channel name we learned from Slack so it survives a restart. */
    setHuddleChannelName(channelId, name) {
      const clean = String(name || '')
        .trim()
        .replace(/^#/, '');
      if (!channelId || !clean) {
        return false;
      }
      bindAndRun(
        database,
        `
        INSERT INTO huddle_channels (channel_id, name) VALUES ($channel_id, $name)
        ON CONFLICT(channel_id) DO UPDATE SET name = excluded.name
      `,
        { $channel_id: channelId, $name: clean },
      );
      return true;
    },

    // createdAt lets the historical rebuild and its tests write trail rows that
    // carry a real timestamp. It is an explicit override rather than a silent
    // default, so live callers keep using the database clock.
    recordTriggerLog({ userId = '', action, detail = '', channelId = '', createdAt = null }) {
      if (!action) {
        return;
      }
      bindAndRun(
        database,
        `
        INSERT INTO trigger_log (user_id, action, detail, channel_id, created_at)
        VALUES ($user_id, $action, $detail, $channel_id, COALESCE($created_at, CURRENT_TIMESTAMP))
      `,
        {
          $created_at: createdAt,
          $user_id: userId,
          $action: action,
          $detail: detail,
          $channel_id: channelId,
        },
      );
      persist();
    },

    /**
     * Every join and leave event ever recorded, grouped by huddle.
     *
     * listTriggerLog is capped at 100 rows for the admin view, which is far too
     * few to rebuild attendance from, so the audit trail gets its own reader.
     */
    listHuddleTrailEvents() {
      return bindAndFetchAll(
        database,
        `
        SELECT detail AS call_id, user_id, action, created_at
        FROM trigger_log
        WHERE action IN ('huddle_join', 'huddle_leave') AND detail != ''
        ORDER BY id ASC
        `,
      );
    },

    /** Who Slack currently believes is inside a given huddle. */
    listUsersInHuddle(callId) {
      return bindAndFetchAll(database, 'SELECT user_id FROM huddle_user_state WHERE call_id = $call_id AND is_in = 1', {
        $call_id: String(callId || ''),
      });
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
            is_private: -1,
            condensed_review: 0,
          });
        } else if (row.channel_name && !configured.get(row.channel_id).name) {
          configured.get(row.channel_id).name = row.channel_name;
        }
      }
      return [...configured.values()].map((row) => ({
        ...row,
        configured: row.configured !== false,
        owner_ids: parseOwnerIds(row.owner_ids),
        // Anything that is not a confirmed 0 counts as private, so a channel we
        // have never been told about is never treated as publishable.
        isPrivate: Number(row.is_private) === 0 ? 0 : Number(row.is_private) === 1 ? 1 : -1,
        condensedReview: Number(row.condensed_review) === 1,
      }));
    },

    /**
     * Record just the public/private answer for a channel.
     *
     * Deliberately narrow. `upsertHuddleChannel` writes the whole row, so using
     * it to remember a privacy lookup would reset the name, the owner list and
     * the toggles to whatever the caller happened to have in hand.
     */
    setHuddleChannelPrivacy(channelId, isPrivate) {
      if (!channelId) {
        return false;
      }
      // Preserve the tri-state. `isPrivate ? 1 : 0` would turn -1 (unknown)
      // into 1 (private), which is a different and much stronger claim than the
      // caller made, and a raw 0 for a failed lookup would claim "public".
      const value = Number(isPrivate) === 0 ? 0 : Number(isPrivate) === 1 ? 1 : -1;
      bindAndRun(
        database,
        `
        INSERT INTO huddle_channels (channel_id, is_private) VALUES ($channel_id, $is_private)
        ON CONFLICT(channel_id) DO UPDATE SET
          is_private = excluded.is_private,
          updated_at = CURRENT_TIMESTAMP
      `,
        { $channel_id: channelId, $is_private: value },
      );
      persist();
      return true;
    },

    upsertHuddleChannel({
      channelId,
      name = '',
      enabled = true,
      autoReplies = true,
      restrictTriggers = false,
      ownerIds = [],
      pausedUntil = 0,
      condensedReview,
      isPrivate,
    }) {
      // Only write the privacy and condensed columns when the caller actually
      // knows them, so a partial update cannot reset a setting someone set in
      // App Home by way of a stale copy of the row.
      const sets = [
        'name = excluded.name',
        'enabled = excluded.enabled',
        'auto_replies = excluded.auto_replies',
        'restrict_triggers = excluded.restrict_triggers',
        'owner_ids = excluded.owner_ids',
        'paused_until = excluded.paused_until',
      ];
      if (condensedReview !== undefined) {
        sets.push('condensed_review = excluded.condensed_review');
      }
      if (isPrivate !== undefined) {
        sets.push('is_private = excluded.is_private');
      }
      bindAndRun(
        database,
        `
        INSERT INTO huddle_channels (
          channel_id, name, enabled, auto_replies, restrict_triggers, owner_ids, paused_until,
          condensed_review, is_private, updated_at
        )
        VALUES (
          $channel_id, $name, $enabled, $auto_replies, $restrict_triggers, $owner_ids, $paused_until,
          $condensed_review, $is_private, CURRENT_TIMESTAMP
        )
        ON CONFLICT(channel_id) DO UPDATE SET
          ${sets.join(',\n          ')},
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
          $condensed_review: condensedReview ? 1 : 0,
          // -1 is "unknown" and is preserved on insert; see the schema comment.
          $is_private: isPrivate === undefined ? -1 : isPrivate ? 1 : 0,
        },
      );
      persist();
    },

    /**
     * Replace the stored breakdown for one huddle.
     *
     * Called with the full set of awards rather than merged in, because a huddle
     * can be re-tracked with the track-again button and the second pass may award
     * a different total. Passing the whole Map makes the write idempotent.
     */
    saveHuddleAwards(callId, channelId, awards) {
      const huddleId = String(callId || '');
      if (!huddleId) {
        return 0;
      }
      const rows = [...(awards instanceof Map ? awards : new Map(Object.entries(awards || {})))].filter(
        ([userId]) => userId,
      );
      bindAndRun(database, 'DELETE FROM huddle_awards WHERE huddle_id = $huddle_id', { $huddle_id: huddleId });
      for (const [userId, entry] of rows) {
        bindAndRun(
          database,
          `
          INSERT INTO huddle_awards (huddle_id, user_id, channel_id, points, reasons, awarded_at)
          VALUES ($huddle_id, $user_id, $channel_id, $points, $reasons, CURRENT_TIMESTAMP)
        `,
          {
            $huddle_id: huddleId,
            $user_id: userId,
            $channel_id: String(channelId || ''),
            $points: Math.max(0, Math.floor(entry?.points || 0)),
            $reasons: JSON.stringify(Array.isArray(entry?.reasons) ? entry.reasons : []),
          },
        );
      }
      if (rows.length > 0) {
        persist();
      }
      return rows.length;
    },

    /** The per-person points breakdown for one huddle, biggest first. */
    listHuddleAwards(callId) {
      return bindAndFetchAll(
        database,
        `
        SELECT user_id, channel_id, points, reasons
        FROM huddle_awards
        WHERE huddle_id = $huddle_id
        ORDER BY points DESC, user_id ASC
      `,
        { $huddle_id: String(callId || '') },
      ).map((row) => ({
        userId: row.user_id,
        channelId: row.channel_id || '',
        points: Number(row.points) || 0,
        reasons: (() => {
          try {
            const parsed = JSON.parse(row.reasons || '[]');
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })(),
      }));
    },

    /**
     * Was this person actually in this huddle?
     *
     * Gates the per person breakdown on a huddle's own page. Slack drops the
     * occasional join event, so this also checks the participant trail the
     * huddle thread carries, not just the member rows.
     */
    isHuddleParticipant(callId, userId) {
      const id = String(userId || '');
      if (!id) {
        return false;
      }
      // A presence interval is proof of attendance, and is the record that now
      // exists for every huddle tracked since intervals were introduced.
      if (
        bindAndFetchOne(
          database,
          'SELECT 1 AS ok FROM huddle_attendance WHERE call_id = $call_id AND user_id = $user_id LIMIT 1',
          {
            $call_id: String(callId || ''),
            $user_id: id,
          },
        )
      ) {
        return true;
      }
      if (
        bindAndFetchOne(
          database,
          'SELECT 1 AS ok FROM huddle_members WHERE call_id = $call_id AND user_id = $user_id',
          {
            $call_id: String(callId || ''),
            $user_id: id,
          },
        )
      ) {
        return true;
      }
      return parseParticipantHistory(this.getHuddle(callId)).includes(id);
    },

    /** Total points and total huddle time for a channel, from stored awards and huddles. */
    listChannelAwardTotals(channelId) {
      const points =
        Number(
          bindAndFetchOne(
            database,
            'SELECT COALESCE(SUM(points), 0) AS total FROM huddle_awards WHERE channel_id = $channel_id',
            { $channel_id: String(channelId || '') },
          )?.total,
        ) || 0;
      const seconds =
        Number(
          bindAndFetchOne(
            database,
            `
            SELECT COALESCE(SUM(MAX(0, ended_at - started_at)), 0) AS total FROM huddles
            WHERE channel_id = $channel_id AND ended_at IS NOT NULL AND ended_at > started_at
          `,
            { $channel_id: String(channelId || '') },
          )?.total,
        ) || 0;
      return { points, seconds };
    },

    /**
     * Add an owner to a channel that has none yet, and do nothing otherwise.
     *
     * This is how the Flaron channel creator becomes the first owner without
     * letting an automatic write fight the owner list the humans edit in App
     * Home. Once a channel has any owner, this is a no-op, so adding or
     * removing owners by hand can never be undone by a later sync.
     */
    seedHuddleChannelOwner(channelId, userId) {
      const id = String(userId || '').trim();
      if (!channelId || !id) {
        return false;
      }
      const existing = this.getHuddleChannel(channelId);
      const owners = parseOwnerIds(existing?.owner_ids);
      if (owners.length > 0) {
        return false;
      }
      bindAndRun(
        database,
        `
        INSERT INTO huddle_channels (channel_id, owner_ids, updated_at)
        VALUES ($channel_id, $owner_ids, CURRENT_TIMESTAMP)
        ON CONFLICT(channel_id) DO UPDATE SET
          owner_ids = excluded.owner_ids,
          updated_at = CURRENT_TIMESTAMP
        WHERE huddle_channels.owner_ids = '[]'
      `,
        {
          $channel_id: channelId,
          $owner_ids: JSON.stringify([id]),
        },
      );
      persist();
      return true;
    },

    setHuddleChannelFlag(channelId, field, value) {
      const allowed = new Set(['enabled', 'auto_replies', 'restrict_triggers', 'condensed_review', 'paused_until']);
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

    /**
     * Record that somebody joined a huddle, opening a presence interval.
     *
     * A second join without an intervening leave (Slack sometimes re-sends one)
     * extends the open interval instead of creating an overlapping second one,
     * so attendance can never be counted twice for the same moment.
     */
    openHuddleAttendance(callId, userId, at) {
      const joinedAt = Math.floor(Number(at) || Date.now() / 1000);
      const open = bindAndFetchOne(
        database,
        `
        SELECT joined_at FROM huddle_attendance
        WHERE call_id = $call_id AND user_id = $user_id AND left_at IS NULL
        ORDER BY joined_at LIMIT 1
        `,
        { $call_id: String(callId || ''), $user_id: String(userId || '') },
      );
      if (open) {
        return;
      }
      bindAndRun(
        database,
        'INSERT OR IGNORE INTO huddle_attendance (call_id, user_id, joined_at, left_at) VALUES ($call_id, $user_id, $joined_at, NULL)',
        { $call_id: String(callId || ''), $user_id: String(userId || ''), $joined_at: joinedAt },
      );
      persist();
    },

    /**
     * Close somebody's open presence interval, keeping the exact leave time.
     */
    closeHuddleAttendance(callId, userId, at) {
      const leftAt = Math.floor(Number(at) || Date.now() / 1000);
      bindAndRun(
        database,
        `
        UPDATE huddle_attendance SET left_at = $left_at
        WHERE call_id = $call_id AND user_id = $user_id AND left_at IS NULL
        `,
        { $call_id: String(callId || ''), $user_id: String(userId || ''), $left_at: leftAt },
      );
      persist();
    },

    /**
     * Close every still-open interval for a huddle, marking the end as inferred.
     *
     * Slack drops leave events, so a join can outlive the call with no matching
     * leave. The end time is filled in to bound the row, but `inferred` keeps it
     * out of anybody's score: it is a ceiling we cannot prove.
     */
    closeAllOpenHuddleAttendance(callId, at) {
      const leftAt = Math.floor(Number(at) || Date.now() / 1000);
      const result = bindAndRun(
        database,
        'UPDATE huddle_attendance SET left_at = $left_at, inferred = 1 WHERE call_id = $call_id AND left_at IS NULL',
        { $call_id: String(callId || ''), $left_at: leftAt },
      );
      persist();
      return result?.changes ?? 0;
    },

    /** Insert an interval directly, used when rebuilding attendance from the audit trail. */
    insertHuddleAttendance({ callId, userId, joinedAt, leftAt = null, inferred = false }) {
      bindAndRun(
        database,
        `
        INSERT OR REPLACE INTO huddle_attendance (call_id, user_id, joined_at, left_at, inferred)
        VALUES ($call_id, $user_id, $joined_at, $left_at, $inferred)
        `,
        {
          $call_id: String(callId || ''),
          $user_id: String(userId || ''),
          $joined_at: Math.floor(Number(joinedAt) || 0),
          $left_at: leftAt == null ? null : Math.floor(Number(leftAt)),
          $inferred: toBooleanInteger(inferred),
        },
      );
    },

    /** Wipe rebuilt attendance, so the rebuild can be re-run from scratch. */
    clearHuddleAttendance() {
      bindAndRun(database, 'DELETE FROM huddle_attendance');
    },

    /** How many rows are in the pre-recompute snapshot. Used to prove a dry run took none. */
    countLeaderboardSnapshots() {
      return Number(bindAndFetchOne(database, 'SELECT COUNT(*) AS n FROM huddle_leaderboard_v1')?.n ?? 0);
    },

    /** Freeze the current leaderboard before it is recomputed, for auditing. */
    snapshotLeaderboard() {
      bindAndRun(
        database,
        `
        INSERT OR REPLACE INTO huddle_leaderboard_v1 (user_id, points, updated_at)
        SELECT user_id, points, updated_at FROM huddle_leaderboard
        `,
      );
      persist();
      return bindAndFetchOne(database, 'SELECT COUNT(*) AS n FROM huddle_leaderboard_v1')?.n ?? 0;
    },

    /** Set somebody's leaderboard and per channel totals to an exact recomputed value. */
    setLeaderboardTotals(userId, points, channelId = '') {
      bindAndRun(
        database,
        `
        INSERT INTO huddle_leaderboard (user_id, points, updated_at) VALUES ($user_id, $points, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET points = excluded.points, updated_at = CURRENT_TIMESTAMP
        `,
        { $user_id: String(userId || ''), $points: Math.max(0, Math.floor(Number(points) || 0)) },
      );
      if (channelId) {
        bindAndRun(
          database,
          `
          INSERT INTO huddle_channel_points (channel_id, user_id, points, updated_at)
          VALUES ($channel_id, $user_id, $points, CURRENT_TIMESTAMP)
          ON CONFLICT(channel_id, user_id) DO UPDATE SET points = excluded.points, updated_at = CURRENT_TIMESTAMP
          `,
          {
            $channel_id: String(channelId || ''),
            $user_id: String(userId || ''),
            $points: Math.max(0, Math.floor(Number(points) || 0)),
          },
        );
      }
    },

    /** Every leaderboard row, for the recompute. */
    listLeaderboardTotals() {
      return bindAndFetchAll(database, 'SELECT user_id, points FROM huddle_leaderboard');
    },

    /** Overwrite one channel's running total for a person, used by the recompute. */
    setChannelPointTotals(channelId, userId, points) {
      bindAndRun(
        database,
        `
        INSERT INTO huddle_channel_points (channel_id, user_id, points, updated_at)
        VALUES ($channel_id, $user_id, $points, CURRENT_TIMESTAMP)
        ON CONFLICT(channel_id, user_id) DO UPDATE SET points = excluded.points, updated_at = CURRENT_TIMESTAMP
        `,
        {
          $channel_id: String(channelId || ''),
          $user_id: String(userId || ''),
          $points: Math.max(0, Math.floor(Number(points) || 0)),
        },
      );
      persist();
    },

    listChannelPointTotals() {
      return bindAndFetchAll(database, 'SELECT channel_id, user_id, points FROM huddle_channel_points');
    },

    /** Raw presence intervals for a huddle, oldest first. */
    listHuddleAttendance(callId) {
      return bindAndFetchAll(
        database,
        'SELECT user_id, joined_at, left_at, inferred FROM huddle_attendance WHERE call_id = $call_id ORDER BY user_id, joined_at',
        { $call_id: String(callId || '') },
      );
    },

    /** Did anybody leave a join open? If so, some attendance is unprovable. */
    countOpenHuddleAttendance(callId) {
      const row = bindAndFetchOne(
        database,
        'SELECT COUNT(*) AS n FROM huddle_attendance WHERE call_id = $call_id AND left_at IS NULL',
        { $call_id: String(callId || '') },
      );
      return Number(row?.n) || 0;
    },

    /**
     * Per person attendance for a huddle, as the sum of closed intervals.
     *
     * Intervals are clipped to the call's own window and to each other, so
     * overlapping or out of range events can never inflate the total past the
     * length of the huddle itself. When a join was never closed the person's
     * time is reported as what can actually be proven and `partial` is set, so
     * points are never awarded on a guess.
     */
    computeHuddleAttendance(callId, { startedAt = null, endedAt = null } = {}) {
      // The maths lives in one pure function so the historical rebuild can
      // reproduce these exact totals without touching the database.
      return summariseAttendance(this.listHuddleAttendance(callId), { startedAt, endedAt });
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

    getHuddleMember(callId, userId) {
      return bindAndFetchOne(database, 'SELECT * FROM huddle_members WHERE call_id = $call_id AND user_id = $user_id', {
        $call_id: String(callId || ''),
        $user_id: String(userId || ''),
      });
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

    createDashboardSession({ token, slackUserId, role }) {
      bindAndRun(
        database,
        `
        INSERT INTO dashboard_sessions (token, slack_user_id, role, created_at, last_seen_at)
        VALUES ($token, $slack_user_id, $role, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(token) DO UPDATE SET
          slack_user_id = excluded.slack_user_id,
          role = excluded.role,
          last_seen_at = CURRENT_TIMESTAMP
      `,
        {
          $token: token,
          $slack_user_id: slackUserId,
          $role: role,
        },
      );
      persist();
    },

    getDashboardSession(token) {
      if (!token) {
        return null;
      }
      return bindAndFetchOne(
        database,
        'SELECT token, slack_user_id, role, created_at, last_seen_at FROM dashboard_sessions WHERE token = $token',
        { $token: token },
      );
    },

    touchDashboardSession(token) {
      bindAndRun(database, 'UPDATE dashboard_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE token = $token', {
        $token: token,
      });
    },

    deleteDashboardSession(token) {
      bindAndRun(database, 'DELETE FROM dashboard_sessions WHERE token = $token', { $token: token });
      persist();
    },

    pruneDashboardSessions(maxAgeSeconds = 60 * 60 * 24 * 30) {
      const cutoff = new Date(Date.now() - maxAgeSeconds * 1000).toISOString().replace('T', ' ').slice(0, 19);
      bindAndRun(database, 'DELETE FROM dashboard_sessions WHERE last_seen_at < $cutoff', { $cutoff: cutoff });
      persist();
    },

    upsertDashboardUser({ slackUserId, displayName = '' }) {
      bindAndRun(
        database,
        `
        INSERT INTO dashboard_users (slack_user_id, display_name, last_login_at, created_at)
        VALUES ($slack_user_id, $display_name, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(slack_user_id) DO UPDATE SET
          display_name = CASE WHEN excluded.display_name != '' THEN excluded.display_name ELSE dashboard_users.display_name END,
          last_login_at = CURRENT_TIMESTAMP
      `,
        { $slack_user_id: slackUserId, $display_name: displayName },
      );
      persist();
    },

    getDashboardUser(slackUserId) {
      return bindAndFetchOne(
        database,
        'SELECT slack_user_id, display_name, leaderboard_opt_in, last_login_at FROM dashboard_users WHERE slack_user_id = $id',
        { $id: slackUserId },
      );
    },

    setDashboardLeaderboardOptIn(slackUserId, optedIn) {
      bindAndRun(
        database,
        `
        INSERT INTO dashboard_users (slack_user_id, leaderboard_opt_in, last_login_at)
        VALUES ($id, $opt_in, CURRENT_TIMESTAMP)
        ON CONFLICT(slack_user_id) DO UPDATE SET leaderboard_opt_in = excluded.leaderboard_opt_in
      `,
        { $id: slackUserId, $opt_in: optedIn ? 1 : 0 },
      );
      persist();
      return this.getDashboardUser(slackUserId);
    },

    listDashboardUsers() {
      return bindAndFetchAll(
        database,
        'SELECT slack_user_id, display_name, leaderboard_opt_in, last_login_at FROM dashboard_users ORDER BY last_login_at DESC LIMIT 200',
      );
    },

    isLeaderboardOptedIn(slackUserId) {
      const row = bindAndFetchOne(
        database,
        'SELECT leaderboard_opt_in FROM dashboard_users WHERE slack_user_id = $id',
        { $id: slackUserId },
      );
      // Anyone who has never touched the switch is on the leaderboard.
      return !row || Number(row.leaderboard_opt_in) !== 0;
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
