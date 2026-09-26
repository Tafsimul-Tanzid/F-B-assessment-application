import { Sequelize } from 'sequelize';
import pg from 'pg';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

/**
 * `numeric`/`decimal` columns are returned by node-postgres as STRINGS, on
 * purpose — a JS number cannot hold arbitrary precision decimals, so parsing
 * money into a float silently corrupts it (0.1 + 0.2 !== 0.3).
 *
 * We keep that default. Money arithmetic happens in SQL, where it stays
 * `numeric`. Quantity comparisons also happen in SQL, because comparing the
 * raw strings in JS is worse than useless: "9" >= "10" is true.
 *
 * This line is documentation, not configuration — it is here so nobody
 * "helpfully" adds a float parser later.
 */
pg.defaults.parseInt8 = false;

const common = {
  dialect: 'postgres',
  dialectModule: pg,
  logging: config.logLevel === 'debug' ? (sql) => logger.debug(sql) : false,
  pool: {
    max: config.db.poolMax,
    min: config.db.poolMin,
    // A sale holds its connection for the whole transaction. If the pool is
    // exhausted we want a fast, clear failure rather than a hung request.
    acquire: 10_000,
    idle: 10_000,
  },
  define: {
    underscored: true,
    freezeTableName: true,
    timestamps: false,
  },
  dialectOptions: config.db.ssl
    ? { ssl: { require: true, rejectUnauthorized: false } }
    : {},
};

export const sequelize = config.db.url
  ? new Sequelize(config.db.url, common)
  : new Sequelize(config.db.name, config.db.user, config.db.password, {
      ...common,
      host: config.db.host,
      port: config.db.port,
    });

export async function assertDatabaseConnection() {
  await sequelize.authenticate();
}

/**
 * Cheapest possible round trip to the database, for the health endpoint.
 *
 * This lives here rather than in a repository because it is infrastructure,
 * not data access - there is no business entity involved.
 */
export async function pingDatabase() {
  await sequelize.query('SELECT 1');
}

/**
 * Bounds how long a transaction will wait on a lock before giving up, so one
 * stuck transaction cannot queue an entire outlet's sales behind it.
 *
 * Lives here rather than inline in a service: `SET LOCAL` is infrastructure
 * (a session/transaction setting, not a business entity), and Postgres does
 * not support bind parameters for a SET statement's value, so this is the one
 * place that string interpolation of a config value is deliberately
 * unavoidable - `lockTimeoutMs` is a zod-validated positive integer from our
 * own config, never user input.
 */
export async function applyLockTimeout(transaction) {
  await sequelize.query(`SET LOCAL lock_timeout = '${config.db.lockTimeoutMs}ms'`, { transaction });
}

export default sequelize;
