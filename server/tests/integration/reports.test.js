import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import {
  IDS,
  app,
  closeDatabase,
  migrateOnce,
  resetDatabase,
  tokens,
} from '../helpers/fixtures.js';

/**
 * Report figures are asserted against hand-computed arithmetic, not against
 * whatever the query happens to return. Fixture prices: latte 4.50 (6.00 at
 * outlet B), croissant 3.00, muffin 2.50.
 */

beforeAll(async () => {
  await migrateOnce();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await resetDatabase();
});

async function ringUp(token, items) {
  return request(app)
    .post('/api/outlet/sales')
    .set('Authorization', `Bearer ${token}`)
    .send({ items })
    .expect(201);
}

/**
 * Outlet A: 5 lattes, 3 croissants, 8 muffins  -> 22.50 + 9.00 + 20.00 = 51.50
 * Outlet B: 2 lattes at the 6.00 override      -> 12.00
 */
async function seedSales() {
  const [tokenA, tokenB] = await Promise.all([tokens.staffA(), tokens.staffB()]);

  await ringUp(tokenA, [
    { menuItemId: IDS.latte, quantity: 5 },
    { menuItemId: IDS.croissant, quantity: 3 },
  ]);
  await ringUp(tokenA, [{ menuItemId: IDS.muffin, quantity: 8 }]);
  await ringUp(tokenB, [{ menuItemId: IDS.latte, quantity: 2 }]);

  return { tokenA, tokenB };
}

describe('revenue by outlet', () => {
  it('totals each outlet\'s revenue and the company figure', async () => {
    await seedSales();
    const tokenHq = await tokens.hq();

    const response = await request(app)
      .get('/api/hq/reports/revenue')
      .set('Authorization', `Bearer ${tokenHq}`)
      .expect(200);

    const byCode = Object.fromEntries(response.body.outlets.map((o) => [o.outletCode, o]));

    expect(byCode.AAA.revenue).toBe('51.50');
    expect(Number(byCode.AAA.saleCount)).toBe(2);

    expect(byCode.BBB.revenue).toBe('12.00');
    expect(Number(byCode.BBB.saleCount)).toBe(1);

    expect(response.body.totals.revenue).toBe('63.50');
    expect(response.body.totals.saleCount).toBe(3);
  });

  it('includes an outlet that sold nothing, with zero revenue', async () => {
    const tokenA = await tokens.staffA();
    await ringUp(tokenA, [{ menuItemId: IDS.latte, quantity: 1 }]);

    const tokenHq = await tokens.hq();
    const response = await request(app)
      .get('/api/hq/reports/revenue')
      .set('Authorization', `Bearer ${tokenHq}`)
      .expect(200);

    const outletB = response.body.outlets.find((o) => o.outletCode === 'BBB');

    // The date and status predicates live in the LEFT JOIN's ON clause. Had
    // they been in WHERE, this outlet would have vanished from the report
    // entirely rather than reporting zero.
    expect(outletB).toBeDefined();
    expect(outletB.revenue).toBe('0');
    expect(Number(outletB.saleCount)).toBe(0);
  });

  it('respects the date range, treating `to` as exclusive', async () => {
    await seedSales();
    const tokenHq = await tokens.hq();

    const future = await request(app)
      .get('/api/hq/reports/revenue')
      .query({ from: '2099-01-01', to: '2099-01-02' })
      .set('Authorization', `Bearer ${tokenHq}`)
      .expect(200);

    expect(future.body.totals.revenue).toBe('0.00');
    // Every outlet is still listed, just with nothing in it.
    expect(future.body.outlets).toHaveLength(2);
  });

  it('rejects an inverted date range', async () => {
    const tokenHq = await tokens.hq();

    await request(app)
      .get('/api/hq/reports/revenue')
      .query({ from: '2026-02-01', to: '2026-01-01' })
      .set('Authorization', `Bearer ${tokenHq}`)
      .expect(400);
  });
});

