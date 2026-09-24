import { Outlet, OutletCreditNoteCounter, OutletReceiptCounter } from '../db/models/index.js';

/**
 * @see ./README.md for the repository layer contract.
 */

export async function findAll({ transaction } = {}) {
  return Outlet.findAll({ order: [['code', 'ASC']], transaction });
}

export async function findById(id, { transaction } = {}) {
  return Outlet.findByPk(id, { transaction });
}

export async function create(data, { transaction }) {
  return Outlet.create(data, { transaction });
}

/**
 * Every outlet needs its counter rows before it can sell or void.
 *
 * They are created here, in the same transaction as the outlet, rather than
 * lazily on first use: a lazy upsert would turn the counter bump from a plain
 * indexed update into a possible insert conflict on the hot path, and would
 * return no row on conflict, which the sale path would then have to
 * special-case.
 */
export async function createCounters(outletId, { transaction }) {
  await OutletReceiptCounter.create({ outletId, lastReceiptNo: 0 }, { transaction });
  await OutletCreditNoteCounter.create({ outletId, lastCreditNoteNo: 0 }, { transaction });
}
