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

beforeAll(async () => {
  await migrateOnce();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await resetDatabase();
});

describe('per-outlet price override', () => {
  it('charges the outlet override rather than the master base price', async () => {
    const tokenB = await tokens.staffB(); // outlet B overrides latte to 6.00

    const response = await request(app)
      .post('/api/outlet/sales')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ items: [{ menuItemId: IDS.latte, quantity: 2 }] })
      .expect(201);

    expect(response.body.sale.totalAmount).toBe('12.00'); // 2 x 6.00, not 2 x 4.50
  });

  it('falls back to the base price when the override is cleared', async () => {
    const [tokenHq, tokenB] = await Promise.all([tokens.hq(), tokens.staffB()]);

    await request(app)
      .patch(`/api/hq/outlets/${IDS.outletB}/menu/${IDS.latte}`)
      .set('Authorization', `Bearer ${tokenHq}`)
      .send({ priceOverride: null })
      .expect(200);

    const response = await request(app)
      .post('/api/outlet/sales')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ items: [{ menuItemId: IDS.latte, quantity: 1 }] })
      .expect(201);

    expect(response.body.sale.totalAmount).toBe('4.50');
  });

  it('ignores any price the client tries to send', async () => {
    const tokenA = await tokens.staffA();

    // Strict schemas reject unknown fields outright, so a terminal cannot
    // smuggle a price in alongside the quantity.
    const response = await request(app)
      .post('/api/outlet/sales')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ items: [{ menuItemId: IDS.latte, quantity: 1, unitPrice: '0.01' }] })
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('price snapshots on sale items', () => {
  it('leaves a recorded sale untouched when HQ later changes the price', async () => {
    const [tokenHq, tokenA] = await Promise.all([tokens.hq(), tokens.staffA()]);

    const sale = await request(app)
      .post('/api/outlet/sales')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ items: [{ menuItemId: IDS.latte, quantity: 2 }] })
      .expect(201);

    expect(sale.body.sale.totalAmount).toBe('9.00');

    // HQ doubles the price and renames the item afterwards.
    await request(app)
      .patch(`/api/hq/menu-items/${IDS.latte}`)
      .set('Authorization', `Bearer ${tokenHq}`)
      .send({ basePrice: '9.00', name: 'Café Latte' })
      .expect(200);

    const reprint = await request(app)
      .get(`/api/outlet/sales/${sale.body.sale.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);

    // The receipt reprints exactly as it was issued: old name, old price, old
    // total. Joining the live menu instead of snapshotting would have
    // rewritten history here.
    expect(reprint.body.sale.totalAmount).toBe('9.00');
    expect(reprint.body.sale.items[0].itemName).toBe('Latte');
    expect(reprint.body.sale.items[0].unitPrice).toBe('4.50');
    expect(reprint.body.sale.items[0].lineTotal).toBe('9.00');
  });

  it('keeps the header total equal to the sum of its line totals', async () => {
    const tokenA = await tokens.staffA();

    // 3 x 4.50 = 13.50 and 7 x 3.00 = 21.00, so the header must read 34.50.
    // Rounding the sum once instead of per line is how a receipt ends up a
    // cent adrift from its own lines.
    const sale = await request(app)
      .post('/api/outlet/sales')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        items: [
          { menuItemId: IDS.latte, quantity: 3 },
          { menuItemId: IDS.croissant, quantity: 7 },
        ],
      })
      .expect(201);

    const reprint = await request(app)
      .get(`/api/outlet/sales/${sale.body.sale.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);

    const sumOfLines = reprint.body.sale.items.reduce((acc, i) => acc + Number(i.lineTotal), 0);
    expect(Number(reprint.body.sale.totalAmount)).toBe(sumOfLines);
    expect(reprint.body.sale.totalAmount).toBe('34.50');
  });
});

describe('request validation', () => {
  it('rejects an empty cart with field-level detail', async () => {
    const tokenA = await tokens.staffA();

    const response = await request(app)
      .post('/api/outlet/sales')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ items: [] })
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details[0]).toMatchObject({ in: 'body', field: 'items' });
  });

  it('rejects a zero or negative quantity', async () => {
    const tokenA = await tokens.staffA();

    await request(app)
      .post('/api/outlet/sales')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ items: [{ menuItemId: IDS.latte, quantity: 0 }] })
      .expect(400);

    await request(app)
      .post('/api/outlet/sales')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ items: [{ menuItemId: IDS.latte, quantity: -5 }] })
      .expect(400);
  });

  it('rejects a malformed uuid rather than reaching the database', async () => {
    const tokenA = await tokens.staffA();

    const response = await request(app)
      .post('/api/outlet/sales')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ items: [{ menuItemId: 'not-a-uuid', quantity: 1 }] })
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns a structured error body with a request id, never a stack trace', async () => {
    const tokenA = await tokens.staffA();

    const response = await request(app)
      .post('/api/outlet/sales')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ nonsense: true })
      .expect(400);

    expect(response.body.error).toHaveProperty('requestId');
    expect(JSON.stringify(response.body)).not.toContain('at ');
  });
});
