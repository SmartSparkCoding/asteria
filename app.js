import { createOrbitRuntime } from './src/orbit.js';

async function main() {
  const { app, scheduler, store, syncPoller, webhookServer, dashboardServer } = await createOrbitRuntime();

  const dashboardPort = Number(process.env.ASTERIA_DASHBOARD_PORT || 8787);
  const dashboardHost = process.env.ASTERIA_DASHBOARD_HOST || '0.0.0.0';
  const shutdown = async () => {
    scheduler.stop();
    syncPoller.stop();
    webhookServer.stop();
    await dashboardServer.close().catch(() => {});
    store.close();
    await app.stop().catch(() => {});
  };

  process.once('SIGINT', () => {
    void shutdown().finally(() => process.exit(0));
  });

  process.once('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
  });

  await app.start();
  scheduler.start();
  syncPoller.start();
  await dashboardServer.listen(dashboardPort, dashboardHost);
  app.logger.info("Jacob's Orbit is running in Socket Mode.");
}

main().catch((error) => {
  console.error("Jacob's Orbit failed to start:", error);
  process.exit(1);
});
