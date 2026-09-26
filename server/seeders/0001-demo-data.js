import bcrypt from 'bcryptjs';
import { QueryTypes } from 'sequelize';

/**
 * Demo dataset so a reviewer can open the deployed instance and immediately
 * have something to click: one HQ admin, two outlets with their own staff
 * logins, a shared master menu, per-outlet assignments (including a price
 * override), and opening stock.
 *
 * Deliberately no sales — the reports should start empty so that ringing up a
 * sale visibly moves the numbers.
 */

const PASSWORD = 'Password123!';

const OUTLETS = [
  { id: 'a0000000-0000-4000-8000-000000000001', code: 'GUL-01', name: 'Gulshan Outlet', address: 'Road 11, Gulshan 1, Dhaka' },
  { id: 'a0000000-0000-4000-8000-000000000002', code: 'DHM-02', name: 'Dhanmondi Outlet', address: 'Road 27, Dhanmondi, Dhaka' },
];

const MENU_ITEMS = [
  { id: 'b0000000-0000-4000-8000-000000000001', sku: 'FOD-BUR', name: 'Burger', category: 'Food', basePrice: '8.50' },
  { id: 'b0000000-0000-4000-8000-000000000002', sku: 'FOD-PIZ', name: 'Pizza', category: 'Food', basePrice: '12.00' },
  { id: 'b0000000-0000-4000-8000-000000000003', sku: 'FOD-PAS', name: 'Pasta', category: 'Food', basePrice: '10.50' },
  { id: 'b0000000-0000-4000-8000-000000000004', sku: 'FOD-FRI', name: 'Fries', category: 'Food', basePrice: '4.00' },
  { id: 'b0000000-0000-4000-8000-000000000005', sku: 'BEV-COF', name: 'Coffee', category: 'Beverage', basePrice: '3.50' },
  { id: 'b0000000-0000-4000-8000-000000000006', sku: 'BEV-SOD', name: 'Soft Drink', category: 'Beverage', basePrice: '2.50' },
];

/**
 * Per-outlet assignment. Gulshan carries the full menu at base price.
 * Dhanmondi does not carry Pasta (demonstrates "outlet sees only its assigned
 * menu") and charges more for Pizza (demonstrates the price override).
 */
const ASSIGNMENTS = {
  'a0000000-0000-4000-8000-000000000001': MENU_ITEMS.map((m) => ({ menuItemId: m.id, priceOverride: null })),
  'a0000000-0000-4000-8000-000000000002': MENU_ITEMS.filter((m) => m.sku !== 'FOD-PAS').map((m) => ({
    menuItemId: m.id,
    priceOverride: m.sku === 'FOD-PIZ' ? '13.50' : null,
  })),
};

const USERS = [
  {
    id: 'c0000000-0000-4000-8000-000000000001',
    email: 'hq@fnb.test',
    fullName: 'HQ Admin',
    role: 'HQ_ADMIN',
    outletId: null,
  },
  {
    id: 'c0000000-0000-4000-8000-000000000002',
    email: 'gulshan@fnb.test',
    fullName: 'Gulshan Outlet Staff',
    role: 'OUTLET_STAFF',
    outletId: 'a0000000-0000-4000-8000-000000000001',
  },
  {
    id: 'c0000000-0000-4000-8000-000000000003',
    email: 'dhanmondi@fnb.test',
    fullName: 'Dhanmondi Outlet Staff',
    role: 'OUTLET_STAFF',
    outletId: 'a0000000-0000-4000-8000-000000000002',
  },
];

// Opening stock. Dhanmondi runs deliberately thin on Burger so the
// insufficient-stock path is easy to demonstrate without setting it up first.
const OPENING_STOCK = {
  'a0000000-0000-4000-8000-000000000001': { default: 60 },
  'a0000000-0000-4000-8000-000000000002': { default: 40, 'FOD-BUR': 6 },
};

function stockFor(outletId, sku) {
  const config = OPENING_STOCK[outletId];
  return config[sku] ?? config.default;
}

export async function up({ context: queryInterface, sequelize }) {
  await sequelize.transaction(async (transaction) => {
    const opts = { transaction };

    // The core-schema and companies migrations run before any seeder, so the
    // single company row already exists (created by the companies migration's
    // backfill step). Reuse it rather than inserting a second one, which
    // would violate companies_name_key.
    const [company] = await sequelize.query('SELECT id FROM companies LIMIT 1', {
      type: QueryTypes.SELECT,
      transaction,
    });

    await queryInterface.bulkInsert(
      'outlets',
      OUTLETS.map((o) => ({ ...o, company_id: company.id })),
      opts,
    );

    await queryInterface.bulkInsert(
      'menu_items',
      MENU_ITEMS.map((m) => ({
        id: m.id,
        sku: m.sku,
        name: m.name,
        category: m.category,
        base_price: m.basePrice,
      })),
      opts,
    );

    // Every outlet needs its counter rows to exist before it can sell or void.
    // Creating them here (and in the outlet-creation service) keeps the sale
    // path free of a lazy upsert, which would turn a plain index lookup into
    // a possible insert conflict on the hot path.
    await queryInterface.bulkInsert(
      'outlet_receipt_counters',
      OUTLETS.map((o) => ({ outlet_id: o.id, last_receipt_no: 0 })),
      opts,
    );

    await queryInterface.bulkInsert(
      'outlet_credit_note_counters',
      OUTLETS.map((o) => ({ outlet_id: o.id, last_credit_note_no: 0 })),
      opts,
    );

    const skuById = new Map(MENU_ITEMS.map((m) => [m.id, m.sku]));
    const assignmentRows = [];
    const inventoryRows = [];

    for (const [outletId, assignments] of Object.entries(ASSIGNMENTS)) {
      for (const assignment of assignments) {
        assignmentRows.push({
          outlet_id: outletId,
          menu_item_id: assignment.menuItemId,
          price_override: assignment.priceOverride,
          is_available: true,
        });
        inventoryRows.push({
          outlet_id: outletId,
          menu_item_id: assignment.menuItemId,
          quantity: stockFor(outletId, skuById.get(assignment.menuItemId)),
        });
      }
    }

    await queryInterface.bulkInsert('outlet_menu_items', assignmentRows, opts);
    await queryInterface.bulkInsert('inventory', inventoryRows, opts);

    // Cost factor 10 is the usual default. Higher is slower to seed and to log
    // in; this is a demo dataset, not a credential store.
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    await queryInterface.bulkInsert(
      'users',
      USERS.map((u) => ({
        id: u.id,
        email: u.email,
        password_hash: passwordHash,
        full_name: u.fullName,
        role: u.role,
        outlet_id: u.outletId,
      })),
      opts,
    );
  });
}

export async function down({ context: queryInterface, sequelize }) {
  await sequelize.transaction(async (transaction) => {
    const opts = { transaction };
    await queryInterface.bulkDelete('sale_items', {}, opts);
    await queryInterface.bulkDelete('sales', {}, opts);
    await queryInterface.bulkDelete('users', {}, opts);
    await queryInterface.bulkDelete('inventory', {}, opts);
    await queryInterface.bulkDelete('outlet_menu_items', {}, opts);
    await queryInterface.bulkDelete('outlet_receipt_counters', {}, opts);
    await queryInterface.bulkDelete('outlet_credit_note_counters', {}, opts);
    await queryInterface.bulkDelete('menu_items', {}, opts);
    await queryInterface.bulkDelete('outlets', {}, opts);
  });
}
