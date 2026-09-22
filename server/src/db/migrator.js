import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readdir } from 'node:fs/promises';
import { Umzug, SequelizeStorage } from 'umzug';

import { sequelize } from './sequelize.js';
import { logger } from '../utils/logger.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const MIGRATIONS_DIR = path.resolve(here, '../../migrations');
const SEEDERS_DIR = path.resolve(here, '../../seeders');

/**
 * Umzug's default resolver uses `require`, which does not work in an ESM
 * package. Both runners below load migration files with dynamic `import`
 * instead, and pass the shared Sequelize instance + QueryInterface through.
 */
async function buildRunner({ directory, tableName }) {
  let files = [];
  try {
    files = (await readdir(directory)).filter((f) => f.endsWith('.js')).sort();
  } catch {
    // Directory may not exist yet during early scaffolding.
    files = [];
  }

  return new Umzug({
    migrations: files.map((file) => ({
      name: file,
      path: path.join(directory, file),
      up: async () => {
        const mod = await import(pathToFileURL(path.join(directory, file)).href);
        return mod.up({ context: sequelize.getQueryInterface(), sequelize });
      },
      down: async () => {
        const mod = await import(pathToFileURL(path.join(directory, file)).href);
        if (typeof mod.down !== 'function') {
          throw new Error(`Migration ${file} has no down()`);
        }
        return mod.down({ context: sequelize.getQueryInterface(), sequelize });
      },
    })),
    context: sequelize.getQueryInterface(),
    storage: new SequelizeStorage({ sequelize, tableName }),
    logger: {
      info: (msg) => logger.info(typeof msg === 'string' ? msg : msg.event, msg),
      warn: (msg) => logger.warn(typeof msg === 'string' ? msg : msg.event, msg),
      error: (msg) => logger.error(typeof msg === 'string' ? msg : msg.event, msg),
      debug: () => {},
    },
  });
}

export const getMigrator = () =>
  buildRunner({ directory: MIGRATIONS_DIR, tableName: 'schema_migrations' });

export const getSeeder = () =>
  buildRunner({ directory: SEEDERS_DIR, tableName: 'schema_seeders' });

export async function runMigrations() {
  const migrator = await getMigrator();
  const applied = await migrator.up();
  if (applied.length) {
    logger.info(`Applied ${applied.length} migration(s)`, {
      migrations: applied.map((m) => m.name),
    });
  } else {
    logger.info('Database schema already up to date');
  }
  return applied;
}

export async function runSeeders() {
  const seeder = await getSeeder();
  const applied = await seeder.up();
  if (applied.length) {
    logger.info(`Applied ${applied.length} seeder(s)`, { seeders: applied.map((m) => m.name) });
  } else {
    logger.info('Seed data already present');
  }
  return applied;
}
