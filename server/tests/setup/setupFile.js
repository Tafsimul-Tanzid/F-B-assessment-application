/**
 * Per-file environment. Must run before src/config is imported, so it is
 * listed in vitest's `setupFiles` rather than done inside a test.
 */
process.env.NODE_ENV = 'test';
process.env.DB_NAME = process.env.DB_NAME ?? 'fnb_pos_test';
process.env.DB_HOST = process.env.DB_HOST ?? '127.0.0.1';
process.env.DB_PORT = process.env.DB_PORT ?? '5433';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret-value-at-least-16-chars';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';
process.env.RUN_MIGRATIONS_ON_BOOT = 'false';
process.env.SEED_ON_BOOT = 'false';
// A little headroom over the default so the 50-way concurrency test does not
// fail on connection acquisition rather than on what it is actually testing.
process.env.DB_POOL_MAX = process.env.DB_POOL_MAX ?? '30';
