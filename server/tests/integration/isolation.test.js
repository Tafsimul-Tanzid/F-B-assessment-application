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
 * "Each outlet should be able to retrieve only the menu items assigned to that
 * outlet" — asserted here as an access-control property, not just a filter.
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

describe('per-outlet isolation', () => {
  it('returns only the items assigned to the caller\'s own outlet', async () => {
    const [tokenA, tokenB] = await Promise.all([tokens.staffA(), tokens.staffB()]);

    const menuA = await request(app)
      .get('/api/outlet/menu')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);

    const menuB = await request(app)
      .get('/api/outlet/menu')
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(200);

    expect(menuA.body.menu.map((m) => m.sku).sort()).toEqual(['CRO', 'LAT', 'MUF']);
    expect(menuB.body.menu.map((m) => m.sku)).toEqual(['LAT']);

    // The scope comes from the token, so the response is about the caller's
    // own outlet whatever the caller might have wanted.
    expect(menuA.body.outletId).toBe(IDS.outletA);
    expect(menuB.body.outletId).toBe(IDS.outletB);
  });

  it('refuses to sell an item the outlet does not carry', async () => {
    const tokenB = await tokens.staffB();

    // The croissant exists in the master menu and is stocked at outlet A, but
    // outlet B has no assignment for it.
    const response = await request(app)
      .post('/api/outlet/sales')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ items: [{ menuItemId: IDS.croissant, quantity: 1 }] })
      .expect(422);

    expect(response.body.error.code).toBe('ITEM_NOT_ON_MENU');
  });

  it('does not expose another outlet\'s receipt', async () => {
    const [tokenA, tokenB] = await Promise.all([tokens.staffA(), tokens.staffB()]);

    const created = await request(app)
      .post('/api/outlet/sales')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ items: [{ menuItemId: IDS.latte, quantity: 1 }] })
      .expect(201);

    const saleId = created.body.sale.id;

    // Outlet A can reprint its own receipt.
    await request(app)
      .get(`/api/outlet/sales/${saleId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);

    // Outlet B, holding a valid token and the exact sale id, cannot.
    await request(app)
      .get(`/api/outlet/sales/${saleId}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(404);
  });

  it('keeps each outlet\'s sales list to its own sales', async () => {
    const [tokenA, tokenB] = await Promise.all([tokens.staffA(), tokens.staffB()]);

    await request(app)
      .post('/api/outlet/sales')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ items: [{ menuItemId: IDS.latte, quantity: 1 }] })
      .expect(201);

    const listB = await request(app)
      .get('/api/outlet/sales')
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(200);

    expect(listB.body.sales).toHaveLength(0);
  });
});

describe('role separation', () => {
  it('refuses outlet staff on HQ routes', async () => {
    const tokenA = await tokens.staffA();

    const response = await request(app)
      .get('/api/hq/outlets')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(403);

    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('refuses HQ on outlet-scoped routes, which have no outlet to act as', async () => {
    const tokenHq = await tokens.hq();

    await request(app).get('/api/outlet/menu').set('Authorization', `Bearer ${tokenHq}`).expect(403);
  });

  it('rejects an unsigned or tampered token', async () => {
    const tokenA = await tokens.staffA();
    const tampered = `${tokenA.slice(0, -4)}AAAA`;

    await request(app).get('/api/outlet/menu').set('Authorization', `Bearer ${tampered}`).expect(401);
    await request(app).get('/api/outlet/menu').expect(401);
  });
});
