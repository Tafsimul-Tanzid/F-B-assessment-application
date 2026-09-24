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

/**
 * Deducts stock for one line of a sale. This is the write that must never
 * produce a negative balance.
 *
 * The `quantity >= $3` guard lives in the WHERE clause rather than in a
 * read-then-write in JavaScript, and that placement is the whole mechanism:
 *
 *   - If a concurrent transaction holds the row lock, this UPDATE blocks. When
 *     the other transaction commits, Postgres does NOT proceed from this
 *     transaction's original snapshot — it re-reads the newly committed row
 *     and re-evaluates the entire WHERE clause against it, guard included
 *     (EvalPlanQual). The check is therefore always made against the latest
 *     committed quantity, so a lost update is impossible.
 *   - Doing the comparison in JS would be wrong twice over: it would race, and
 *     `numeric` arrives as a string, where "9" >= "10" is true.
 *
 * Returns the remaining quantity, or null when the guard rejected the update —
 * which the caller disambiguates, because null also covers "no such row".
 */
export async function deduct(outletId, menuItemId, qty, { transaction }) {
  if (!transaction) throw new Error('deduct requires a transaction');

  const rows = await sequelize.query(
    `UPDATE inventory
        SET quantity = quantity - $3,
            updated_at = now()
      WHERE outlet_id = $1
        AND menu_item_id = $2
        AND quantity >= $3
      RETURNING quantity AS "remaining"`,
    { bind: [outletId, menuItemId, qty], type: QueryTypes.SELECT, transaction },
  );

  // RETURNING is used rather than the driver's row count because the shape of
  // Sequelize's raw-query metadata is dialect-specific.
  return rows[0] ?? null;
}

/**
 * Returns stock to the shelf when a sale is voided.
 *
 * No guard predicate here, unlike deduct(): this only ever increases the
 * quantity, so it cannot violate the non-negative constraint and has nothing
 * to lose a race against. The row is still locked for the rest of the
 * transaction, which is what serialises it against a concurrent sale of the
 * same item.
 */
export async function restore(outletId, menuItemId, qty, { transaction }) {
  if (!transaction) throw new Error('restore requires a transaction');

  const rows = await sequelize.query(
    `UPDATE inventory
        SET quantity = quantity + $3,
            updated_at = now()
      WHERE outlet_id = $1
        AND menu_item_id = $2
      RETURNING quantity AS "remaining"`,
    { bind: [outletId, menuItemId, qty], type: QueryTypes.SELECT, transaction },
  );

  // Null means the item has since been unassigned from the outlet, so there is
  // no row to credit the stock back to. The caller decides whether that is
  // fatal; the money side of the void must still go through.
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
