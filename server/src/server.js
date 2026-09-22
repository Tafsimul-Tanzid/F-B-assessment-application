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
