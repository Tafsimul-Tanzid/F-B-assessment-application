import { QueryTypes } from 'sequelize';
import { sequelize } from '../db/sequelize.js';

/**
 * Sales and their line items.
 * @see ./README.md for the repository layer contract.
 */

/**
 * Allocates this outlet's next receipt number and inserts the sale, in one
 * statement.
 *
 * ── Receipt numbering ─────────────────────────────────────────────────────
 * A Postgres SEQUENCE is not usable here: sequences are global rather than
 * per-outlet, and they are gappy by design (a rolled-back transaction never
 * returns its number). Instead each outlet owns a counter row, and
 * `UPDATE ... SET n = n + 1 ... RETURNING` both increments and reads it
 * atomically. The UPDATE takes a row lock, so concurrent sales at the same
 * outlet queue behind it and each receives a distinct, consecutive number.
 *
 * ── Why this runs LAST in the transaction ─────────────────────────────────
 * Postgres holds row locks until commit, so whenever the counter is bumped it
 * stays locked for the remainder of the transaction. Bumping it first would
 * make it a per-outlet global mutex held across every stock update and every
 * network round trip, and would burn a receipt number on every validation
 * failure. Bumping it here — after stock has already been deducted — holds it
 * only across this insert, the line-item insert and the commit.
 *
 * The cost of that choice is that lock acquisition order becomes load-bearing:
 * every sale takes inventory row locks BEFORE the counter lock. This function
 * is the only place the counter is touched, and sale.service.js is its only
 * caller, precisely so that order cannot be violated from somewhere else.
 *
 * ── Gaps ──────────────────────────────────────────────────────────────────
 * No in-transaction scheme can be strictly gapless: the number must be
 * allocated before COMMIT, and COMMIT can still fail. Allocating last confines
 * gaps to infrastructure failures after all validation has passed.
 */
export async function insertSaleWithReceipt({ outletId, cashierId, lines }, { transaction }) {
  if (!transaction) throw new Error('insertSaleWithReceipt requires a transaction');

  const rows = await sequelize.query(
    `
    WITH lines AS (
      SELECT *
        FROM unnest($3::numeric[], $4::numeric[]) AS t(unit_price, quantity)
    ),
    totals AS (
      -- Each line is rounded to cents BEFORE summing, so the stored
      -- total_amount equals the sum of the stored line_total values exactly.
      -- Summing first and rounding once would leave the receipt off by a cent
      -- against its own lines.
      SELECT COALESCE(SUM(ROUND(unit_price * quantity, 2)), 0) AS total,
             COUNT(*)::int                                     AS item_count
        FROM lines
    ),
    next_receipt AS (
      UPDATE outlet_receipt_counters
         SET last_receipt_no = last_receipt_no + 1
       WHERE outlet_id = $1
      RETURNING last_receipt_no
    )
    INSERT INTO sales (outlet_id, receipt_no, total_amount, item_count, cashier_id)
    SELECT $1, next_receipt.last_receipt_no, totals.total, totals.item_count, $2
      FROM next_receipt, totals
    RETURNING id            AS "id",
              receipt_no    AS "receiptNo",
              total_amount  AS "totalAmount",
              item_count    AS "itemCount",
              sold_at       AS "soldAt"
    `,
    {
      bind: [
        outletId,
        cashierId,
        lines.map((l) => l.unitPrice),
        lines.map((l) => l.quantity),
      ],
      type: QueryTypes.SELECT,
      transaction,
    },
  );

  // No row means the counter row is missing, i.e. the outlet was created
  // without one. Outlet creation does both in a single transaction, so this
  // indicates data that was inserted around the application.
  return rows[0] ?? null;
}

/**
 * Inserts the line items.
 *
 * item_name and unit_price are snapshots taken at sale time, never a reference
 * to the live menu: a receipt is a financial record and must reprint
 * identically after HQ renames an item, reprices it, or unassigns it.
 *
 * line_total is computed here in `numeric` arithmetic — rounded per line, to
 * match how the header total was summed — rather than in JavaScript, where
 * floats would corrupt it.
 */
export async function insertSaleItems(saleId, lines, { transaction }) {
  if (!transaction) throw new Error('insertSaleItems requires a transaction');

  return sequelize.query(
    `
    INSERT INTO sale_items (sale_id, menu_item_id, item_name, unit_price, quantity, line_total)
    SELECT $1,
           t.menu_item_id,
           t.item_name,
           t.unit_price,
           t.quantity,
           ROUND(t.unit_price * t.quantity, 2)
      FROM unnest($2::uuid[], $3::text[], $4::numeric[], $5::numeric[])
        AS t(menu_item_id, item_name, unit_price, quantity)
    `,
    {
      bind: [
        saleId,
        lines.map((l) => l.menuItemId),
        lines.map((l) => l.itemName),
        lines.map((l) => l.unitPrice),
        lines.map((l) => l.quantity),
      ],
      type: QueryTypes.INSERT,
      transaction,
    },
  );
}

/**
 * One sale with its line items — used for receipt reprint.
 * Scoped by outlet so an outlet cannot fetch another outlet's receipt by id.
 */
export async function findByIdForOutlet(saleId, outletId, { transaction } = {}) {
  const [sale] = await sequelize.query(
    `
    SELECT s.id           AS "id",
           s.outlet_id    AS "outletId",
           o.code         AS "outletCode",
           o.name         AS "outletName",
           s.receipt_no   AS "receiptNo",
           s.total_amount AS "totalAmount",
           s.item_count   AS "itemCount",
           s.sold_at      AS "soldAt",
           u.full_name    AS "cashierName"
      FROM sales s
      JOIN outlets o ON o.id = s.outlet_id
      LEFT JOIN users u ON u.id = s.cashier_id
     WHERE s.id = $1 AND s.outlet_id = $2
    `,
    { bind: [saleId, outletId], type: QueryTypes.SELECT, transaction },
  );

  if (!sale) return null;

  sale.items = await sequelize.query(
    `SELECT menu_item_id AS "menuItemId",
            item_name    AS "itemName",
            unit_price   AS "unitPrice",
            quantity     AS "quantity",
            line_total   AS "lineTotal"
       FROM sale_items
      WHERE sale_id = $1
      ORDER BY item_name ASC`,
    { bind: [saleId], type: QueryTypes.SELECT, transaction },
  );

  return sale;
}

export async function findByOutlet(outletId, { from, to, limit = 50 } = {}, { transaction } = {}) {
  return sequelize.query(
    `
    SELECT s.id           AS "id",
           s.receipt_no   AS "receiptNo",
           s.total_amount AS "totalAmount",
           s.item_count   AS "itemCount",
           s.sold_at      AS "soldAt",
           u.full_name    AS "cashierName"
      FROM sales s
      LEFT JOIN users u ON u.id = s.cashier_id
     WHERE s.outlet_id = $1
       AND ($2::timestamptz IS NULL OR s.sold_at >= $2)
       AND ($3::timestamptz IS NULL OR s.sold_at < $3)
     ORDER BY s.receipt_no DESC
     LIMIT $4
    `,
    {
      bind: [outletId, from ?? null, to ?? null, limit],
      type: QueryTypes.SELECT,
      transaction,
    },
  );
}
