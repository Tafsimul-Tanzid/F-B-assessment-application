import { sequelize } from '../db/sequelize.js';
import { ConflictError, NotFoundError } from '../errors/index.js';
import * as inventoryRepository from '../repositories/inventory.repository.js';
import { assertOutletExists } from './outlet.service.js';

export async function listInventory(outletId) {
  return inventoryRepository.findByOutlet(outletId);
}

export async function listInventoryForHq(outletId) {
  await assertOutletExists(outletId);
  return inventoryRepository.findByOutlet(outletId);
}

/**
 * Restock or correct stock for one item.
 *
 * `delta` is signed: positive restocks, negative corrects downward. A negative
 * correction that would take the outlet below zero is rejected rather than
 * clamped — silently absorbing it would hide a counting error.
 */
export async function adjustStock(outletId, menuItemId, delta) {
  return sequelize.transaction(async (transaction) => {
    const current = await inventoryRepository.findOne(outletId, menuItemId, { transaction });
    if (!current) {
      throw new NotFoundError('Inventory record (is the item assigned to this outlet?)');
    }

    const updated = await inventoryRepository.adjust(outletId, menuItemId, delta, { transaction });

    // No row back means the guard rejected it: the only way that happens is a
    // negative delta larger than what is on hand.
    if (!updated) {
      throw new ConflictError(
        `Adjustment of ${delta} would take stock below zero (current: ${current.quantity})`,
        'INSUFFICIENT_STOCK',
        { menuItemId, requested: delta, available: current.quantity },
      );
    }

    return { outletId, menuItemId, quantity: updated.quantity };
  });
}
