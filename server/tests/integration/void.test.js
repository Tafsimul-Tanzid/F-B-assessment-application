import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import {
  IDS,
  app,
  closeDatabase,
  migrateOnce,
  resetDatabase,
  stockOf,
  tokens,
} from '../helpers/fixtures.js';

/**
 * Voiding a sale. The invariants under test are accounting ones: stock comes
 * back, the receipt number is never reused, the sale is never deleted, and
 * voided money leaves the reports.
 */

beforeAll(async () => { await migrateOnce(); });
afterAll(async () => { await closeDatabase(); });
beforeEach(async () => { await resetDatabase(); });

const sell = (token, items) =>
  request(app).post('/api/outlet/sales').set('Authorization', `Bearer ${token}`).send({ items });

const voidSale = (token, saleId, reason = 'Customer changed their mind') =>
  request(app)
    .post(`/api/outlet/sales/${saleId}/void`)
    .set('Authorization', `Bearer ${token}`)
    .send({ reason });

describe('voiding a sale', () => {
  it('returns the stock it took', async () => {
    const token = await tokens.staffA();

    await sell(token, [
      { menuItemId: IDS.latte, quantity: 3 },
      { menuItemId: IDS.muffin, quantity: 2 },
    ]).expect(201);

    expect(await stockOf(IDS.outletA, IDS.latte)).toBe(97);
    expect(await stockOf(IDS.outletA, IDS.muffin)).toBe(18);

    const sale = await request(app)
      .get('/api/outlet/sales')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    await voidSale(token, sale.body.sales[0].id).expect(200);

    expect(await stockOf(IDS.outletA, IDS.latte)).toBe(100);
    expect(await stockOf(IDS.outletA, IDS.muffin)).toBe(20);
  });

  it('keeps the sale and issues a credit note instead of deleting it', async () => {
    const token = await tokens.staffA();

    const created = await sell(token, [{ menuItemId: IDS.latte, quantity: 1 }]).expect(201);
    const saleId = created.body.sale.id;

    const voided = await voidSale(token, saleId, 'Spilled').expect(200);

    expect(voided.body.sale.status).toBe('voided');
    expect(Number(voided.body.sale.creditNoteNo)).toBe(1);
    // The receipt number is untouched - the sale still happened.
    expect(Number(voided.body.sale.receiptNo)).toBe(1);

    const reprint = await request(app)
      .get(`/api/outlet/sales/${saleId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(reprint.body.sale.status).toBe('voided');
    expect(reprint.body.sale.voidReason).toBe('Spilled');
    expect(reprint.body.sale.items).toHaveLength(1);
  });

  it('never reissues the voided receipt number', async () => {
    const token = await tokens.staffA();

    const first = await sell(token, [{ menuItemId: IDS.latte, quantity: 1 }]).expect(201);
    expect(Number(first.body.sale.receiptNo)).toBe(1);

    await voidSale(token, first.body.sale.id).expect(200);

    // The next sale is #2. A voided receipt number is consumed forever.
    const second = await sell(token, [{ menuItemId: IDS.latte, quantity: 1 }]).expect(201);
    expect(Number(second.body.sale.receiptNo)).toBe(2);
  });

  it('numbers credit notes sequentially per outlet, separately from receipts', async () => {
    const [tokenA, tokenB] = await Promise.all([tokens.staffA(), tokens.staffB()]);

    const a1 = await sell(tokenA, [{ menuItemId: IDS.latte, quantity: 1 }]).expect(201);
    const a2 = await sell(tokenA, [{ menuItemId: IDS.latte, quantity: 1 }]).expect(201);
    const b1 = await sell(tokenB, [{ menuItemId: IDS.latte, quantity: 1 }]).expect(201);

    const v1 = await voidSale(tokenA, a1.body.sale.id).expect(200);
    const v2 = await voidSale(tokenA, a2.body.sale.id).expect(200);
    const v3 = await voidSale(tokenB, b1.body.sale.id).expect(200);

    expect(Number(v1.body.sale.creditNoteNo)).toBe(1);
    expect(Number(v2.body.sale.creditNoteNo)).toBe(2);
    // Outlet B has its own credit note sequence, as it has its own receipts.
    expect(Number(v3.body.sale.creditNoteNo)).toBe(1);
  });

  it('refuses a second void and does not restore stock twice', async () => {
    const token = await tokens.staffA();

    const created = await sell(token, [{ menuItemId: IDS.latte, quantity: 5 }]).expect(201);
    await voidSale(token, created.body.sale.id).expect(200);
    expect(await stockOf(IDS.outletA, IDS.latte)).toBe(100);

    const second = await voidSale(token, created.body.sale.id).expect(409);
    expect(second.body.error.code).toBe('ALREADY_VOIDED');

    // Stock did not go to 105.
    expect(await stockOf(IDS.outletA, IDS.latte)).toBe(100);
  });

  it('survives concurrent void attempts: exactly one wins', async () => {
    const token = await tokens.staffA();

    const created = await sell(token, [{ menuItemId: IDS.latte, quantity: 4 }]).expect(201);
    const saleId = created.body.sale.id;

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => voidSale(token, saleId)),
    );

    const succeeded = responses.filter((r) => r.status === 200);
    const rejected = responses.filter((r) => r.status !== 200);

    // The guarded status update is what makes this exactly one rather than
    // "usually one" - the nine losers re-evaluate against the committed row.
    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(9);
    expect(rejected.every((r) => r.status === 409)).toBe(true);

    // Stock restored once, not ten times.
    expect(await stockOf(IDS.outletA, IDS.latte)).toBe(100);
  });

  it('cannot void another outlet\'s sale', async () => {
    const [tokenA, tokenB] = await Promise.all([tokens.staffA(), tokens.staffB()]);

    const created = await sell(tokenA, [{ menuItemId: IDS.latte, quantity: 1 }]).expect(201);

    await voidSale(tokenB, created.body.sale.id).expect(404);

    // Outlet A's stock is untouched by outlet B's attempt.
    expect(await stockOf(IDS.outletA, IDS.latte)).toBe(99);
  });

  it('requires a reason', async () => {
    const token = await tokens.staffA();
    const created = await sell(token, [{ menuItemId: IDS.latte, quantity: 1 }]).expect(201);

    await request(app)
      .post(`/api/outlet/sales/${created.body.sale.id}/void`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(400);
  });
});

describe('voided sales and reporting', () => {
  it('removes voided revenue from the revenue report', async () => {
    const [tokenHq, tokenA] = await Promise.all([tokens.hq(), tokens.staffA()]);

    await sell(tokenA, [{ menuItemId: IDS.latte, quantity: 2 }]).expect(201); // 9.00
    const toVoid = await sell(tokenA, [{ menuItemId: IDS.muffin, quantity: 4 }]).expect(201); // 10.00

    const before = await request(app)
      .get('/api/hq/reports/revenue')
      .set('Authorization', `Bearer ${tokenHq}`)
      .expect(200);
    expect(before.body.totals.revenue).toBe('19.00');

    await voidSale(tokenA, toVoid.body.sale.id).expect(200);

    const after = await request(app)
      .get('/api/hq/reports/revenue')
      .set('Authorization', `Bearer ${tokenHq}`)
      .expect(200);

    // Money that was handed back must not be counted as revenue.
    expect(after.body.totals.revenue).toBe('9.00');
    expect(after.body.totals.saleCount).toBe(1);
  });

  it('removes voided units from the top-items report', async () => {
    const [tokenHq, tokenA] = await Promise.all([tokens.hq(), tokens.staffA()]);

    await sell(tokenA, [{ menuItemId: IDS.latte, quantity: 2 }]).expect(201);
    const toVoid = await sell(tokenA, [{ menuItemId: IDS.muffin, quantity: 9 }]).expect(201);

    const before = await request(app)
      .get('/api/hq/reports/top-items')
      .set('Authorization', `Bearer ${tokenHq}`)
      .expect(200);
    expect(before.body.outlets[0].items[0].itemName).toBe('Muffin');

    await voidSale(tokenA, toVoid.body.sale.id).expect(200);

    const after = await request(app)
      .get('/api/hq/reports/top-items')
      .set('Authorization', `Bearer ${tokenHq}`)
      .expect(200);

    const outletA = after.body.outlets.find((o) => o.outletCode === 'AAA');
    expect(outletA.items).toHaveLength(1);
    expect(outletA.items[0].itemName).toBe('Latte');
  });
});
