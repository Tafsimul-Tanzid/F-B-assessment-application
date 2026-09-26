import { createApp } from './app.js';
import { config } from './config/index.js';
import { sequelize, assertDatabaseConnection } from './db/sequelize.js';
import { runMigrations, runSeeders } from './db/migrator.js';
import { logger } from './utils/logger.js';

/**
 * Boot sequence: prove the database is reachable, bring the schema up to date,
 * then start listening. Serving traffic before the schema is ready would turn
 * a clear startup failure into a stream of confusing 500s.
 */
async function start() {
  await assertDatabaseConnection();
  logger.info('Database connection established', {
    database: config.db.url ? '(from DATABASE_URL)' : `${config.db.host}:${config.db.port}/${config.db.name}`,
  });

  if (config.runMigrationsOnBoot) await runMigrations();
  if (config.seedOnBoot) await runSeeders();

  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info(`API listening on port ${config.port}`, { env: config.env });
  });

  // A failure to bind (e.g. EADDRINUSE) fires here, after start()'s own
  // .catch below has already resolved - without this it is an uncaught
  // exception with no structured log.
  server.on('error', (error) => {
    logger.error('Server failed to start', { message: error.message, code: error.code });
    process.exit(1);
  });

  const shutdown = async (signal) => {
    logger.info(`Received ${signal}, shutting down`);
    // Stop accepting new connections, let in-flight sales finish their
    // transaction, then release the pool.
    server.close(async () => {
      await sequelize.close().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((error) => {
  logger.error('Failed to start server', { message: error.message, stack: error.stack });
  process.exit(1);
});

// Last-resort net: every await in this codebase is inside a try/catch or an
// asyncHandler-wrapped route, so reaching here means something outside that
// coverage went wrong. Log it with a stack rather than let the process die
// silently or in an inconsistent state.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', {
    message: reason?.message ?? String(reason),
    stack: reason?.stack,
  });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { message: error.message, stack: error.stack });
  process.exit(1);
});
