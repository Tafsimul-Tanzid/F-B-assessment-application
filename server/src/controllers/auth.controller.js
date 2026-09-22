import * as authService from '../services/auth.service.js';

/**
 * Controllers translate HTTP to a service call and back. No business rules,
 * no database access, no error formatting — errors propagate to the error
 * middleware via asyncHandler.
 */

export async function login(req, res) {
  const result = await authService.login(req.validated.body);
  res.json(result);
}

export async function me(req, res) {
  const user = await authService.getCurrentUser(req.user.id);
  res.json({ user });
}
