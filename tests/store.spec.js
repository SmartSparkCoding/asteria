import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createStore } from '../src/database/store.js';
import { DEFAULT_QUESTION_PROMPT } from '../src/services/ai.js';

let createdPaths = [];

afterEach(() => {
  for (const databasePath of createdPaths) {
    fs.rmSync(path.dirname(databasePath), { recursive: true, force: true });
  }
  createdPaths = [];
});

describe('Orbit store', () => {
  it('persists settings and drafts across restarts', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-store-'));
    const databasePath = path.join(tempDir, 'asteria.sqlite');
    createdPaths.push(databasePath);

    let store = await createStore(databasePath);
    store.updateSettings({
      personal_channel_owner_id: 'UOWNER',
      personal_channel_id: 'C123',
      timezone: 'Europe/London',
      daily_update_ping_user_group_id: 'S123',
    });
    store.saveDraft({
      mainUpdateText: 'Hello world',
      songText: 'Song',
      eventText: 'Event',
    });
    store.recordDailyUpdateSend({
      sent_at_utc: '2026-08-03T12:00:00Z',
      local_date: '2026-08-03',
      message_ts: '111.222',
      thread_ts: '111.222',
      main_update_text: 'Hello world',
      song_text: 'Song',
      event_text: 'Event',
      question_text: '',
      user_group_id: 'S123',
      sent_by_user_id: 'UOWNER',
    });
    store.close();

    store = await createStore(databasePath);
    const settings = store.getSettings();
    const draft = store.getDraft();

    assert.equal(settings.personal_channel_owner_id, 'UOWNER');
    assert.equal(settings.personal_channel_id, 'C123');
    assert.equal(settings.timezone, 'Europe/London');
    assert.equal(settings.daily_update_ping_user_group_id, 'S123');
    assert.equal(draft.main_update_text, 'Hello world');
    assert.equal(store.hasDailyUpdateOnDate('2026-08-03'), true);
    store.close();
  });

  it('defaults, persists, and falls back the configured bot name', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-store-'));
    const databasePath = path.join(tempDir, 'asteria.sqlite');
    createdPaths.push(databasePath);

    let store = await createStore(databasePath);
    assert.equal(store.getSettings().bot_display_name, "Jacob's Orbit");
    store.updateSettings({ bot_display_name: 'Star' });
    assert.equal(store.getSettings().bot_display_name, 'Star');
    store.close();

    store = await createStore(databasePath);
    assert.equal(store.getSettings().bot_display_name, 'Star');
    store.updateSettings({ bot_display_name: '   ' });
    assert.equal(store.getSettings().bot_display_name, "Jacob's Orbit");
    store.close();
  });

  it('defaults, persists, and falls back the Daily Question prompt', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-store-'));
    const databasePath = path.join(tempDir, 'asteria.sqlite');
    createdPaths.push(databasePath);

    let store = await createStore(databasePath);
    assert.equal(store.getSettings().daily_question_prompt, DEFAULT_QUESTION_PROMPT);
    store.updateSettings({ daily_question_prompt: 'Ask about robotics in one sentence.' });
    assert.equal(store.getSettings().daily_question_prompt, 'Ask about robotics in one sentence.');
    store.close();

    store = await createStore(databasePath);
    assert.equal(store.getSettings().daily_question_prompt, 'Ask about robotics in one sentence.');
    store.updateSettings({ daily_question_prompt: '   ' });
    assert.equal(store.getSettings().daily_question_prompt, DEFAULT_QUESTION_PROMPT);
    store.close();
  });

  it('seeds the personal channel owner and channel from environment on first run', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-store-'));
    const databasePath = path.join(tempDir, 'asteria.sqlite');
    createdPaths.push(databasePath);

    const store = await createStore(databasePath, {
      ownerId: 'UOWNER',
      channelId: 'C123',
    });
    const settings = store.getSettings();

    assert.equal(settings.personal_channel_owner_id, 'UOWNER');
    assert.equal(settings.personal_channel_id, 'C123');
    store.close();
  });

  it('does not overwrite existing owner or channel with environment values', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-store-'));
    const databasePath = path.join(tempDir, 'asteria.sqlite');
    createdPaths.push(databasePath);

    let store = await createStore(databasePath, {
      ownerId: 'UOWNER',
      channelId: 'C123',
    });
    store.updateSettings({ personal_channel_id: 'CRUNTIME' });
    store.close();

    store = await createStore(databasePath, {
      ownerId: 'UOTHER',
      channelId: 'COTHER',
    });
    const settings = store.getSettings();

    assert.equal(settings.personal_channel_owner_id, 'UOWNER');
    assert.equal(settings.personal_channel_id, 'CRUNTIME');
    store.close();
  });

  it('does not re-claim a completed scheduled job for the same day', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-store-'));
    const databasePath = path.join(tempDir, 'asteria.sqlite');
    createdPaths.push(databasePath);

    const store = await createStore(databasePath);
    assert.equal(
      store.claimScheduledJob('daily-reminder', '2026-08-03', {
        kind: 'reminder',
      }),
      true,
    );
    store.completeScheduledJob('daily-reminder', '2026-08-03', {
      sent: true,
    });
    assert.equal(
      store.claimScheduledJob('daily-reminder', '2026-08-03', {
        kind: 'reminder',
      }),
      false,
    );
    store.close();
  });

  it('allows re-claiming a failed or in-flight scheduled job so it can retry', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-store-'));
    const databasePath = path.join(tempDir, 'asteria.sqlite');
    createdPaths.push(databasePath);

    const store = await createStore(databasePath);
    assert.equal(store.claimScheduledJob('daily-reminder', '2026-08-04'), true);
    assert.equal(store.claimScheduledJob('daily-reminder', '2026-08-04'), true);
    store.failScheduledJob('daily-reminder', '2026-08-04', 'DM failed');
    assert.equal(store.claimScheduledJob('daily-reminder', '2026-08-04'), true);
    store.completeScheduledJob('daily-reminder', '2026-08-04', {
      sent: true,
    });
    assert.equal(store.claimScheduledJob('daily-reminder', '2026-08-04'), false);
    store.close();
  });

  it('clears closed huddles that were never in a channel', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asteria-store-'));
    const databasePath = path.join(tempDir, 'asteria.sqlite');
    createdPaths.push(databasePath);

    const store = await createStore(databasePath);
    const now = Math.floor(Date.now() / 1000);
    store.upsertHuddle({ callId: 'Rgone', startedAt: now - 600, endedAt: now - 60 });
    store.setHuddleStatus('Rgone', 'ended', now - 60);
    store.upsertHuddleMember({
      callId: 'Rgone',
      userId: 'U1',
      firstSeenAt: now - 600,
      lastSeenAt: now - 60,
      isIn: false,
    });
    store.upsertHuddle({ callId: 'Rkept', startedAt: now - 600, channelId: 'C1', threadRootTs: '1.1' });
    store.upsertHuddle({ callId: 'Rlive', startedAt: now - 60 });

    assert.equal(store.purgeOrphanHuddles(), 1, 'only the closed, channel-less huddle goes');
    assert.equal(store.getHuddle('Rgone'), null);
    assert.equal(store.listHuddleMembers('Rgone').length, 0, 'its members go with it');
    assert(store.getHuddle('Rkept'), 'a huddle with a channel is kept');
    assert(store.getHuddle('Rlive'), 'a placeholder the reconciler may still promote is kept');
    assert.equal(store.purgeOrphanHuddles(), 0, 'a second run is a no-op');
    store.close();
  });
});
