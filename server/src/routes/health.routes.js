import { Router } from 'express';
import { sequelize } from '../db/sequelize.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();

/**
 * Liveness + readiness in one endpoint. The database ping matters: a container
 * that is up but cannot reach Postgres is not ready to take sales, and the
 * Docker/Render healthcheck should fail it rather than route traffic to it.
 */
router.get(
  '/health',
  asyncHandler(async (_req, res) => {
    const startedAt = process.hrtime.bigint();
    let database = 'ok';
    let status = 200;

    try {
      await sequelize.query('SELECT 1');
    } catch {
      database = 'unreachable';
      status = 503;
    }

    res.status(status).json({
      status: status === 200 ? 'ok' : 'degraded',
      database,
      dbLatencyMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e5) / 10,
      uptimeSeconds: Math.round(process.uptime()),
    });
  }),
);

export default router;
