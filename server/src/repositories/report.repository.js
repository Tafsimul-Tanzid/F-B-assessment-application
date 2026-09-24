import { QueryTypes } from 'sequelize';
import { sequelize } from '../db/sequelize.js';

/**
 * Reporting queries.
 *
 * Both are raw SQL. They read only snapshotted columns on sales/sale_items and
 * never join the live menu, so a later price change or unassignment cannot
 * restate historical revenue.
 *
 * @see ./README.md for the repository layer contract.
 */

/**
 * Total revenue per outlet.
 *
 * Two details that are easy to get wrong and produce plausible-looking wrong
 * numbers rather than an error:
 *
 *  - The date predicates sit in the LEFT JOIN's ON clause, not in WHERE. In
 *    WHERE they would filter out the NULL-extended rows and silently turn the
 *    LEFT JOIN back into an inner join, dropping every outlet that sold
 *    nothing in the period — exactly the outlets a manager is looking for.
 *  - COUNT(s.id), not COUNT(*): COUNT(*) counts the NULL-extended row and
 *    reports 1 sale for an outlet that made none.
 *
 * Served by sales (outlet_id, sold_at) INCLUDE (total_amount) as an index-only
 * scan.
 */
export async function revenueByOutlet({ from, to }, { transaction } = {}) {
  return sequelize.query(
    `
    SELECT o.id                                     AS "outletId",
           o.code                                   AS "outletCode",
           o.name                                   AS "outletName",
           COALESCE(SUM(s.total_amount), 0)         AS "revenue",
           COUNT(s.id)                              AS "saleCount",
           COALESCE(ROUND(AVG(s.total_amount), 2), 0) AS "averageSale",
           COALESCE(SUM(s.item_count), 0)           AS "itemsSold"
      FROM outlets o
      LEFT JOIN sales s
             ON s.outlet_id = o.id
            -- Voided sales are excluded everywhere. Without this they would
            -- inflate revenue with money that was handed back.
            AND s.status = 'completed'
            AND ($1::timestamptz IS NULL OR s.sold_at >= $1)
            AND ($2::timestamptz IS NULL OR s.sold_at <  $2)
     GROUP BY o.id, o.code, o.name
     ORDER BY "revenue" DESC, o.code ASC
    `,
    { bind: [from ?? null, to ?? null], type: QueryTypes.SELECT, transaction },
  );
}

/**
 * Top N selling items for each outlet, ranked by units sold.
 *
 * Grouped by menu_item_id rather than by the snapshotted item_name: grouping
 * by name would split one item into two rows the moment HQ renames it, and
 * would merge two distinct items that happen to share a name. The name shown
 * is the most recent snapshot for that id.
 *
 * The window's ORDER BY carries menu_item_id as a tiebreak so the ranking is
 * stable across runs when two items tie on units.
 */
export async function topItemsByOutlet({ from, to, limit = 5 }, { transaction } = {}) {
  return sequelize.query(
    `
    WITH item_totals AS (
      SELECT s.outlet_id                          AS outlet_id,
             si.menu_item_id                      AS menu_item_id,
             SUM(si.quantity)                     AS units_sold,
             SUM(si.line_total)                   AS revenue,
             COUNT(DISTINCT si.sale_id)           AS appeared_in_sales,
             (ARRAY_AGG(si.item_name ORDER BY s.sold_at DESC))[1] AS item_name
        FROM sales s
        JOIN sale_items si ON si.sale_id = s.id
       WHERE s.status = 'completed'
         AND ($1::timestamptz IS NULL OR s.sold_at >= $1)
         AND ($2::timestamptz IS NULL OR s.sold_at <  $2)
       GROUP BY s.outlet_id, si.menu_item_id
    ),
    ranked AS (
      SELECT item_totals.*,
             ROW_NUMBER() OVER (
               PARTITION BY outlet_id
               ORDER BY units_sold DESC, menu_item_id ASC
             ) AS rank
        FROM item_totals
    )
    SELECT o.id                  AS "outletId",
           o.code                AS "outletCode",
           o.name                AS "outletName",
           r.menu_item_id        AS "menuItemId",
           r.item_name           AS "itemName",
           r.units_sold          AS "unitsSold",
           r.revenue             AS "revenue",
           r.appeared_in_sales   AS "saleCount",
           r.rank                AS "rank"
      FROM ranked r
      JOIN outlets o ON o.id = r.outlet_id
     WHERE r.rank <= $3
     ORDER BY o.code ASC, r.rank ASC
    `,
    { bind: [from ?? null, to ?? null, limit], type: QueryTypes.SELECT, transaction },
  );
}