describe('top selling items per outlet', () => {
  it('ranks by units sold, per outlet', async () => {
    await seedSales();
    const tokenHq = await tokens.hq();

    const response = await request(app)
      .get('/api/hq/reports/top-items')
      .set('Authorization', `Bearer ${tokenHq}`)
      .expect(200);

    const outletA = response.body.outlets.find((o) => o.outletCode === 'AAA');

    // 8 muffins, 5 lattes, 3 croissants.
    expect(outletA.items.map((i) => i.itemName)).toEqual(['Muffin', 'Latte', 'Croissant']);
    expect(outletA.items[0].unitsSold).toBe('8.000');
    expect(outletA.items[0].revenue).toBe('20.00');
    expect(outletA.items.map((i) => i.rank)).toEqual([1, 2, 3]);

    // Outlet B sold only lattes, and at its own overridden price.
    const outletB = response.body.outlets.find((o) => o.outletCode === 'BBB');
    expect(outletB.items).toHaveLength(1);
    expect(outletB.items[0].revenue).toBe('12.00');
  });

  it('returns at most five items per outlet by default', async () => {
    const tokenHq = await tokens.hq();
    const tokenA = await tokens.staffA();

    // Six distinct items, so the cut-off is actually exercised.
    const extra = [];
    for (const [sku, price] of [['E1', '1.00'], ['E2', '1.00'], ['E3', '1.00']]) {
      const created = await request(app)
        .post('/api/hq/menu-items')
        .set('Authorization', `Bearer ${tokenHq}`)
        .send({ sku, name: `Extra ${sku}`, basePrice: price })
        .expect(201);

      const menuItemId = created.body.menuItem.id;
      await request(app)
        .post(`/api/hq/outlets/${IDS.outletA}/menu`)
        .set('Authorization', `Bearer ${tokenHq}`)
        .send({ menuItemId })
        .expect(201);
      await request(app)
        .post(`/api/hq/outlets/${IDS.outletA}/inventory/adjust`)
        .set('Authorization', `Bearer ${tokenHq}`)
        .send({ menuItemId, delta: 10 })
        .expect(200);

      extra.push(menuItemId);
    }

    await ringUp(tokenA, [
      { menuItemId: IDS.latte, quantity: 6 },
      { menuItemId: IDS.croissant, quantity: 5 },
      { menuItemId: IDS.muffin, quantity: 4 },
      { menuItemId: extra[0], quantity: 3 },
      { menuItemId: extra[1], quantity: 2 },
      { menuItemId: extra[2], quantity: 1 },
    ]);

    const response = await request(app)
      .get('/api/hq/reports/top-items')
      .set('Authorization', `Bearer ${tokenHq}`)
      .expect(200);

    const outletA = response.body.outlets.find((o) => o.outletCode === 'AAA');
    expect(outletA.items).toHaveLength(5);
    expect(outletA.items.map((i) => Number(i.unitsSold))).toEqual([6, 5, 4, 3, 2]);
  });

  it('keeps a renamed item as one row rather than splitting it', async () => {
    const tokenHq = await tokens.hq();
    const tokenA = await tokens.staffA();

    await ringUp(tokenA, [{ menuItemId: IDS.latte, quantity: 2 }]);

    await request(app)
      .patch(`/api/hq/menu-items/${IDS.latte}`)
      .set('Authorization', `Bearer ${tokenHq}`)
      .send({ name: 'Café Latte' })
      .expect(200);

    await ringUp(tokenA, [{ menuItemId: IDS.latte, quantity: 3 }]);

    const response = await request(app)
      .get('/api/hq/reports/top-items')
      .set('Authorization', `Bearer ${tokenHq}`)
      .expect(200);

    const outletA = response.body.outlets.find((o) => o.outletCode === 'AAA');
    const latteRows = outletA.items.filter((i) => i.menuItemId === IDS.latte);

    // Grouped by menu_item_id, so the two snapshot names collapse into one
    // row of 5 units. Grouping by the snapshotted name would have produced
    // "Latte: 2" and "Café Latte: 3".
    expect(latteRows).toHaveLength(1);
    expect(Number(latteRows[0].unitsSold)).toBe(5);
  });

  it('is HQ-only', async () => {
    const tokenA = await tokens.staffA();

    await request(app)
      .get('/api/hq/reports/revenue')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(403);
  });
});
