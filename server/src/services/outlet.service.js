import { sequelize } from '../db/sequelize.js';
import { ConflictError, NotFoundError } from '../errors/index.js';
import * as outletRepository from '../repositories/outlet.repository.js';

export async function listOutlets() {
  return outletRepository.findAll();
}

export async function getOutlet(id) {
  const outlet = await outletRepository.findById(id);
  if (!outlet) throw new NotFoundError('Outlet');
  return outlet;
}

/**
 * Creating an outlet also creates its receipt counter row, in one
 * transaction. An outlet without a counter row cannot sell, so the two must
 * not be able to exist apart.
 */
export async function createOutlet(data) {
  const existing = await sequelize.transaction(async (transaction) => {
    const outlet = await outletRepository.create(data, { transaction });
    await outletRepository.createReceiptCounter(outlet.id, { transaction });
    return outlet;
  }).catch((error) => {
    if (error?.original?.constraint === 'outlets_code_key') {
      throw new ConflictError(`An outlet with code "${data.code}" already exists`, 'DUPLICATE_CODE');
    }
    throw error;
  });

  return existing;
}

/**
 * Asserts the outlet exists. Used by HQ routes that take an outlet id in the
 * path, so a bad id fails with 404 rather than an empty result set that looks
 * like an outlet with nothing assigned.
 */
export async function assertOutletExists(id, { transaction } = {}) {
  const outlet = await outletRepository.findById(id, { transaction });
  if (!outlet) throw new NotFoundError('Outlet');
  return outlet;
}
