import { ConflictError, NotFoundError } from '../errors/index.js';
import * as menuItemRepository from '../repositories/menuItem.repository.js';

/**
 * The master menu. HQ owns it; outlets never write here.
 */

export async function listMenuItems(filters) {
  return menuItemRepository.findAll(filters);
}

export async function getMenuItem(id) {
  const item = await menuItemRepository.findById(id);
  if (!item) throw new NotFoundError('Menu item');
  return item;
}

export async function createMenuItem(data) {
  try {
    return await menuItemRepository.create(data);
  } catch (error) {
    if (error?.original?.constraint === 'menu_items_sku_key') {
      throw new ConflictError(`A menu item with SKU "${data.sku}" already exists`, 'DUPLICATE_SKU');
    }
    throw error;
  }
}

/**
 * Updating a master item changes the price outlets inherit from now on. It
 * does NOT change any sale already recorded: sale_items snapshot the name and
 * price at the time of sale, so historical receipts and revenue are unaffected.
 */
export async function updateMenuItem(id, data) {
  const updated = await menuItemRepository.update(id, data);
  if (!updated) throw new NotFoundError('Menu item');
  return updated;
}

/**
 * Deactivation rather than deletion.
 *
 * Beyond keeping historical references intact, a hard DELETE would take a
 * FOR UPDATE lock on the menu_items row, which conflicts with the FOR KEY
 * SHARE lock that every concurrent INSERT INTO sale_items takes on it. One HQ
 * delete would therefore block — and could deadlock against — in-flight sales
 * of that item across every outlet.
 */
export async function deactivateMenuItem(id) {
  const updated = await menuItemRepository.update(id, { isActive: false });
  if (!updated) throw new NotFoundError('Menu item');
  return updated;
}
