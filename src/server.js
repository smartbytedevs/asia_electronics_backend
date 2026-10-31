'use strict';

const app = require('./app');
const config = require('./config');
const { connectDatabase, disconnectDatabase } = require('./config/database');
const { defaultCourierService } = require('./modules/courier/courier.routes');
const {
  createReconciliationScheduler,
} = require('./modules/courier/courier.reconciliation.scheduler');

/**
 * Startup sequence:
 *   Load configuration
 *      ↓
 *   Initialize application
 *      ↓
 *   Connect MongoDB
 *      ↓
 *   Start HTTP server
 *      ↓
 *   Start reconciliation scheduler (if COURIER_RECONCILE_ENABLED=true)
 *
 * The HTTP server only listens after the database connection succeeds; the
 * scheduler only starts inside the listen callback (after the server is
 * accepting connections), so no timer exists before the DB is ready. On
 * connection failure the process exits with a non-zero status.
 */
function defaultSchedulerFactory() {
  return createReconciliationScheduler({
    courierService: defaultCourierService,
    config,
  });
}

/**
 * Boots the application and returns `{ server, shutdown }`. Dependencies are
 * injectable for tests; the production defaults bind the real database, app,
 * and scheduler wiring.
 *
 * @param {object} [options]
 * @param {Function} [options.connect]        - resolves once MongoDB is ready.
 * @param {Function} [options.disconnect]     - closes MongoDB on shutdown.
 * @param {Function} [options.listen]         - `(port, onListening) => server`.
 * @param {Function} [options.schedulerFactory] - returns a reconciliation
 *   scheduler or `null` when disabled.
 */
async function startServer({
  connect = connectDatabase,
  disconnect = disconnectDatabase,
  listen = (port, onListening) => app.listen(port, onListening),
  schedulerFactory = defaultSchedulerFactory,
} = {}) {
  await connect();

  const reconciliationScheduler = schedulerFactory();

  const server = listen(config.port, () => {
    console.log(
      `[asia-electronics] Server started on http://localhost:${config.port} (env: ${config.env})`
    );
    const courierProviderLabel =
      config.courier.provider === 'pathao'
        ? `pathao (${config.pathao.mode})`
        : config.courier.provider;
    console.log(`[courier] provider: ${courierProviderLabel}`);
    if (reconciliationScheduler) {
      reconciliationScheduler.start();
      console.log(
        `[courier] reconciliation scheduler started (interval: ${config.courier.reconcileIntervalMs}ms)`
      );
    }
  });

  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[asia-electronics] ${signal} received, shutting down...`);

    // Safety net: never hang forever on shutdown.
    const forceExitTimer = setTimeout(() => {
      console.error('[asia-electronics] Shutdown timed out, forcing exit');
      process.exit(1);
    }, 15000);
    forceExitTimer.unref();

    try {
      // Stop scheduling new reconciliation runs and await any in-flight pass
      // so MongoDB is never disconnected mid-query.
      if (reconciliationScheduler) {
        await reconciliationScheduler.stop();
      }

      await new Promise((resolve) => {
        server.close(resolve);
        // Drop lingering keep-alive connections so close() can complete.
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
      });

      await disconnect();
      console.log('[asia-electronics] Shutdown complete');
    } finally {
      clearTimeout(forceExitTimer);
    }
  };

  return { server, shutdown };
}

async function main() {
  const { shutdown } = await startServer();

  const shutdownAndExit = (signal) => {
    shutdown(signal).then(
      () => process.exit(0),
      (err) => {
        console.error(`[asia-electronics] ${err && err.message}`);
        process.exit(1);
      }
    );
  };

  process.on('SIGINT', () => shutdownAndExit('SIGINT'));
  process.on('SIGTERM', () => shutdownAndExit('SIGTERM'));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[asia-electronics] ${err.message}`);
    console.error('[asia-electronics] Application startup aborted.');
    process.exit(1);
  });
}

module.exports = { startServer, defaultSchedulerFactory };
