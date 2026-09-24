import bcrypt from 'bcryptjs';
import request from 'supertest';
import { QueryTypes } from 'sequelize';

import { sequelize } from '../../src/db/sequelize.js';
import { runMigrations } from '../../src/db/migrator.js';
import { createApp } from '../../src/app.js';

export const app = createApp();

/**
 * Deterministic fixture ids, so assertions can name things directly.
 */
export const IDS = {
  outletA: 'a0000000-0000-4000-8000-00000000000a',
  outletB: 'a0000000-0000-4000-8000-00000000000b',
  latte: 'b0000000-0000-4000-8000-00000000000a',
  croissant: 'b0000000-0000-4000-8000-00000000000b',
  muffin: 'b0000000-0000-4000-8000-00000000000c',
  hq: 'c0000000-0000-4000-8000-00000000000a',
  staffA: 'c0000000-0000-4000-8000-00000000000b',
  staffB: 'c0000000-0000-4000-8000-00000000000c',
};

export const PASSWORD = 'Password123!';

export async function migrateOnce() {
  await runMigrations();
}

/**
 * Wipes every table and reinstalls the fixture set.
 *
 * TRUNCATE ... RESTART IDENTITY CASCADE rather than re-running migrations:
 * dropping and recreating the schema for every test would dominate the run
 * time and prove nothing extra.
 */
export async function resetDatabase() {
  await sequelize.query(`
    TRUNCATE sale_items, sales, inventory, outlet_menu_items,
             outlet_receipt_counters, outlet_credit_note_counters,
             users, menu_items, outlets
    RESTART IDENTITY CASCADE
  `);

  const passwordHash = await bcrypt.hash(PASSWORD, 4); // low cost: tests only

  // Each statement is issued separately: Postgres' extended query protocol,
  // which is what bind parameters use, allows only one command per statement.
  const exec = (sql, bind) => sequelize.query(sql, { bind });

  await exec(
    `INSERT INTO outlets (id, code, name) VALUES ($1, 'AAA', 'Outlet A'), ($2, 'BBB', 'Outlet B')`,
    [IDS.outletA, IDS.outletB],
  );

  await exec(
    `INSERT INTO outlet_receipt_counters (outlet_id, last_receipt_no) VALUES ($1, 0), ($2, 0)`,
    [IDS.outletA, IDS.outletB],
  );

  // Receipts and voids are numbered from separate per-outlet sequences.
  await exec(
    `INSERT INTO outlet_credit_note_counters (outlet_id, last_credit_note_no) VALUES ($1, 0), ($2, 0)`,
    [IDS.outletA, IDS.outletB],
  );

  await exec(
    `INSERT INTO menu_items (id, sku, name, category, base_price) VALUES
       ($1, 'LAT', 'Latte',     'Coffee', 4.50),
       ($2, 'CRO', 'Croissant', 'Food',   3.00),
       ($3, 'MUF', 'Muffin',    'Food',   2.50)`,
    [IDS.latte, IDS.croissant, IDS.muffin],
  );

  // Outlet A carries all three at base price; outlet B carries only the latte,
  // at an overridden price. The asymmetry is what the isolation and
  // price-override tests assert against.
  await exec(
    `INSERT INTO outlet_menu_items (outlet_id, menu_item_id, price_override) VALUES
       ($1, $3, NULL), ($1, $4, NULL), ($1, $5, NULL),
       ($2, $3, 6.00)`,
    [IDS.outletA, IDS.outletB, IDS.latte, IDS.croissant, IDS.muffin],
  );

  await exec(
    `INSERT INTO inventory (outlet_id, menu_item_id, quantity) VALUES
       ($1, $3, 100), ($1, $4, 50), ($1, $5, 20),
       ($2, $3, 10)`,
    [IDS.outletA, IDS.outletB, IDS.latte, IDS.croissant, IDS.muffin],
  );

  await exec(
    `INSERT INTO users (id, email, password_hash, full_name, role, outlet_id) VALUES
       ($1, 'hq@test.local',      $4, 'HQ Admin', 'HQ_ADMIN',     NULL),
       ($2, 'staff-a@test.local', $4, 'Staff A',  'OUTLET_STAFF', $5),
       ($3, 'staff-b@test.local', $4, 'Staff B',  'OUTLET_STAFF', $6)`,
    [IDS.hq, IDS.staffA, IDS.staffB, passwordHash, IDS.outletA, IDS.outletB],
  );
}

export async function loginAs(email) {
  const response = await request(app)
    .post('/api/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return response.body.token;
}

export const tokens = {
  hq: () => loginAs('hq@test.local'),
  staffA: () => loginAs('staff-a@test.local'),
  staffB: () => loginAs('staff-b@test.local'),
};

export async function stockOf(outletId, menuItemId) {
  const [row] = await sequelize.query(
    'SELECT quantity FROM inventory WHERE outlet_id = $1 AND menu_item_id = $2',
    { bind: [outletId, menuItemId], type: QueryTypes.SELECT },
  );
  return row ? Number(row.quantity) : null;
}

export async function closeDatabase() {
  await sequelize.close();
}
