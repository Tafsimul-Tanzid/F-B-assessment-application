import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { ForbiddenError, UnauthorizedError } from '../errors/index.js';

export const ROLES = Object.freeze({
  HQ_ADMIN: 'HQ_ADMIN',
  OUTLET_STAFF: 'OUTLET_STAFF',
});

/**
 * Verifies the bearer token and attaches `req.user`.
 *
 * The token carries the user's role and, for outlet staff, their outlet id.
 * That claim is the ONLY source of an outlet scope on outlet routes — see
 * `outletScope` below.
 */
export function authenticate(req, _res, next) {
  const header = req.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(new UnauthorizedError('Missing bearer token'));
  }

  try {
    const payload = jwt.verify(token, config.auth.jwtSecret);
    req.user = {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      outletId: payload.outletId ?? null,
    };
    return next();
  } catch (error) {
    const message =
      error.name === 'TokenExpiredError' ? 'Session expired, please log in again' : 'Invalid token';
    return next(new UnauthorizedError(message));
  }
}

/**
 * Restricts a route to specific roles. Always used after `authenticate`.
 */
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(new UnauthorizedError());
    if (!roles.includes(req.user.role)) {
      return next(new ForbiddenError(`This endpoint requires role: ${roles.join(' or ')}`));
    }
    return next();
  };
}

/**
 * Resolves the outlet an outlet-scoped request acts on, and puts it on
 * `req.outletId`.
 *
 * The id comes from the JWT, never from the path, query or body. This is what
 * makes "an outlet can retrieve only the menu items assigned to it" a property
 * of the system rather than a convention the client is trusted to follow: an
 * outlet route has no parameter through which another outlet's id could be
 * supplied in the first place.
 */
export function outletScope(req, _res, next) {
  if (!req.user) return next(new UnauthorizedError());

  if (req.user.role !== ROLES.OUTLET_STAFF || !req.user.outletId) {
    return next(new ForbiddenError('This endpoint is only available to outlet staff'));
  }

  req.outletId = req.user.outletId;
  return next();
}
