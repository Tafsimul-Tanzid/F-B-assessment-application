import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

/**
 * Environment is parsed and validated exactly once, here, at boot.
 * `process.env` is not read anywhere else in the codebase — a missing or
 * malformed variable must fail loudly on startup rather than surface as a
 * confusing runtime error on the first request that happens to need it.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4010),

  // Either a full connection URL (what managed hosts hand you) or discrete parts.
  DATABASE_URL: z.string().url().optional(),
  // 127.0.0.1 rather than "localhost": on macOS localhost resolves to ::1
  // first, which silently reaches a native Postgres instead of the container
  // when both are installed.
  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().positive().default(5433),
  DB_NAME: z.string().default('fnb_pos'),
  DB_USER: z.string().default('postgres'),
  DB_PASSWORD: z.string().default('postgres'),
  DB_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Each in-flight sale pins a pooled connection for the length of its
  // transaction, so this is sized against peak concurrent sales, not RPS.
  DB_POOL_MAX: z.coerce.number().int().positive().default(20),
  DB_POOL_MIN: z.coerce.number().int().nonnegative().default(2),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('12h'),

  CORS_ORIGIN: z.string().default('*'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),

  // Applied per write transaction, so one stuck transaction cannot queue an
  // entire outlet's sales behind it indefinitely.
  LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),

  RUN_MIGRATIONS_ON_BOOT: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  SEED_ON_BOOT: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  // Deliberately not a thrown error: a stack trace here is noise. The operator
  // needs to know which variable is wrong, not where zod lives.
  console.error(`Invalid environment configuration:\n${details}\n`);
  process.exit(1);
}

const env = parsed.data;

export const config = Object.freeze({
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  port: env.PORT,

  db: Object.freeze({
    url: env.DATABASE_URL,
    host: env.DB_HOST,
    port: env.DB_PORT,
    name: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    ssl: env.DB_SSL,
    poolMax: env.DB_POOL_MAX,
    poolMin: env.DB_POOL_MIN,
    lockTimeoutMs: env.LOCK_TIMEOUT_MS,
  }),

  auth: Object.freeze({
    jwtSecret: env.JWT_SECRET,
    jwtExpiresIn: env.JWT_EXPIRES_IN,
  }),

  corsOrigin: env.CORS_ORIGIN,
  logLevel: env.LOG_LEVEL,

  runMigrationsOnBoot: env.RUN_MIGRATIONS_ON_BOOT,
  seedOnBoot: env.SEED_ON_BOOT,
});

export default config;
