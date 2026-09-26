import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { QueryTypes } from 'sequelize';

import {
  IDS,
  closeDatabase,
  migrateOnce,
  resetDatabase,
  stockOf,
  tokens,
  app,
} from '../helpers/fixtures.js';
import { sequelize } from '../../src/db/sequelize.js';
import { createSale } from '../../src/services/sale.service.js';

/**
 * Brief §13C: force an error AFTER inventory has been deducted, and prove
 * everything rolls back together - the sale, its line items, the inventory
 * deduction, and the receipt allocation.
 *
 * The existing concurrency suite already covers the natural failure case
 * (insufficient stock on a later line, caught before any database write for
 * that line). This test is deliberately different: it forces a failure at the
 * DATABASE constraint layer, one step further into the transaction than any
 * validation would normally allow.
 *
 * `createSale` is called directly rather than through the HTTP layer, because
 * the zod schema at the route already rejects a non-positive quantity before
 * it reaches the service - reaching the CHECK constraint at all requires
 * bypassing that outer validation, exactly as a real bug in a future code
 * path might. This is precisely the CHECK's job: it is documented everywhere
 * else in this codebase as a backstop for paths that are not the normal,
 * validated one.
 */

beforeAll(async () => { await migrateOnce(); });
afterAll(async () => { await closeDatabase(); });
beforeEach(async () => { await resetDatabase(); });

describe('forced failure after inventory deduction (brief §13C)', () => {
  it('rolls back the deduction, the sale, the sale items and the receipt allocation together', async () => {
    const before = await stockOf(IDS.outletA, IDS.latte);

    // Line 1 is entirely valid and deducts real stock. Line 2 carries a
    // quantity of 0, which the guarded UPDATE happily accepts (a no-op
    // deduction, "quantity - 0 >= 0" is always true) but which then fails
    // sale_items' CHECK (quantity > 0) at the INSERT step - AFTER line 1's
    // real deduction has already been written inside the same transaction.
    const attempt = createSale({
      outletId: IDS.outletA,
      cashierId: IDS.staffA,
      lines: [
        { menuItemId: IDS.latte, quantity: 5 },
        { menuItemId: IDS.croissant, quantity: 0 },
      ],
    });

    await expect(attempt).rejects.toThrow();

    // The Latte deduction from line 1 must be fully reverted, not left
    // partially applied.
    expect(await stockOf(IDS.outletA, IDS.latte)).toBe(before);

    // No sale, no sale_items row, from this attempt.
    const [{ count: saleCount }] = await sequelize.query(
      'SELECT count(*)::int AS count FROM sales WHERE outlet_id = $1',
      { bind: [IDS.outletA], type: QueryTypes.SELECT },
    );
    expect(saleCount).toBe(0);

    const [{ count: itemCount }] = await sequelize.query(
      'SELECT count(*)::int AS count FROM sale_items',
      { type: QueryTypes.SELECT },
    );
    expect(itemCount).toBe(0);

    // The receipt counter was bumped and then rolled back with everything
    // else in the same transaction - the next real sale still gets #1, not
    // #2. This is the literal proof that "receipt should not be partially
    // generated."
    const token = await tokens.staffA();
    const nextSale = await request(app)
      .post('/api/outlet/sales')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ menuItemId: IDS.latte, quantity: 1 }] })
      .expect(201);

    expect(Number(nextSale.body.sale.receiptNo)).toBe(1);
  });
});
