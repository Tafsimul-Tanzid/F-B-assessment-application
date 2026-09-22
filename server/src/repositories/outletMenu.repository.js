import { QueryTypes } from 'sequelize';
import { sequelize } from '../db/sequelize.js';
import { OutletMenuItem } from '../db/models/index.js';

/**
 * HQ's assignment of master menu items to outlets, plus the outlet-facing
 * view of its own menu.
 *
 * @see ./README.md for the repository layer contract.
 */

/**
 * The outlet's menu: assigned items only, with the effective price resolved
 * and current stock attached.
 *
 * Raw SQL rather than an ORM include: the effective price is a COALESCE over
 * two tables and the stock comes from a third via a LEFT JOIN on a composite
 * key. Expressing that through associations produces a worse query and a
 * nested shape the controller would have to flatten anyway.
 */
export async function findOutletMenu(outletId, { availableOnly = false } = {}, { transaction } = {}) {
  return sequelize.query(
    `
    SELECT mi.id                                          AS "menuItemId",
           mi.sku                                         AS "sku",
           mi.name                                        AS "name",
           mi.category                                    AS "category",
           mi.base_price                                  AS "basePrice",
           omi.price_override                             AS "priceOverride",
           COALESCE(omi.price_override, mi.base_price)    AS "effectivePrice",
           omi.is_available                               AS "isAvailable",
           mi.is_active                                   AS "isActive",
           COALESCE(inv.quantity, 0)                      AS "stock"
      FROM outlet_menu_items omi
      JOIN menu_items mi
        ON mi.id = omi.menu_item_id
      LEFT JOIN inventory inv
        ON inv.outlet_id = omi.outlet_id
       AND inv.menu_item_id = omi.menu_item_id
     WHERE omi.outlet_id = $1
       AND ($2 = false OR (omi.is_available = true AND mi.is_active = true))
     ORDER BY mi.category ASC, mi.name ASC
    `,
    { bind: [outletId, availableOnly], type: QueryTypes.SELECT, transaction },
  );
}

/**
 * Resolves the price and name of specific items for one outlet, at sale time.
 *
 * Called inside the sale transaction. The client never supplies a price — it
 * is read here from the outlet's assignment, so a terminal holding a valid
 * token cannot sell at a price of its own choosing.
 */
export async function resolveForSale(outletId, menuItemIds, { transaction }) {
  if (!transaction) throw new Error('resolveForSale requires a transaction');

  return sequelize.query(
    `
    SELECT mi.id                                       AS "menuItemId",
           mi.name                                     AS "name",
           COALESCE(omi.price_override, mi.base_price) AS "unitPrice",
           omi.is_available                            AS "isAvailable",
           mi.is_active                                AS "isActive"
      FROM outlet_menu_items omi
      JOIN menu_items mi
        ON mi.id = omi.menu_item_id
     WHERE omi.outlet_id = $1
       AND omi.menu_item_id = ANY($2::uuid[])
    `,
    { bind: [outletId, menuItemIds], type: QueryTypes.SELECT, transaction },
  );
}

export async function findAssignment(outletId, menuItemId, { transaction } = {}) {
  return OutletMenuItem.findOne({ where: { outletId, menuItemId }, transaction });
}

export async function assign({ outletId, menuItemId, priceOverride, isAvailable }, { transaction }) {
  return OutletMenuItem.create(
    { outletId, menuItemId, priceOverride, isAvailable },
    { transaction },
  );
}

export async function updateAssignment(outletId, menuItemId, data, { transaction } = {}) {
  const [count, rows] = await OutletMenuItem.update(data, {
    where: { outletId, menuItemId },
    returning: true,
    transaction,
  });
  return count === 0 ? null : rows[0];
}

export async function unassign(outletId, menuItemId, { transaction } = {}) {
  return OutletMenuItem.destroy({ where: { outletId, menuItemId }, transaction });
}
