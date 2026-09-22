import {
  AppError,
  ConflictError,
  LockTimeoutError,
  RetryableError,
  UnprocessableError,
} from '../errors/index.js';
import { logger } from '../utils/logger.js';

/**
 * PostgreSQL SQLSTATE codes we care about.
 * https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
export const SQLSTATE = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  NOT_NULL_VIOLATION: '23502',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
  LOCK_NOT_AVAILABLE: '55P03',
};

/**
 * Sequelize wraps the driver error differently depending on which path threw,
 * so the SQLSTATE can be on `.original` or `.parent`.
 */
function driverError(err) {
  return err?.original ?? err?.parent ?? err;
}

export function isRetryableDbError(err) {
  const code = driverError(err)?.code;
  return code === SQLSTATE.SERIALIZATION_FAILURE || code === SQLSTATE.DEADLOCK_DETECTED;
}

/**
 * Translate a database error into a typed application error.
 *
 * Anything we do not recognise is returned unchanged, so it reaches the error
 * middleware as an unexpected error and gets logged with its stack.
 */
export function mapDbError(err) {
  if (err instanceof AppError) return err;

  const driver = driverError(err);
  const { code, constraint, detail } = driver ?? {};

  switch (code) {
    case SQLSTATE.CHECK_VIOLATION:
      if (constraint === 'inventory_quantity_non_negative') {
        // The guard predicate in the stock UPDATE should have caught this
        // first. Reaching the CHECK means some write path bypassed the guard,
        // which is a bug worth an alert, not a routine 409.
        logger.error('Negative stock CHECK constraint fired — a write path bypassed the stock guard', {
          constraint,
          detail,
        });
        return new ConflictError(
          'Stock level would go negative',
          'INSUFFICIENT_STOCK',
        );
      }
      return new UnprocessableError(
        'A value in the request violates a database constraint',
        'CHECK_VIOLATION',
        { constraint },
      );

    case SQLSTATE.UNIQUE_VIOLATION:
      if (constraint === 'sales_outlet_id_receipt_no_key') {
        // Must never happen: receipt numbers come from a locked counter row.
        // If it does, the counter and the sales table have diverged.
        logger.error('Receipt number collision — counter and sales table have diverged', {
          constraint,
          detail,
        });
        return new ConflictError('Receipt number collision', 'RECEIPT_COLLISION');
      }
      return new ConflictError(
        'A record with these values already exists',
        'DUPLICATE',
        { constraint },
      );

    case SQLSTATE.FOREIGN_KEY_VIOLATION:
      return new UnprocessableError(
        'A referenced record does not exist',
        'REFERENCE_NOT_FOUND',
        { constraint },
      );

    case SQLSTATE.NOT_NULL_VIOLATION:
      return new UnprocessableError(
        'A required value was missing',
        'MISSING_VALUE',
        { column: driver?.column },
      );

    case SQLSTATE.SERIALIZATION_FAILURE:
    case SQLSTATE.DEADLOCK_DETECTED:
      return new RetryableError(undefined, err);

    case SQLSTATE.LOCK_NOT_AVAILABLE:
      return new LockTimeoutError(err);

    default:
      return err;
  }
}
