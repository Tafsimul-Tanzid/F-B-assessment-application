import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

import { config } from '../config/index.js';
import { UnauthorizedError } from '../errors/index.js';
import * as userRepository from '../repositories/user.repository.js';

function toPublicUser(user) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    outletId: user.outletId,
    outlet: user.outlet ? { id: user.outlet.id, code: user.outlet.code, name: user.outlet.name } : null,
  };
}

function issueToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
      // Outlet staff carry their outlet in the token. Outlet-scoped routes
      // read the scope from here and from nowhere else.
      outletId: user.outletId ?? null,
    },
    config.auth.jwtSecret,
    { expiresIn: config.auth.jwtExpiresIn },
  );
}

export async function login({ email, password }) {
  const user = await userRepository.findByEmailWithPassword(email);

  // One generic message whether the email is unknown, the password is wrong,
  // or the account is disabled — distinguishing them tells an attacker which
  // addresses are registered.
  const invalid = new UnauthorizedError('Invalid email or password');

  if (!user || !user.isActive) {
    // Still spend the hashing time on an unknown address, so response timing
    // does not reveal whether the account exists.
    await bcrypt.compare(password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
    throw invalid;
  }

  const matches = await bcrypt.compare(password, user.passwordHash);
  if (!matches) throw invalid;

  return { token: issueToken(user), user: toPublicUser(user) };
}

export async function getCurrentUser(userId) {
  const user = await userRepository.findById(userId);
  if (!user || !user.isActive) throw new UnauthorizedError('Account is no longer active');
  return toPublicUser(user);
}
