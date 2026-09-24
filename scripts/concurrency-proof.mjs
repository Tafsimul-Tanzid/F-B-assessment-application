#!/usr/bin/env node
/**
 * Concurrency proof.
 *
 * The brief requires that a receipt number "remain correct under concurrent
 * requests" and that the system "must prevent negative stock". The automated
 * suite (`npm test` in server/) asserts both; this script demonstrates them
 * against a RUNNING stack so the behaviour can be observed rather than taken
 * on trust.
 *
 *   node scripts/concurrency-proof.mjs [baseUrl]
 *
 * Defaults to http://localhost:4010 and the seeded demo data.
 */
const BASE = process.argv[2] ?? 'http://localhost:4010';
const PASSWORD = 'Password123!';

const login = async (email) => {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!response.ok) throw new Error(`Login failed for ${email} (${response.status})`);
  return (await response.json()).token;
};

const authFor = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

const menuOf = async (token) =>
  (await (await fetch(`${BASE}/api/outlet/menu`, { headers: authFor(token) })).json()).menu;

const sell = (token, menuItemId, quantity = 1) =>
  fetch(`${BASE}/api/outlet/sales`, {
    method: 'POST',
    headers: authFor(token),
    body: JSON.stringify({ items: [{ menuItemId, quantity }] }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

const line = (label, value, verdict) =>
  console.log(`  ${label.padEnd(32)} ${String(value).padEnd(28)} ${verdict ?? ''}`);

const mark = (ok) => (ok ? 'PASS' : '*** FAIL ***');

let failures = 0;
const assert = (ok) => { if (!ok) failures += 1; return mark(ok); };

// --- Test 1: simultaneous sales get unique, gapless receipt numbers --------

async function receiptRace() {
  console.log('\n[1] 50 simultaneous sales at one outlet\n');

  const token = await login('downtown@fnb.test');
  const menu = await menuOf(token);
  const item = menu.find((m) => Number(m.stock) >= 50);
  if (!item) throw new Error('Need an item with at least 50 in stock; re-seed the database.');

  const stockBefore = Number(item.stock);

  const started = Date.now();
  const responses = await Promise.all(Array.from({ length: 50 }, () => sell(token, item.menuItemId)));
  const elapsed = Date.now() - started;

  const ok = responses.filter((r) => r.status === 201);
  const receipts = ok.map((r) => Number(r.body.sale.receiptNo)).sort((a, b) => a - b);
  const distinct = new Set(receipts).size;
  const contiguous = receipts.length > 0 && receipts.at(-1) - receipts[0] + 1 === receipts.length;

  const stockAfter = Number((await menuOf(token)).find((m) => m.menuItemId === item.menuItemId).stock);

  line('item', item.name);
  line('requests fired at once', 50);
  line('succeeded', ok.length, assert(ok.length === 50));
  line('elapsed', `${elapsed} ms`);
  line('receipt range', `${receipts[0]} .. ${receipts.at(-1)}`);
  line('distinct receipt numbers', distinct, assert(distinct === ok.length));
  line('contiguous (no gaps)', contiguous, assert(contiguous));
  line('stock', `${stockBefore} -> ${stockAfter}`, assert(stockAfter === stockBefore - ok.length));
}

// --- Test 2: more concurrent buyers than there is stock --------------------

async function oversellRace() {
  console.log('\n[2] 40 simultaneous buyers competing for limited stock\n');

  const token = await login('airport@fnb.test');
  const menu = await menuOf(token);
  const item = menu.find((m) => Number(m.stock) > 0 && Number(m.stock) <= 20);
  if (!item) throw new Error('Need an item with 1-20 in stock at the airport outlet; re-seed.');

  const available = Number(item.stock);

  const responses = await Promise.all(Array.from({ length: 40 }, () => sell(token, item.menuItemId)));
  const ok = responses.filter((r) => r.status === 201);
  const rejected = responses.filter((r) => r.status !== 201);

  const codes = {};
  for (const r of rejected) {
    const code = r.body?.error?.code ?? String(r.status);
    codes[code] = (codes[code] ?? 0) + 1;
  }

  const stockAfter = Number((await menuOf(token)).find((m) => m.menuItemId === item.menuItemId).stock);
  const receipts = ok.map((r) => Number(r.body.sale.receiptNo)).sort((a, b) => a - b);
  const contiguous = receipts.length > 0 && receipts.at(-1) - receipts[0] + 1 === receipts.length;

  line('item', `${item.name} (${available} in stock)`);
  line('buyers', 40);
  line('succeeded', ok.length, assert(ok.length === available));
  line('rejected', `${rejected.length} ${JSON.stringify(codes)}`);
  line('all rejections are clean 409', rejected.every((r) => r.status === 409), assert(rejected.every((r) => r.status === 409)));
  line('final stock', stockAfter, assert(stockAfter === 0));
  line('stock never went negative', stockAfter >= 0, assert(stockAfter >= 0));
  // The point of bumping the counter at the END of the transaction: a failed
  // sale must not consume a receipt number.
  line('no receipt numbers burned', contiguous, assert(contiguous));
  console.log(`\n  Sample rejection: ${rejected[0]?.body?.error?.message ?? 'n/a'}`);
}

// --- Test 3: each outlet keeps its own sequence ----------------------------

async function perOutletSequences() {
  console.log('\n[3] Two outlets selling at the same time keep separate sequences\n');

  const [a, b] = await Promise.all([login('downtown@fnb.test'), login('mall@fnb.test')]);
  const [menuA, menuB] = await Promise.all([menuOf(a), menuOf(b)]);

  const itemA = menuA.find((m) => Number(m.stock) >= 10);
  const itemB = menuB.find((m) => Number(m.stock) >= 10);

  const responses = await Promise.all([
    ...Array.from({ length: 10 }, () => sell(a, itemA.menuItemId)),
    ...Array.from({ length: 10 }, () => sell(b, itemB.menuItemId)),
  ]);

  const receiptsA = responses.slice(0, 10).map((r) => Number(r.body.sale.receiptNo)).sort((x, y) => x - y);
  const receiptsB = responses.slice(10).map((r) => Number(r.body.sale.receiptNo)).sort((x, y) => x - y);

  const consecutive = (list) => list.every((n, i) => i === 0 || n === list[i - 1] + 1);

  line('outlet A receipts', `${receiptsA[0]}..${receiptsA.at(-1)}`, assert(consecutive(receiptsA)));
  line('outlet B receipts', `${receiptsB[0]}..${receiptsB.at(-1)}`, assert(consecutive(receiptsB)));
  line('sequences independent', 'each outlet numbers its own', assert(consecutive(receiptsA) && consecutive(receiptsB)));
}

console.log(`Concurrency proof against ${BASE}`);
console.log('='.repeat(72));

try {
  await receiptRace();
  await oversellRace();
  await perOutletSequences();

  console.log(`\n${'='.repeat(72)}`);
  console.log(failures === 0 ? 'All checks passed.\n' : `${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
} catch (error) {
  console.error(`\nCould not run: ${error.message}`);
  console.error('Is the stack up (docker compose up) and seeded?');
  process.exit(2);
}
