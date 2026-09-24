import { pingDatabase } from '../db/sequelize.js';

/**
 * Liveness plus readiness.
 *
 * The database ping matters: a container that is up but cannot reach Postgres
 * is not ready to take sales, and the orchestrator's health check should fail
 * it rather than route traffic to it.
 */
export async function getHealth() {
  const startedAt = process.hrtime.bigint();
  let database = 'ok';
  let healthy = true;

  try {
    await pingDatabase();
  } catch {
    database = 'unreachable';
    healthy = false;
  }

  return {
    healthy,
    body: {
      status: healthy ? 'ok' : 'degraded',
      database,
      dbLatencyMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e5) / 10,
      uptimeSeconds: Math.round(process.uptime()),
    },
  };
}
