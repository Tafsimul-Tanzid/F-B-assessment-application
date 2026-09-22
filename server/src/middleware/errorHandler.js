import { AppError, NotFoundError } from '../errors/index.js';
import { mapDbError } from '../db/errors.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

/**
 * Terminal 404 for unmatched routes. Registered after all routers.
 */
export function notFoundHandler(req, _res, next) {
  next(new NotFoundError(`Route ${req.method} ${req.originalUrl}`));
}

/**
 * The single place an error becomes an HTTP response.
 *
 * Express 4 identifies an error handler by its arity, so `next` must stay in
 * the signature even though it is unused.
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  // A database error can reach here from a path that did not map it (for
  // example a plain model call outside a service). Map it here as a safety net
  // so the client never sees a raw driver message.
  const error = mapDbError(err);

  if (error instanceof AppError) {
    if (error.status >= 500) {
      logger.error(error.message, {
        code: error.code,
        requestId: req.id,
        path: req.originalUrl,
        stack: error.stack,
      });
    } else {
      logger.warn(error.message, {
        code: error.code,
        status: error.status,
        requestId: req.id,
        path: req.originalUrl,
      });
    }

    return res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details !== undefined ? { details: error.details } : {}),
        requestId: req.id,
      },
    });
  }

  // Unexpected: log everything, tell the client nothing beyond the request id.
  logger.error('Unhandled error', {
    message: error?.message,
    requestId: req.id,
    path: req.originalUrl,
    stack: error?.stack,
  });

  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      requestId: req.id,
      ...(config.isProduction ? {} : { debug: error?.message }),
    },
  });
}
