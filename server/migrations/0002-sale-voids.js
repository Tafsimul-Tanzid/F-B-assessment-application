/**
 * Voiding a sale.
 *
 * A sale is a financial record, so voiding does not delete it and does not
 * free its receipt number. The original row is kept and marked, and the void
 * is itself numbered from a separate per-outlet credit-note sequence — so the
 * books show both the sale that happened and the correction that followed.
 */

export async function up({ context: queryInterface }) {
  const sql = queryInterface.sequelize;

  await sql.query(`
    ------------------------------------------------------------------------
    -- Void state on the original sale
    ------------------------------------------------------------------------
    ALTER TABLE sales
      ADD COLUMN status         text NOT NULL DEFAULT 'completed',
      ADD COLUMN voided_at      timestamptz,
      ADD COLUMN voided_by      uuid,
      ADD COLUMN void_reason    text,
      -- Numbered from its own per-outlet sequence, never from the receipt
      -- sequence: reusing or continuing receipt numbers would make the two
      -- kinds of document indistinguishable in an audit.
      ADD COLUMN credit_note_no bigint;

    ALTER TABLE sales
      ADD CONSTRAINT sales_status_check
        CHECK (status IN ('completed', 'voided')),

      ADD CONSTRAINT sales_voided_by_fkey
        FOREIGN KEY (voided_by) REFERENCES users (id) ON DELETE SET NULL,

      -- The void fields travel together or not at all. Without this, a partial
      -- update could leave a sale marked voided with no credit note, or a
      -- credit note attached to a sale still counted as revenue.
      ADD CONSTRAINT sales_void_fields_consistent
        CHECK (
          (status = 'voided') =
          (voided_at IS NOT NULL AND credit_note_no IS NOT NULL)
        ),

      ADD CONSTRAINT sales_credit_note_no_check
        CHECK (credit_note_no IS NULL OR credit_note_no > 0),

      -- Unique per outlet, like receipt numbers. NULL values do not collide in
      -- a Postgres unique index, so completed sales are unaffected.
      ADD CONSTRAINT sales_outlet_id_credit_note_no_key
        UNIQUE (outlet_id, credit_note_no);

    ------------------------------------------------------------------------
    -- Per-outlet credit note counters
    ------------------------------------------------------------------------
    CREATE TABLE outlet_credit_note_counters (
      outlet_id           uuid   PRIMARY KEY,
      last_credit_note_no bigint NOT NULL DEFAULT 0,

      CONSTRAINT outlet_credit_note_counters_outlet_id_fkey
        FOREIGN KEY (outlet_id) REFERENCES outlets (id) ON DELETE CASCADE,
      CONSTRAINT outlet_credit_note_counters_non_negative
        CHECK (last_credit_note_no >= 0)
    );

    -- Backfill for outlets that already exist.
    INSERT INTO outlet_credit_note_counters (outlet_id)
    SELECT id FROM outlets
    ON CONFLICT (outlet_id) DO NOTHING;

    ------------------------------------------------------------------------
    -- Reporting index becomes partial
    ------------------------------------------------------------------------
    -- Every report counts completed sales only, so voided rows are dead weight
    -- in the index. Making it partial keeps the index smaller than the table
    -- it serves and lets the planner use it for exactly the queries that ask
    -- the same question.
    DROP INDEX IF EXISTS sales_outlet_id_sold_at_idx;

    CREATE INDEX sales_outlet_id_sold_at_completed_idx
      ON sales (outlet_id, sold_at) INCLUDE (total_amount)
      WHERE status = 'completed';
  `);
}

export async function down({ context: queryInterface }) {
  const sql = queryInterface.sequelize;
  await sql.query(`
    DROP INDEX IF EXISTS sales_outlet_id_sold_at_completed_idx;

    CREATE INDEX sales_outlet_id_sold_at_idx
      ON sales (outlet_id, sold_at) INCLUDE (total_amount);

    DROP TABLE IF EXISTS outlet_credit_note_counters;

    ALTER TABLE sales
      DROP CONSTRAINT IF EXISTS sales_outlet_id_credit_note_no_key,
      DROP CONSTRAINT IF EXISTS sales_credit_note_no_check,
      DROP CONSTRAINT IF EXISTS sales_void_fields_consistent,
      DROP CONSTRAINT IF EXISTS sales_voided_by_fkey,
      DROP CONSTRAINT IF EXISTS sales_status_check;

    ALTER TABLE sales
      DROP COLUMN IF EXISTS credit_note_no,
      DROP COLUMN IF EXISTS void_reason,
      DROP COLUMN IF EXISTS voided_by,
      DROP COLUMN IF EXISTS voided_at,
      DROP COLUMN IF EXISTS status;
  `);
}
