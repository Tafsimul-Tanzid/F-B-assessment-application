/**
 * Application error hierarchy.
 *
 * Services and repositories throw these; the error middleware is the only
 * place that turns them into an HTTP response. Controllers never inspect a
 * SQLSTATE or build an error body themselves.
 */
export class AppError extends Error {
  /**
   * @param {string} message  safe to show the client
   * @param {number} status   HTTP status
   * @param {string} code     stable machine-readable code for the frontend
   * @param {object} [details] extra context (field errors, stock levels, ...)
   */
  constructor(message, status, code, details) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
    // Expected errors are not bugs; the middleware uses this to decide whether
    // to log at warn or error, and whether to include a stack trace.
    this.expected = true;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(details, message = 'Request validation failed') {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have access to this resource') {
    super(message, 403, 'FORBIDDEN');
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404, 'NOT_FOUND');
  }
}

export class ConflictError extends AppError {
  constructor(message, code = 'CONFLICT', details) {
    super(message, 409, code, details);
  }
}

/**
 * The outlet has the item in stock but not enough of it. 409 rather than 400:
 * the request was well-formed, it lost a race against the current stock level.
 */
export class InsufficientStockError extends ConflictError {
  constructor({ menuItemId, itemName, requested, available }) {
    super(
      `Insufficient stock for "${itemName ?? menuItemId}": requested ${requested}, available ${available}`,
      'INSUFFICIENT_STOCK',
      { menuItemId, itemName, requested, available },
    );
  }
}

/**
 * The item is on the outlet's menu but has no inventory row at all, which is a
 * provisioning gap rather than a stock shortage — hence 422, not 409.
 */
export class ItemNotStockedError extends AppError {
  constructor({ menuItemId, itemName }) {
    super(
      `"${itemName ?? menuItemId}" has no inventory record at this outlet`,
      422,
      'ITEM_NOT_STOCKED',
      { menuItemId, itemName },
    );
  }
}

export class UnprocessableError extends AppError {
  constructor(message, code = 'UNPROCESSABLE', details) {
    super(message, 422, code, details);
  }
}

/**
 * Postgres reported a deadlock or serialization failure. The work is sound but
 * lost a race; the caller may retry the whole transaction.
 */
export class RetryableError extends AppError {
  constructor(message = 'Transaction conflicted with a concurrent request', cause) {
    super(message, 503, 'RETRYABLE');
    this.cause = cause;
  }
}

export class LockTimeoutError extends AppError {
  constructor(cause) {
    super('The request timed out waiting for a database lock', 503, 'LOCK_TIMEOUT');
    this.cause = cause;
  }
}
