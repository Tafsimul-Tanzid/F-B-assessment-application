import { Company, Outlet, OutletCreditNoteCounter, OutletReceiptCounter } from '../db/models/index.js';

/**
 * @see ./README.md for the repository layer contract.
 */

/**
 * Returns the single company every outlet belongs to, creating it on first
 * use. The scenario is explicitly "a single company," so there is exactly one
 * row here; this exists as a lookup rather than a hardcoded id so seeding and
 * the migration's own backfill both stay the single source of truth for its
 * name.
 */
export async function getOrCreateDefaultCompany({ transaction } = {}) {
  const [company] = await Company.findOrCreate({
    where: {},
    defaults: { name: 'Demo F&B Company' },
    transaction,
  });
  return company;
}

export async function findAll({ transaction } = {}) {
  return Outlet.findAll({ order: [['code', 'ASC']], include: [{ model: Company, as: 'company' }], transaction });
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
