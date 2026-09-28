import { App, LogLevel } from '@slack/bolt';
import { createHomeHandlers } from './app-home/handlers.js';
import { createChannelPermissions } from './app-home/permissions.js';
import { loadEnvironment } from './config/env.js';
import { createDashboardServer } from './dashboard/server.js';
import { backfillChannelPoints } from './database/backfill-channel-points.js';
import { createStore } from './database/store.js';
import { registerDmDeleteByLink } from './dm/delete-by-link.js';
import { createHuddleTracker } from './huddles/tracker.js';
import { createScheduler } from './scheduler.js';
import { createHackClubAiService } from './services/ai.js';
import { createBotChannelDirectory } from './services/bot-channels.js';
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

  const botChannels = createBotChannelDirectory({ client: app.client, logger });
  const permissions = createChannelPermissions({ store });

  // Attribute the per-huddle points that predate huddle_channel_points before
  // anything can read a channel-scoped leaderboard. Cheap and self-healing: it
  // is a no-op once the attributed copy has rows. A failure here must not stop
  // the bot from starting, it just leaves the board short until the next boot.
  try {
    backfillChannelPoints(store, { logger });
  } catch (error) {
    logger.error(`Could not attribute historical huddle points: ${error?.message || error}`);
  }

  createHomeHandlers({
    app,
    store,
    aiService,
    environment,
    scheduler,
    botChannels,
    permissions,
  });

  registerDmDeleteByLink({
    app,
    store,
    client: app.client,
    logger,
    permissions,
  });

  const huddleTracker = createHuddleTracker({
    app,
    store,
    client: app.client,
    logger,
    botChannels,
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

  // The dashboard shares this process so it reads the same in-memory database as the
  // bot. A second process opening the same sql.js file would overwrite live state.
  const dashboardServer = createDashboardServer({
    store,
    client: app.client,
    botChannels,
    logger,
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
    dashboardServer,
  };
}
