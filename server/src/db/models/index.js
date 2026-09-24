import { DataTypes } from 'sequelize';
import { sequelize } from '../sequelize.js';

/**
 * Sequelize model definitions.
 *
 * These describe the tables created by the migrations; they do not create
 * them. `sequelize.sync()` is never called — the schema is owned by the
 * migration files, which are the only place DDL lives.
 *
 * Models are used for straightforward reads and inserts. The sale path drops
 * to raw SQL where the ORM cannot express what is needed (a guarded UPDATE, a
 * data-modifying CTE) — see the repositories.
 */

export const Outlet = sequelize.define('Outlet', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  code: { type: DataTypes.TEXT, allowNull: false, unique: true },
  name: { type: DataTypes.TEXT, allowNull: false },
  address: { type: DataTypes.TEXT },
  isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
}, { tableName: 'outlets' });

export const User = sequelize.define('User', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  email: { type: DataTypes.TEXT, allowNull: false, unique: true },
  passwordHash: { type: DataTypes.TEXT, allowNull: false },
  fullName: { type: DataTypes.TEXT, allowNull: false },
  role: { type: DataTypes.TEXT, allowNull: false },
  outletId: { type: DataTypes.UUID },
  isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
}, {
  tableName: 'users',
  defaultScope: {
    // The hash must be opted into explicitly (auth repository does so), so it
    // cannot leak through a controller that serialises a user straight out.
    attributes: { exclude: ['passwordHash'] },
  },
  scopes: { withPassword: { attributes: { include: ['passwordHash'] } } },
});

export const MenuItem = sequelize.define('MenuItem', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  sku: { type: DataTypes.TEXT, allowNull: false, unique: true },
  name: { type: DataTypes.TEXT, allowNull: false },
  category: { type: DataTypes.TEXT },
  // DECIMAL is returned as a string by node-postgres, deliberately. See the
  // note in db/sequelize.js — do not "fix" this with a float parser.
  basePrice: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
}, { tableName: 'menu_items' });

export const OutletMenuItem = sequelize.define('OutletMenuItem', {
  outletId: { type: DataTypes.UUID, primaryKey: true },
  menuItemId: { type: DataTypes.UUID, primaryKey: true },
  priceOverride: { type: DataTypes.DECIMAL(12, 2) },
  isAvailable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  assignedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
}, { tableName: 'outlet_menu_items' });

export const Inventory = sequelize.define('Inventory', {
  outletId: { type: DataTypes.UUID, primaryKey: true },
  menuItemId: { type: DataTypes.UUID, primaryKey: true },
  quantity: { type: DataTypes.DECIMAL(14, 3), allowNull: false, defaultValue: 0 },
  updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
}, { tableName: 'inventory' });

export const OutletReceiptCounter = sequelize.define('OutletReceiptCounter', {
  outletId: { type: DataTypes.UUID, primaryKey: true },
  lastReceiptNo: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
}, { tableName: 'outlet_receipt_counters' });

// Voids are numbered from their own per-outlet sequence, kept separate from
// receipts so the two kinds of document are never confused in an audit.
export const OutletCreditNoteCounter = sequelize.define('OutletCreditNoteCounter', {
  outletId: { type: DataTypes.UUID, primaryKey: true },
  lastCreditNoteNo: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
}, { tableName: 'outlet_credit_note_counters' });

export const Sale = sequelize.define('Sale', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  outletId: { type: DataTypes.UUID, allowNull: false },
  receiptNo: { type: DataTypes.BIGINT, allowNull: false },
  totalAmount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  itemCount: { type: DataTypes.INTEGER, allowNull: false },
  soldAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  cashierId: { type: DataTypes.UUID },
  // A voided sale is kept, not deleted: it happened, and its receipt number
  // stays consumed. Reports count 'completed' only.
  status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'completed' },
  voidedAt: { type: DataTypes.DATE },
  voidedBy: { type: DataTypes.UUID },
  voidReason: { type: DataTypes.TEXT },
  creditNoteNo: { type: DataTypes.BIGINT },
}, { tableName: 'sales' });

export const SaleItem = sequelize.define('SaleItem', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  saleId: { type: DataTypes.UUID, allowNull: false },
  menuItemId: { type: DataTypes.UUID, allowNull: false },
  // Snapshotted at sale time. Never re-derived from the live menu.
  itemName: { type: DataTypes.TEXT, allowNull: false },
  unitPrice: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  quantity: { type: DataTypes.DECIMAL(14, 3), allowNull: false },
  lineTotal: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
}, { tableName: 'sale_items' });

// --- associations ----------------------------------------------------------

User.belongsTo(Outlet, { foreignKey: 'outletId', as: 'outlet' });
Outlet.hasMany(User, { foreignKey: 'outletId', as: 'staff' });

Outlet.belongsToMany(MenuItem, {
  through: OutletMenuItem,
  foreignKey: 'outletId',
  otherKey: 'menuItemId',
  as: 'menuItems',
});
MenuItem.belongsToMany(Outlet, {
  through: OutletMenuItem,
  foreignKey: 'menuItemId',
  otherKey: 'outletId',
  as: 'outlets',
});

OutletMenuItem.belongsTo(MenuItem, { foreignKey: 'menuItemId', as: 'menuItem' });
OutletMenuItem.belongsTo(Outlet, { foreignKey: 'outletId', as: 'outlet' });
MenuItem.hasMany(OutletMenuItem, { foreignKey: 'menuItemId', as: 'assignments' });

Inventory.belongsTo(MenuItem, { foreignKey: 'menuItemId', as: 'menuItem' });
Inventory.belongsTo(Outlet, { foreignKey: 'outletId', as: 'outlet' });

Sale.belongsTo(Outlet, { foreignKey: 'outletId', as: 'outlet' });
Sale.belongsTo(User, { foreignKey: 'cashierId', as: 'cashier' });
Sale.hasMany(SaleItem, { foreignKey: 'saleId', as: 'items' });
SaleItem.belongsTo(Sale, { foreignKey: 'saleId', as: 'sale' });
SaleItem.belongsTo(MenuItem, { foreignKey: 'menuItemId', as: 'menuItem' });

export const models = {
  Outlet,
  User,
  MenuItem,
  OutletMenuItem,
  Inventory,
  OutletReceiptCounter,
  OutletCreditNoteCounter,
  Sale,
  SaleItem,
};

export default models;
