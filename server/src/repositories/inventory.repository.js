import { QueryTypes } from 'sequelize';
import { sequelize } from '../db/sequelize.js';

/**
 * Per-outlet stock.
 * @see ./README.md for the repository layer contract.
 */

export async function findByOutlet(outletId, { transaction } = {}) {
  return sequelize.query(
    `
    SELECT inv.menu_item_id AS "menuItemId",
           mi.sku           AS "sku",
           mi.name          AS "name",
           mi.category      AS "category",
           inv.quantity     AS "quantity",
           inv.updated_at   AS "updatedAt"
      FROM inventory inv
      JOIN menu_items mi ON mi.id = inv.menu_item_id
     WHERE inv.outlet_id = $1
     ORDER BY mi.category ASC, mi.name ASC
    `,
    { bind: [outletId], type: QueryTypes.SELECT, transaction },
  );
}

export async function findOne(outletId, menuItemId, { transaction } = {}) {
  const [row] = await sequelize.query(
    `SELECT outlet_id AS "outletId", menu_item_id AS "menuItemId", quantity
       FROM inventory
      WHERE outlet_id = $1 AND menu_item_id = $2`,
    { bind: [outletId, menuItemId], type: QueryTypes.SELECT, transaction },
  );
  return row ?? null;
}

/**
 * Creates the stock row for a newly assigned item if it does not exist.
 *
 * Assigning an item to an outlet and the outlet having a stock record for it
 * are the same event, so this runs in the assignment transaction. ON CONFLICT
 * DO NOTHING makes re-assigning a previously carried item preserve its
 * existing stock rather than silently zeroing it.
 */
export async function ensureRow(outletId, menuItemId, { transaction }) {
  if (!transaction) throw new Error('ensureRow requires a transaction');

  await sequelize.query(
    `INSERT INTO inventory (outlet_id, menu_item_id, quantity)
     VALUES ($1, $2, 0)
     ON CONFLICT (outlet_id, menu_item_id) DO NOTHING`,
    { bind: [outletId, menuItemId], type: QueryTypes.INSERT, transaction },
  );
}

/**
 * Applies a signed stock change: restocking (positive) or a correction
 * (negative).
 *
 * The `quantity + $3 >= 0` guard means a correction can never drive stock
 * negative, and the caller distinguishes "no such row" from "not enough
 * stock" by checking whether a row came back.
 */
export async function adjust(outletId, menuItemId, delta, { transaction }) {
  if (!transaction) throw new Error('adjust requires a transaction');

  const rows = await sequelize.query(
    `UPDATE inventory
        SET quantity = quantity + $3,
            updated_at = now()
      WHERE outlet_id = $1
        AND menu_item_id = $2
        AND quantity + $3 >= 0
      RETURNING quantity AS "quantity"`,
    { bind: [outletId, menuItemId, delta], type: QueryTypes.SELECT, transaction },
  );
  return rows[0] ?? null;
}

export async function removeRow(outletId, menuItemId, { transaction }) {
  if (!transaction) throw new Error('removeRow requires a transaction');

  const rows = await sequelize.query(
    `DELETE FROM inventory
      WHERE outlet_id = $1 AND menu_item_id = $2
      RETURNING quantity AS "quantity"`,
    { bind: [outletId, menuItemId], type: QueryTypes.SELECT, transaction },
  );
  return rows[0] ?? null;
}
