import { sequelize } from '../db/sequelize.js';
import { ConflictError, NotFoundError } from '../errors/index.js';
import * as outletMenuRepository from '../repositories/outletMenu.repository.js';
import * as inventoryRepository from '../repositories/inventory.repository.js';
import * as menuItemRepository from '../repositories/menuItem.repository.js';
import { assertOutletExists } from './outlet.service.js';

/**
 * Assignment of master menu items to outlets (HQ), and the outlet's view of
 * its own menu.
 */

/**
 * HQ view: everything assigned to this outlet, including items currently
 * switched off, so HQ can see and re-enable them.
 */
export async function listAssignments(outletId) {
  await assertOutletExists(outletId);
  return outletMenuRepository.findOutletMenu(outletId, { availableOnly: false });
}

/**
 * Outlet view: only what this outlet may actually sell right now.
 *
 * `outletId` comes from the caller's JWT claim, never from the request path,
 * so this cannot be pointed at another outlet.
 */
export async function listMenuForOutlet(outletId) {
  return outletMenuRepository.findOutletMenu(outletId, { availableOnly: true });
}

/**
 * Assigning an item to an outlet also creates its stock row (at zero) in the
 * same transaction. The two are one event: an assigned item with no inventory
 * record would fail every sale with a confusing "not stocked" error.
 */
export async function assignMenuItem(outletId, { menuItemId, priceOverride, isAvailable = true }) {
  return sequelize.transaction(async (transaction) => {
    await assertOutletExists(outletId, { transaction });

    const menuItem = await menuItemRepository.findById(menuItemId, { transaction });
    if (!menuItem) throw new NotFoundError('Menu item');

    const existing = await outletMenuRepository.findAssignment(outletId, menuItemId, { transaction });
    if (existing) {
      throw new ConflictError(
        `"${menuItem.name}" is already assigned to this outlet`,
        'ALREADY_ASSIGNED',
      );
    }

    const assignment = await outletMenuRepository.assign(
      { outletId, menuItemId, priceOverride: priceOverride ?? null, isAvailable },
      { transaction },
    );

    // ON CONFLICT DO NOTHING inside: re-assigning a previously carried item
    // keeps whatever stock it still had rather than zeroing it.
    await inventoryRepository.ensureRow(outletId, menuItemId, { transaction });

    return assignment;
  });
}

/**
 * Change the per-outlet price override or availability.
 *
 * `priceOverride: null` is meaningful — it clears the override so the outlet
 * falls back to the master base price. It is therefore distinguished from the
 * field being absent, which leaves the override untouched.
 */
export async function updateAssignment(outletId, menuItemId, data) {
  const patch = {};
  if ('priceOverride' in data) patch.priceOverride = data.priceOverride;
  if ('isAvailable' in data) patch.isAvailable = data.isAvailable;

  const updated = await outletMenuRepository.updateAssignment(outletId, menuItemId, patch);
  if (!updated) throw new NotFoundError('Menu assignment');
  return updated;
}

/**
 * Unassign an item from an outlet.
 *
 * The stock row is removed with it, but only if the outlet holds none: losing
 * a positive stock count silently would hide real inventory. Past sales are
 * unaffected, because sale_items snapshot their own data and do not depend on
 * the assignment still existing.
 */
export async function unassignMenuItem(outletId, menuItemId) {
  return sequelize.transaction(async (transaction) => {
    const assignment = await outletMenuRepository.findAssignment(outletId, menuItemId, { transaction });
    if (!assignment) throw new NotFoundError('Menu assignment');

    const stock = await inventoryRepository.findOne(outletId, menuItemId, { transaction });
    if (stock && Number(stock.quantity) > 0) {
      throw new ConflictError(
        `Cannot unassign: the outlet still holds ${stock.quantity} in stock. Adjust stock to zero first.`,
        'STOCK_REMAINING',
        { quantity: stock.quantity },
      );
    }

    await inventoryRepository.removeRow(outletId, menuItemId, { transaction });
    await outletMenuRepository.unassign(outletId, menuItemId, { transaction });

    return { outletId, menuItemId, unassigned: true };
  });
}
