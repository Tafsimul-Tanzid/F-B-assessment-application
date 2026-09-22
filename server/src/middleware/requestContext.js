import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';

/**
 * Tags every request with an id, echoes it back in a header, and logs a single
 * line per completed request. The id also goes into every error body so a user
 * reporting a failure gives you something greppable.
 */
export function requestContext(req, res, next) {
  req.id = req.get('x-request-id') ?? randomUUID();
  res.set('x-request-id', req.id);

  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logger.info('request', {
      requestId: req.id,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
      userId: req.user?.id,
    });
  });

  next();
}
