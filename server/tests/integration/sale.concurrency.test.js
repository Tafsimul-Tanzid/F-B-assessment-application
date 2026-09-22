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
 * The requirements say a receipt number must "remain correct under concurrent
 * requests" and that the system "must prevent negative stock". These tests are
 * the evidence for both claims, run against a real PostgreSQL instance so the
 * locking behaviour being relied on is genuinely exercised.
 */

const sale = (token, items) =>
  request(app).post('/api/outlet/sales').set('Authorization', `Bearer ${token}`).send({ items });

beforeAll(async () => {
  await migrateOnce();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await resetDatabase();
});

describe('concurrent sales at one outlet', () => {
  it('issues unique, gapless receipt numbers to 50 simultaneous sales', async () => {
    const token = await tokens.staffA();

    const responses = await Promise.all(
      Array.from({ length: 50 }, () => sale(token, [{ menuItemId: IDS.latte, quantity: 1 }])),
    );

    expect(responses.every((r) => r.status === 201)).toBe(true);

    const receipts = responses.map((r) => Number(r.body.sale.receiptNo)).sort((a, b) => a - b);

    // No duplicates: two sales sharing a receipt number would make the
    // receipt meaningless as a reference.
    expect(new Set(receipts).size).toBe(50);

    // Sequential per outlet, starting at 1.
    expect(receipts).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it('deducts stock exactly once per sale under concurrency', async () => {
    const token = await tokens.staffA();
    const before = await stockOf(IDS.outletA, IDS.latte);

    await Promise.all(
      Array.from({ length: 40 }, () => sale(token, [{ menuItemId: IDS.latte, quantity: 2 }])),
    );

    // 40 sales x 2 units. A lost update would leave stock higher than this.
    expect(await stockOf(IDS.outletA, IDS.latte)).toBe(before - 80);
  });

  it('never oversells: 40 simultaneous buyers competing for 10 units', async () => {
    const token = await tokens.staffB(); // outlet B holds exactly 10 lattes

    const responses = await Promise.all(
      Array.from({ length: 40 }, () => sale(token, [{ menuItemId: IDS.latte, quantity: 1 }])),
    );

    const succeeded = responses.filter((r) => r.status === 201);
    const rejected = responses.filter((r) => r.status !== 201);

    expect(succeeded).toHaveLength(10);
    expect(rejected).toHaveLength(30);

    // Rejections are a clean, specific 409 — not a 500 from a constraint
    // violation leaking out of the database.
    expect(rejected.every((r) => r.status === 409)).toBe(true);
    expect(rejected.every((r) => r.body.error.code === 'INSUFFICIENT_STOCK')).toBe(true);

    expect(await stockOf(IDS.outletB, IDS.latte)).toBe(0);

    // The 30 failures burned no receipt numbers. This is what bumping the
    // counter at the END of the transaction buys: had it been bumped first,
    // every rejected sale would have consumed a number and left a gap.
    const receipts = succeeded.map((r) => Number(r.body.sale.receiptNo)).sort((a, b) => a - b);
    expect(receipts).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('does not deadlock when concurrent multi-item sales list items in opposite orders', async () => {
    const token = await tokens.staffA();

    // Deliberately adversarial: half the carts list latte then muffin, half
    // list muffin then latte. Without a canonical lock order this is the
    // textbook deadlock, and Postgres would abort one side with 40P01.
    const forward = [
      { menuItemId: IDS.latte, quantity: 1 },
      { menuItemId: IDS.muffin, quantity: 1 },
    ];
    const reverse = [
      { menuItemId: IDS.muffin, quantity: 1 },
      { menuItemId: IDS.latte, quantity: 1 },
    ];

    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) => sale(token, i % 2 === 0 ? forward : reverse)),
    );

    expect(responses.every((r) => r.status === 201)).toBe(true);
    expect(await stockOf(IDS.outletA, IDS.latte)).toBe(80);
    expect(await stockOf(IDS.outletA, IDS.muffin)).toBe(0);
  });

  it('keeps each outlet on its own receipt sequence when both sell at once', async () => {
    const [tokenA, tokenB] = await Promise.all([tokens.staffA(), tokens.staffB()]);

    const responses = await Promise.all([
      ...Array.from({ length: 10 }, () => sale(tokenA, [{ menuItemId: IDS.latte, quantity: 1 }])),
      ...Array.from({ length: 10 }, () => sale(tokenB, [{ menuItemId: IDS.latte, quantity: 1 }])),
    ]);

    expect(responses.every((r) => r.status === 201)).toBe(true);

    const receiptsA = responses.slice(0, 10).map((r) => Number(r.body.sale.receiptNo)).sort((a, b) => a - b);
    const receiptsB = responses.slice(10).map((r) => Number(r.body.sale.receiptNo)).sort((a, b) => a - b);

    // Both outlets independently number 1..10. A shared sequence would have
    // produced 1..20 split arbitrarily between them.
    expect(receiptsA).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    expect(receiptsB).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
  });
});

describe('sale atomicity', () => {
  it('writes nothing at all when one line of a multi-item sale fails', async () => {
    const token = await tokens.staffA();

    const response = await sale(token, [
      { menuItemId: IDS.latte, quantity: 2 },
      { menuItemId: IDS.muffin, quantity: 999 }, // only 20 in stock
    ]);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('INSUFFICIENT_STOCK');

    // The latte deduction that had already succeeded must be rolled back.
    expect(await stockOf(IDS.outletA, IDS.latte)).toBe(100);
    expect(await stockOf(IDS.outletA, IDS.muffin)).toBe(20);

    const list = await request(app)
      .get('/api/outlet/sales')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.sales).toHaveLength(0);
  });

  it('does not consume a receipt number for a failed sale', async () => {
    const token = await tokens.staffA();

    await sale(token, [{ menuItemId: IDS.muffin, quantity: 999 }]).expect(409);

    // The next successful sale still gets receipt 1.
    const ok = await sale(token, [{ menuItemId: IDS.latte, quantity: 1 }]).expect(201);
    expect(Number(ok.body.sale.receiptNo)).toBe(1);
  });
});
