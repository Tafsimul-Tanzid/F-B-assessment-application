import { sequelize } from './sequelize.js';
import { getMigrator, runMigrations, runSeeders } from './migrator.js';
import { logger } from '../utils/logger.js';

const command = process.argv[2];

const commands = {
  up: runMigrations,
  seed: runSeeders,
  down: async () => {
    const migrator = await getMigrator();
    const reverted = await migrator.down();
    logger.info(`Reverted ${reverted.length} migration(s)`, {
      migrations: reverted.map((m) => m.name),
    });
  },
  status: async () => {
    const migrator = await getMigrator();
    const [executed, pending] = await Promise.all([migrator.executed(), migrator.pending()]);
    logger.info('Migration status', {
      executed: executed.map((m) => m.name),
      pending: pending.map((m) => m.name),
    });
  },
};

const run = commands[command];

if (!run) {
  console.error(`Unknown command "${command ?? ''}". Expected one of: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}

try {
  await run();
  await sequelize.close();
  process.exit(0);
} catch (error) {
  logger.error('Database command failed', { command, message: error.message, stack: error.stack });
  await sequelize.close().catch(() => {});
  process.exit(1);
}
