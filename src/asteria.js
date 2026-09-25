import { App, LogLevel } from '@slack/bolt';
import { createHomeHandlers } from './app-home/handlers.js';
import { loadEnvironment } from './config/env.js';
import { createStore } from './database/store.js';
import { createHuddleTracker } from './huddles/tracker.js';
import { createScheduler } from './scheduler.js';
import { createHackClubAiService } from './services/ai.js';
import { createTodoistSync } from './sync/todoist-sync.js';
import { createWebhookServer } from './sync/webhook-server.js';

function getLogLevel(logLevel) {
  const normalizedLevel = (logLevel || 'info').toLowerCase();
  if (normalizedLevel === 'debug') return LogLevel.DEBUG;
  if (normalizedLevel === 'warn') return LogLevel.WARN;
  if (normalizedLevel === 'error') return LogLevel.ERROR;
  return LogLevel.INFO;
}

export async function createAsteriaRuntime() {
  const environment = loadEnvironment();
  const store = await createStore(environment.databasePath, {
    ownerId: environment.personalChannelOwnerId,
    channelId: environment.personalChannelId,
    todoistApiToken: environment.todoistApiToken,
    slackListId: environment.slackListId,
    todoistProjectName: environment.todoistProjectName,
    notificationChannelId: environment.notificationChannelId,
    todoistWebhookSecret: environment.todoistWebhookSecret,
    syncEnabled: environment.syncEnabled,
    syncPollIntervalSeconds: environment.syncPollIntervalSeconds,
  });

  const app = new App({
    token: environment.slackBotToken,
    appToken: environment.slackAppToken,
    signingSecret: environment.slackSigningSecret,
    socketMode: true,
    logLevel: getLogLevel(environment.logLevel),
  });

  const logger = app.logger;
  const aiService = createHackClubAiService({
    apiKey: environment.hackClubAiKey,
    baseUrl: environment.hackClubAiBaseUrl,
    model: environment.hackClubAiModel,
    logger,
  });

  const scheduler = createScheduler({
    store,
    aiService,
    client: app.client,
    logger,
    environment,
  });

  createHomeHandlers({
    app,
    store,
    aiService,
    environment,
    scheduler,
  });

  const huddleTracker = createHuddleTracker({
    app,
    store,
    client: app.client,
    logger,
    ownerId: store.getSettings().personal_channel_owner_id || environment.personalChannelOwnerId,
  });

  const todoistSync = createTodoistSync({
    store,
    client: app.client,
    logger,
    environment,
  });

  const webhookServer = createWebhookServer({
    sync: todoistSync,
    getSettings: () => store.getSyncSettings(),
    logger,
    port: environment.todoistWebhookPort,
  });

  webhookServer.start();

  let syncTimer = null;
  let isSyncRunning = false;

  async function runSyncTick() {
    if (isSyncRunning) {
      return;
    }
    isSyncRunning = true;
    try {
      const syncSettings = store.getSyncSettings();
      if (syncSettings.enabled) {
        await todoistSync.syncOnce(syncSettings);
      }
    } finally {
      isSyncRunning = false;
    }
  }

  const syncPollInterval = Math.max(15, store.getSyncSettings().poll_interval_seconds) * 1000;

  const syncPoller = {
    start() {
      if (syncTimer) {
        return;
      }
      void runSyncTick();
      syncTimer = setInterval(() => {
        void runSyncTick();
      }, syncPollInterval);
    },
    stop() {
      if (syncTimer) {
        clearInterval(syncTimer);
        syncTimer = null;
      }
    },
  };

  app.error(async (error) => {
    logger.error('Unhandled Bolt error', error);
  });

  return {
    app,
    environment,
    store,
    scheduler,
    todoistSync,
    webhookServer,
    syncPoller,
    huddleTracker,
  };
}
