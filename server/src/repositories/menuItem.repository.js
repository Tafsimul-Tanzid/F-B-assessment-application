import { Op } from 'sequelize';
import { MenuItem } from '../db/models/index.js';

/**
 * Master menu, owned by HQ.
 * @see ./README.md for the repository layer contract.
 */

export async function findAll({ search, category, includeInactive = false } = {}, { transaction } = {}) {
  const where = {};
  if (!includeInactive) where.isActive = true;
  if (category) where.category = category;
  if (search) {
    where[Op.or] = [
      { name: { [Op.iLike]: `%${search}%` } },
      { sku: { [Op.iLike]: `%${search}%` } },
    ];
  }

  return MenuItem.findAll({ where, order: [['category', 'ASC'], ['name', 'ASC']], transaction });
}

export async function findById(id, { transaction } = {}) {
  return MenuItem.findByPk(id, { transaction });
}

export async function findBySku(sku, { transaction } = {}) {
  return MenuItem.findOne({ where: { sku }, transaction });
}

export async function create(data, { transaction } = {}) {
  return MenuItem.create(data, { transaction });
}

export async function update(id, data, { transaction } = {}) {
  const [count, rows] = await MenuItem.update(
    { ...data, updatedAt: new Date() },
    { where: { id }, returning: true, transaction },
  );
  return count === 0 ? null : rows[0];
}
