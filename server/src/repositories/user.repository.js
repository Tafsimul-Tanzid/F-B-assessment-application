import { User, Outlet } from '../db/models/index.js';

/**
 * @see ./README.md for the repository layer contract.
 */

/**
 * Looks a user up for login. Uses the `withPassword` scope because the default
 * scope excludes the hash — the service needs it here and nowhere else.
 */
export async function findByEmailWithPassword(email, { transaction } = {}) {
  return User.scope('withPassword').findOne({
    where: { email },
    include: [{ model: Outlet, as: 'outlet', attributes: ['id', 'code', 'name'], required: false }],
    transaction,
  });
}

export async function findById(id, { transaction } = {}) {
  return User.findByPk(id, {
    include: [{ model: Outlet, as: 'outlet', attributes: ['id', 'code', 'name'], required: false }],
    transaction,
  });
}
