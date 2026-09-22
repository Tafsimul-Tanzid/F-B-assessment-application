/**
 * Core schema: outlets, master menu, per-outlet assignment, per-outlet
 * inventory, receipt counters, sales.
 *
 * Written as explicit SQL rather than through Sequelize's DDL helpers so that
 * constraint names are stable (the SQLSTATE mapper matches on them) and so
 * that a covering INCLUDE index can be expressed at all.
 */

export async function up({ context: queryInterface }) {
  const sql = queryInterface.sequelize;

  await sql.query(`
    ------------------------------------------------------------------------
    -- Users
    ------------------------------------------------------------------------
    CREATE TABLE users (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email         text        NOT NULL,
      password_hash text        NOT NULL,
      full_name     text        NOT NULL,
      role          text        NOT NULL,
      outlet_id     uuid,
      is_active     boolean     NOT NULL DEFAULT true,
      created_at    timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT users_email_key   UNIQUE (email),
      CONSTRAINT users_role_check  CHECK (role IN ('HQ_ADMIN', 'OUTLET_STAFF')),

      -- Outlet staff must belong to an outlet; HQ admins must not. Expressing
      -- this as a constraint rather than a service-layer rule means no code
      -- path can create a staff account with no outlet scope, which would
      -- otherwise silently bypass the per-outlet access checks.
      CONSTRAINT users_outlet_scope_check
        CHECK ((role = 'OUTLET_STAFF') = (outlet_id IS NOT NULL))
    );

    ------------------------------------------------------------------------
    -- Outlets
    ------------------------------------------------------------------------
    CREATE TABLE outlets (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code       text        NOT NULL,
      name       text        NOT NULL,
      address    text,
      is_active  boolean     NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT outlets_code_key UNIQUE (code)
    );

    ALTER TABLE users
      ADD CONSTRAINT users_outlet_id_fkey
      FOREIGN KEY (outlet_id) REFERENCES outlets (id) ON DELETE RESTRICT;

    ------------------------------------------------------------------------
    -- Master menu (owned by HQ)
    ------------------------------------------------------------------------
    CREATE TABLE menu_items (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sku        text        NOT NULL,
      name       text        NOT NULL,
      category   text,
      base_price numeric(12,2) NOT NULL,
      is_active  boolean     NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT menu_items_sku_key         UNIQUE (sku),
      CONSTRAINT menu_items_base_price_check CHECK (base_price >= 0)
    );

    ------------------------------------------------------------------------
    -- HQ assigns master menu items to outlets, optionally overriding price
    ------------------------------------------------------------------------
    CREATE TABLE outlet_menu_items (
      outlet_id      uuid        NOT NULL,
      menu_item_id   uuid        NOT NULL,
      price_override numeric(12,2),
      is_available   boolean     NOT NULL DEFAULT true,
      assigned_at    timestamptz NOT NULL DEFAULT now(),

      -- Composite PK doubles as the index for "this outlet's menu" and for
      -- resolving one item's effective price on the sale path.
      CONSTRAINT outlet_menu_items_pkey PRIMARY KEY (outlet_id, menu_item_id),
      CONSTRAINT outlet_menu_items_outlet_id_fkey
        FOREIGN KEY (outlet_id) REFERENCES outlets (id) ON DELETE CASCADE,
      CONSTRAINT outlet_menu_items_menu_item_id_fkey
        FOREIGN KEY (menu_item_id) REFERENCES menu_items (id) ON DELETE RESTRICT,
      CONSTRAINT outlet_menu_items_price_override_check
        CHECK (price_override IS NULL OR price_override >= 0)
    );

    ------------------------------------------------------------------------
    -- Per-outlet inventory
    ------------------------------------------------------------------------
    CREATE TABLE inventory (
      outlet_id    uuid          NOT NULL,
      menu_item_id uuid          NOT NULL,
      quantity     numeric(14,3) NOT NULL DEFAULT 0,
      updated_at   timestamptz   NOT NULL DEFAULT now(),

      CONSTRAINT inventory_pkey PRIMARY KEY (outlet_id, menu_item_id),
      CONSTRAINT inventory_outlet_id_fkey
        FOREIGN KEY (outlet_id) REFERENCES outlets (id) ON DELETE CASCADE,
      CONSTRAINT inventory_menu_item_id_fkey
        FOREIGN KEY (menu_item_id) REFERENCES menu_items (id) ON DELETE RESTRICT,

      -- Backstop, not the mechanism. Oversell is normally stopped by the
      -- "AND quantity >= :qty" guard in the deduction UPDATE, which produces a
      -- clean 409. This CHECK defends every OTHER write path (restocks,
      -- adjustments, future admin tooling, bugs). If it ever fires, the
      -- SQLSTATE mapper logs it at ERROR because a guard was bypassed.
      CONSTRAINT inventory_quantity_non_negative CHECK (quantity >= 0)
    );

    ------------------------------------------------------------------------
    -- Per-outlet receipt counters
    ------------------------------------------------------------------------
    -- A Postgres SEQUENCE is deliberately NOT used: sequences are global
    -- rather than per-outlet, and are gappy by design (a rolled-back
    -- transaction never returns its number). A counter row can be incremented
    -- and read atomically inside the sale transaction instead.
    CREATE TABLE outlet_receipt_counters (
      outlet_id       uuid   PRIMARY KEY,
      last_receipt_no bigint NOT NULL DEFAULT 0,

      CONSTRAINT outlet_receipt_counters_outlet_id_fkey
        FOREIGN KEY (outlet_id) REFERENCES outlets (id) ON DELETE CASCADE,
      CONSTRAINT outlet_receipt_counters_non_negative CHECK (last_receipt_no >= 0)
    );

    ------------------------------------------------------------------------
    -- Sales
    ------------------------------------------------------------------------
    CREATE TABLE sales (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      outlet_id    uuid          NOT NULL,
      receipt_no   bigint        NOT NULL,
      total_amount numeric(12,2) NOT NULL,
      item_count   integer       NOT NULL,
      sold_at      timestamptz   NOT NULL DEFAULT now(),
      cashier_id   uuid,

      -- The per-outlet sequential-receipt invariant, enforced by the database
      -- rather than trusted from the application. NOT DEFERRABLE on purpose:
      -- deferring it to commit time would turn an immediate, diagnosable
      -- failure into a commit-time abort after all the work is done.
      CONSTRAINT sales_outlet_id_receipt_no_key UNIQUE (outlet_id, receipt_no),
      CONSTRAINT sales_receipt_no_check   CHECK (receipt_no > 0),
      CONSTRAINT sales_total_amount_check CHECK (total_amount >= 0),
      CONSTRAINT sales_outlet_id_fkey
        FOREIGN KEY (outlet_id) REFERENCES outlets (id) ON DELETE RESTRICT,
      CONSTRAINT sales_cashier_id_fkey
        FOREIGN KEY (cashier_id) REFERENCES users (id) ON DELETE SET NULL
    );

    ------------------------------------------------------------------------
    -- Sale line items
    ------------------------------------------------------------------------
    CREATE TABLE sale_items (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sale_id      uuid          NOT NULL,
      menu_item_id uuid          NOT NULL,

      -- Snapshots. A receipt is a financial record: it must reprint
      -- identically years later, and historical revenue must not silently
      -- restate when HQ edits a price or unassigns an item. Joining the live
      -- menu at report time would do exactly that.
      item_name    text          NOT NULL,
      unit_price   numeric(12,2) NOT NULL,
      quantity     numeric(14,3) NOT NULL,
      line_total   numeric(12,2) NOT NULL,

      CONSTRAINT sale_items_sale_id_fkey
        FOREIGN KEY (sale_id) REFERENCES sales (id) ON DELETE CASCADE,
      CONSTRAINT sale_items_menu_item_id_fkey
        FOREIGN KEY (menu_item_id) REFERENCES menu_items (id) ON DELETE RESTRICT,
      CONSTRAINT sale_items_quantity_check   CHECK (quantity > 0),
      CONSTRAINT sale_items_unit_price_check CHECK (unit_price >= 0),
      CONSTRAINT sale_items_line_total_check CHECK (line_total >= 0)
    );

    ------------------------------------------------------------------------
    -- Indexes
    ------------------------------------------------------------------------

    -- Postgres indexes a foreign key's TARGET, never the referencing column.
    -- Without this, both receipt reprint and the top-items report's join
    -- sequential-scan sale_items.
    CREATE INDEX sale_items_sale_id_idx ON sale_items (sale_id);

    -- Covering index for the revenue report: with total_amount carried in the
    -- leaf pages the aggregate is an index-only scan that never touches the
    -- heap. sold_at is monotonic, so inserts land at the right edge of the
    -- B-tree with minimal page splitting.
    CREATE INDEX sales_outlet_id_sold_at_idx
      ON sales (outlet_id, sold_at) INCLUDE (total_amount);

    -- Outlet staff lookups scoped by outlet.
    CREATE INDEX users_outlet_id_idx ON users (outlet_id) WHERE outlet_id IS NOT NULL;

    -- Deliberately NOT created: sale_items (menu_item_id).
    -- The top-items report hash-aggregates rows it already has via the
    -- sale_id join; it never looks an item UP by id. The index would cost a
    -- B-tree insert per LINE ITEM (several times the per-sale cost) against a
    -- random UUID, dirtying a random leaf page on every write. Add it only if
    -- a "where has item X sold" query actually ships.
  `);
}

export async function down({ context: queryInterface }) {
  const sql = queryInterface.sequelize;
  await sql.query(`
    DROP TABLE IF EXISTS sale_items;
    DROP TABLE IF EXISTS sales;
    DROP TABLE IF EXISTS outlet_receipt_counters;
    DROP TABLE IF EXISTS inventory;
    DROP TABLE IF EXISTS outlet_menu_items;
    DROP TABLE IF EXISTS menu_items;
    ALTER TABLE IF EXISTS users DROP CONSTRAINT IF EXISTS users_outlet_id_fkey;
    DROP TABLE IF EXISTS outlets;
    DROP TABLE IF EXISTS users;
  `);
}
