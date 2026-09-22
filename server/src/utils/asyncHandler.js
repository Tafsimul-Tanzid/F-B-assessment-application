/**
 * Express 4 does not catch rejected promises from async handlers — an
 * unhandled rejection there hangs the request instead of reaching the error
 * middleware. Every async route handler is wrapped in this.
 */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

export default asyncHandler;
