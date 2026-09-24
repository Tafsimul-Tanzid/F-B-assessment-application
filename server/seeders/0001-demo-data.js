import bcrypt from 'bcryptjs';

/**
 * Demo dataset so a reviewer can open the deployed instance and immediately
 * have something to click: one HQ admin, three outlets with their own staff
 * logins, a shared master menu, per-outlet assignments (including two price
 * overrides), and opening stock.
 *
 * Deliberately no sales — the reports should start empty so that ringing up a
 * sale visibly moves the numbers.
 */

const PASSWORD = 'Password123!';

const OUTLETS = [
  { id: 'a0000000-0000-4000-8000-000000000001', code: 'DT-01', name: 'Downtown Café', address: '12 Market Street' },
  { id: 'a0000000-0000-4000-8000-000000000002', code: 'AP-02', name: 'Airport Kiosk', address: 'Terminal 2, Gate B' },
  { id: 'a0000000-0000-4000-8000-000000000003', code: 'MS-03', name: 'Mall Stand', address: 'Level 3, Central Mall' },
];

const MENU_ITEMS = [
  { id: 'b0000000-0000-4000-8000-000000000001', sku: 'COF-ESP', name: 'Espresso', category: 'Coffee', basePrice: '3.00' },
  { id: 'b0000000-0000-4000-8000-000000000002', sku: 'COF-LAT', name: 'Latte', category: 'Coffee', basePrice: '4.50' },
  { id: 'b0000000-0000-4000-8000-000000000003', sku: 'COF-CAP', name: 'Cappuccino', category: 'Coffee', basePrice: '4.25' },
  { id: 'b0000000-0000-4000-8000-000000000004', sku: 'COF-AME', name: 'Americano', category: 'Coffee', basePrice: '3.50' },
  { id: 'b0000000-0000-4000-8000-000000000005', sku: 'TEA-GRN', name: 'Green Tea', category: 'Tea', basePrice: '3.25' },
  { id: 'b0000000-0000-4000-8000-000000000006', sku: 'TEA-CHA', name: 'Chai Latte', category: 'Tea', basePrice: '4.00' },
  { id: 'b0000000-0000-4000-8000-000000000007', sku: 'FOD-CRO', name: 'Butter Croissant', category: 'Food', basePrice: '3.75' },
  { id: 'b0000000-0000-4000-8000-000000000008', sku: 'FOD-SAN', name: 'Chicken Sandwich', category: 'Food', basePrice: '7.50' },
  { id: 'b0000000-0000-4000-8000-000000000009', sku: 'FOD-SAL', name: 'Garden Salad', category: 'Food', basePrice: '6.95' },
  { id: 'b0000000-0000-4000-8000-000000000010', sku: 'FOD-MUF', name: 'Blueberry Muffin', category: 'Food', basePrice: '3.25' },
  { id: 'b0000000-0000-4000-8000-000000000011', sku: 'CLD-ICE', name: 'Iced Coffee', category: 'Cold', basePrice: '4.75' },
  { id: 'b0000000-0000-4000-8000-000000000012', sku: 'CLD-SMO', name: 'Mango Smoothie', category: 'Cold', basePrice: '5.50' },
];

/**
 * Per-outlet assignment. The airport kiosk charges a premium on everything it
 * carries (captive-audience pricing) and carries a narrower range; the mall
 * stand skips the hot food.
 */
const ASSIGNMENTS = {
  'a0000000-0000-4000-8000-000000000001': MENU_ITEMS.map((m) => ({ menuItemId: m.id, priceOverride: null })),
  'a0000000-0000-4000-8000-000000000002': [
    { menuItemId: 'b0000000-0000-4000-8000-000000000001', priceOverride: '4.00' },
    { menuItemId: 'b0000000-0000-4000-8000-000000000002', priceOverride: '5.75' },
    { menuItemId: 'b0000000-0000-4000-8000-000000000004', priceOverride: '4.50' },
    { menuItemId: 'b0000000-0000-4000-8000-000000000007', priceOverride: '4.95' },
    { menuItemId: 'b0000000-0000-4000-8000-000000000008', priceOverride: '9.50' },
    { menuItemId: 'b0000000-0000-4000-8000-000000000011', priceOverride: '6.00' },
  ],
  'a0000000-0000-4000-8000-000000000003': [
    { menuItemId: 'b0000000-0000-4000-8000-000000000002', priceOverride: null },
    { menuItemId: 'b0000000-0000-4000-8000-000000000003', priceOverride: null },
    { menuItemId: 'b0000000-0000-4000-8000-000000000005', priceOverride: null },
    { menuItemId: 'b0000000-0000-4000-8000-000000000006', priceOverride: '3.75' },
    { menuItemId: 'b0000000-0000-4000-8000-000000000010', priceOverride: null },
    { menuItemId: 'b0000000-0000-4000-8000-000000000011', priceOverride: null },
    { menuItemId: 'b0000000-0000-4000-8000-000000000012', priceOverride: null },
  ],
};

const USERS = [
  {
    id: 'c0000000-0000-4000-8000-000000000001',
    email: 'hq@fnb.test',
    fullName: 'Hana Quereshi',
    role: 'HQ_ADMIN',
    outletId: null,
  },
  {
    id: 'c0000000-0000-4000-8000-000000000002',
    email: 'downtown@fnb.test',
    fullName: 'Dara Okonkwo',
    role: 'OUTLET_STAFF',
    outletId: 'a0000000-0000-4000-8000-000000000001',
  },
  {
    id: 'c0000000-0000-4000-8000-000000000003',
    email: 'airport@fnb.test',
    fullName: 'Alex Petrov',
    role: 'OUTLET_STAFF',
    outletId: 'a0000000-0000-4000-8000-000000000002',
  },
  {
    id: 'c0000000-0000-4000-8000-000000000004',
    email: 'mall@fnb.test',
    fullName: 'Mei Tanaka',
    role: 'OUTLET_STAFF',
    outletId: 'a0000000-0000-4000-8000-000000000003',
  },
];

// Opening stock. The airport kiosk runs deliberately thin so the
// insufficient-stock path is easy to demonstrate without setting it up first.
const OPENING_STOCK = {
  'a0000000-0000-4000-8000-000000000001': 120,
  'a0000000-0000-4000-8000-000000000002': 8,
  'a0000000-0000-4000-8000-000000000003': 60,
};

export async function up({ context: queryInterface, sequelize }) {
  await sequelize.transaction(async (transaction) => {
    const opts = { transaction };

    await queryInterface.bulkInsert('outlets', OUTLETS, opts);

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

    // Every outlet needs its counter row to exist before it can sell. Creating
    // it here (and in the outlet-creation service) keeps the sale path free of
    // a lazy upsert, which would turn a plain index lookup into a possible
    // insert conflict on the hot path.
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
          quantity: OPENING_STOCK[outletId],
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
