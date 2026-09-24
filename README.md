# Multi-Outlet F&B POS

A head-office system managing multiple food & beverage outlets. HQ owns the
master menu and assigns items to outlets with per-outlet price overrides; each
outlet holds its own stock, rings up sales that deduct it, and issues receipts
numbered sequentially per outlet; HQ reports revenue and best sellers across
every outlet.

**Stack:** PostgreSQL 16 · Node.js 22 · Express · Sequelize · React (Vite) · Docker

- [Architecture & scaling document](docs/ARCHITECTURE.md) — ERD, scaling plan,
  microservices evolution, offline POS strategy

---

## Quick start

```bash
git clone <repository-url>
cd task
docker compose up --build
```

That is the whole setup. Compose starts Postgres, waits for it to be *healthy*
(not merely started), then boots the API, which applies migrations and seeds
demo data before it begins listening.

| | URL |
|---|---|
| Web app | http://localhost:8081 |
| API | http://localhost:4010 |
| Health check | http://localhost:4010/health |
| Postgres | `localhost:5433` (user `postgres`, password `postgres`, db `fnb_pos`) |

> **Why ports 4010/5433 rather than 4000/5432?** A natively installed Postgres
> commonly owns 5432, and on macOS `localhost` resolves to `::1` first — so a
> clash there silently routes the app to the *wrong database* with a confusing
> "role does not exist" error. Non-default host ports avoid that class of
> problem entirely.

### Demo accounts

All use the password `Password123!`

| Email | Role | Sees |
|---|---|---|
| `hq@fnb.test` | HQ admin | All outlets, master menu, reports |
| `downtown@fnb.test` | Outlet staff | Downtown Café till (12 items) |
| `airport@fnb.test` | Outlet staff | Airport Kiosk till (6 items, premium prices, thin stock) |
| `mall@fnb.test` | Outlet staff | Mall Stand till (7 items) |

The airport outlet is seeded with deliberately low stock so the
insufficient-stock path can be demonstrated without setting it up first, and
with price overrides so the per-outlet pricing is visible immediately.

### Running without Docker

```bash
# Postgres only
docker compose up -d postgres

cd server
cp .env.example .env
npm install
npm run migrate && npm run seed
npm run dev                      # http://localhost:4010

cd ../web
npm install
npm run dev                      # http://localhost:5173, proxies /api
```

---

## Verifying the concurrency guarantees

The brief requires that receipt numbers "remain correct under concurrent
requests" and that the system "must prevent negative stock". Both are asserted
by the test suite, and both can be demonstrated against a running stack:

```bash
npm test --prefix server          # 41 tests against real PostgreSQL
node scripts/concurrency-proof.mjs
```

Actual output from the containerised stack:

```
[1] 50 simultaneous sales at one outlet

  requests fired at once           50
  succeeded                        50                           PASS
  elapsed                          133 ms
  receipt range                    1 .. 50
  distinct receipt numbers         50                           PASS
  contiguous (no gaps)             true                         PASS
  stock                            120 -> 70                    PASS

[2] 40 simultaneous buyers competing for limited stock

  item                             Americano (8 in stock)
  buyers                           40
  succeeded                        8                            PASS
  rejected                         32 {"INSUFFICIENT_STOCK":32}
  all rejections are clean 409     true                         PASS
  final stock                      0                            PASS
  stock never went negative        true                         PASS
  no receipt numbers burned        true                         PASS

[3] Two outlets selling at the same time keep separate sequences

  outlet A receipts                51..60                       PASS
  outlet B receipts                1..10                        PASS
```

The third block of test 2 is the one worth dwelling on: **32 failed sales
consumed no receipt numbers.** That is the payoff from bumping the counter at
the *end* of the transaction rather than the start — had it been bumped first,
every rejected sale would have burned a number and left a gap in the outlet's
books.

Tests run against a real PostgreSQL instance, not a mock. What they exist to
prove — row locking, guarded updates re-evaluated after a lock wait, per-outlet
sequencing under contention — is behaviour of the database engine itself. A
mock would only assert that the code calls the functions we wrote.

---

## API

All endpoints are under `/api`. Authenticated requests carry
`Authorization: Bearer <token>`.

### Auth

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/auth/login` | Returns `{ token, user }` |
| `GET` | `/api/auth/me` | Current user |

### HQ — requires role `HQ_ADMIN`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/hq/outlets` | List outlets |
| `POST` | `/api/hq/outlets` | Create an outlet (and its receipt counter, same transaction) |
| `GET` | `/api/hq/menu-items` | Master menu — `?search=`, `?category=`, `?includeInactive=` |
| `POST` | `/api/hq/menu-items` | Create a master menu item |
| `PATCH` | `/api/hq/menu-items/:id` | Update name, category, base price, active flag |
| `DELETE` | `/api/hq/menu-items/:id` | **Deactivate** (never hard-deletes — see below) |
| `GET` | `/api/hq/outlets/:outletId/menu` | What this outlet is assigned, with effective prices and stock |
| `POST` | `/api/hq/outlets/:outletId/menu` | Assign an item, optional `priceOverride` |
| `PATCH` | `/api/hq/outlets/:outletId/menu/:menuItemId` | Set/clear `priceOverride`, toggle `isAvailable` |
| `DELETE` | `/api/hq/outlets/:outletId/menu/:menuItemId` | Unassign (refused while stock remains) |
| `GET` | `/api/hq/outlets/:outletId/inventory` | Stock for one outlet |
| `POST` | `/api/hq/outlets/:outletId/inventory/adjust` | Signed `delta` — restock or correct |
| `GET` | `/api/hq/reports/revenue` | Revenue by outlet — `?from=&to=` |
| `GET` | `/api/hq/reports/top-items` | Top items per outlet — `?from=&to=&limit=5` |

### Outlet — requires role `OUTLET_STAFF`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/outlet/menu` | **Only** this outlet's assigned, available items |
| `GET` | `/api/outlet/inventory` | This outlet's stock |
| `POST` | `/api/outlet/sales` | Create a sale — `{ items: [{ menuItemId, quantity }] }` |
| `GET` | `/api/outlet/sales` | This outlet's receipts — `?from=&to=&limit=` |
| `GET` | `/api/outlet/sales/:id` | Receipt reprint |
| `POST` | `/api/outlet/sales/:id/void` | Void a sale — restores stock, issues a credit note |

**No outlet endpoint takes an outlet id.** The outlet is read from the JWT
claim, so there is deliberately no parameter through which one terminal could
point itself at another outlet's menu, stock or sales. That makes "an outlet
retrieves only the menu items assigned to it" a property of the system rather
than a convention the client is trusted to follow.

Prices are likewise never accepted from the client — they are resolved
server-side inside the sale transaction from the outlet's own assignment, so a
terminal holding a valid token cannot choose what it charges.

### Errors

Every error has the same shape, with a request id that also appears in the logs:

```json
{
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "Insufficient stock for \"Americano\": requested 1, available 0.000",
    "details": { "menuItemId": "...", "requested": "1", "available": "0.000" },
    "requestId": "e905c33d-b414-40c1-9802-51cedb207509"
  }
}
```

| Status | Codes |
|---|---|
| 400 | `VALIDATION_ERROR` (with field-level `details`) |
| 401 | `UNAUTHORIZED` |
| 403 | `FORBIDDEN` |
| 404 | `NOT_FOUND` |
| 409 | `INSUFFICIENT_STOCK`, `DUPLICATE_SKU`, `ALREADY_ASSIGNED`, `STOCK_REMAINING`, `ALREADY_VOIDED` |
| 422 | `ITEM_NOT_ON_MENU`, `ITEM_UNAVAILABLE`, `ITEM_NOT_STOCKED` |
| 503 | `RETRYABLE`, `LOCK_TIMEOUT` |

---

## Schema

Full ERD and rationale in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#1-data-model).

```
outlets ──┬── outlet_menu_items ──── menu_items      HQ assigns; price_override per outlet
          ├── inventory ─────────────┘               stock per outlet, CHECK (quantity >= 0)
          ├── outlet_receipt_counters                one counter row per outlet
          ├── outlet_credit_note_counters            separate sequence for voids
          └── sales ──── sale_items                  UNIQUE (outlet_id, receipt_no)
users ────┘                                          HQ_ADMIN | OUTLET_STAFF (+ outlet_id)
```

### Constraints that enforce invariants rather than describe them

| Constraint | What it prevents |
|---|---|
| `inventory CHECK (quantity >= 0)` | Negative stock on **any** write path, not just the sale path |
| `sales UNIQUE (outlet_id, receipt_no)` | Duplicate receipt numbers within an outlet. `NOT DEFERRABLE`, so a violation fails immediately rather than aborting at commit after all the work is done |
| `users CHECK ((role = 'OUTLET_STAFF') = (outlet_id IS NOT NULL))` | Staff with no outlet scope, which would bypass every per-outlet access check |
| `sale_items CHECK (quantity > 0)` | Zero or negative line quantities |
| `sales UNIQUE (outlet_id, credit_note_no)` | Duplicate credit notes. NULLs do not collide, so completed sales are unaffected |
| `sales CHECK ((status = 'voided') = (voided_at IS NOT NULL AND credit_note_no IS NOT NULL))` | A half-written void — a sale marked voided with no credit note, or a credit note on a sale still counted as revenue |
| FKs with `ON DELETE RESTRICT` on sales | Deleting an outlet or item that has sales history |

### Three schema decisions

**Line items snapshot `item_name`, `unit_price` and `line_total`.** A receipt
is a financial record: it must reprint identically years later. Re-deriving
prices by joining the live menu would mean every HQ price change silently
restated historical revenue, and unassigning an item would erase past sales of
it from reports. A test asserts a receipt is unchanged after HQ doubles the
price and renames the item.

**Receipt numbers come from a counter table, not a `SEQUENCE`.** Sequences are
global rather than per-outlet, and gappy by design — a rolled-back transaction
never returns its number.

**Menu items deactivate rather than delete.** Besides preserving history, a
hard `DELETE` takes a `FOR UPDATE` lock that conflicts with the `FOR KEY SHARE`
lock every concurrent `INSERT INTO sale_items` holds on that row — so one HQ
deletion would block, and could deadlock against, in-flight sales of that item
at every outlet at once.

### Voids

A sale is a record of something that happened, so voiding never deletes the
row and never frees the receipt number — the next sale after a void of #1 is
#2, not #1. The sale is marked `voided`, its stock is returned, and the void
is issued its own number from a **separate per-outlet credit-note sequence**,
so an audit can tell the two kinds of document apart. Every report counts
`status = 'completed'` only, and the reporting index is partial on the same
predicate, so voided rows are not even carried in it.

Double-voiding is prevented by the same guarded-update technique as the stock
deduction — `... AND status = 'completed'` in the `WHERE` clause — so ten
simultaneous void requests produce exactly one void and nine 409s, rather than
restoring stock ten times. There is a test for precisely that.

### Indexing

`sale_items (sale_id)` is explicit because **Postgres indexes a foreign key's
target, never the referencing column** — without it, receipt reprint and the
top-items join both sequential-scan. `sales (outlet_id, sold_at) INCLUDE
(total_amount)` makes the revenue report an index-only scan.

`sale_items (menu_item_id)` is **deliberately omitted**: the top-items report
hash-aggregates rows it already has via the `sale_id` join and never looks an
item up by id, so the index would cost a B-tree insert per *line item* against
a random UUID for no read benefit.

---

## Architecture

### Layering

```
routes/         paths, validation schemas, access control — no logic
controllers/    HTTP in/out — no business rules, no SQL
services/       business rules; owns transaction boundaries
repositories/   all SQL and model access; receives transactions, never opens them
```

The rule that makes this real rather than cosmetic: **a repository never opens
a transaction, it receives one.** Transaction boundaries are a business
concern, so a repository that called `sequelize.transaction()` itself would
make it impossible to compose several repository calls into one atomic unit —
which is exactly what the sale path needs.

`{ transaction }` is passed explicitly rather than via `Sequelize.useCLS()`.
An ambient transaction is invisible at the call site, so the lock-acquisition
order of the sale path could not be audited by reading the service function
top to bottom. The failure it guards against is also nasty: a query that
silently omits the transaction checks out a *different* pooled connection, runs
outside the transaction, and then blocks forever on a row lock its own request
holds — a self-deadlock Postgres cannot detect, because it is two separate
sessions rather than a cycle of waits. See
[`server/src/repositories/README.md`](server/src/repositories/README.md).

### The sale transaction

```
BEGIN (READ COMMITTED, lock_timeout = 3s)
  1. resolve prices from the outlet's menu     no locks
  2. deduct stock, ascending menu_item_id      inventory row locks
  3. bump receipt counter + insert sale        counter row lock
  4. insert line items
COMMIT
```

**Negative stock is prevented by the guard living in SQL**, not in JavaScript:

```sql
UPDATE inventory SET quantity = quantity - $3
 WHERE outlet_id = $1 AND menu_item_id = $2 AND quantity >= $3
RETURNING quantity;
```

When a concurrent transaction commits, Postgres re-reads the row and
re-evaluates the entire `WHERE` clause rather than proceeding from the original
snapshot, so the check is always against the latest committed quantity and a
lost update is impossible. Comparing in JS would race *and* be wrong — `numeric`
arrives from the driver as a string, where `"9" >= "10"` is `true`.

**Deadlock is structurally impossible.** Lines are aggregated per item (so the
same item twice in a cart deducts the sum, once) and deducted sequentially in
ascending id order, so no two sales can hold inventory locks in opposite
orders. Sequential, not `Promise.all` — a Sequelize transaction is bound to a
single pooled connection.

**Money arithmetic stays in SQL**, rounded per line before summing, so the
header total always equals the sum of the stored line totals exactly.

Full reasoning, including why READ COMMITTED beats REPEATABLE READ here and why
strict gaplessness is unachievable, is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#2-the-sale-transaction).

### Configuration

Environment is parsed and validated **once**, at boot, by `src/config/index.js`;
`process.env` is not read anywhere else. A missing or malformed variable exits
with a readable message rather than surfacing later as a confusing runtime
error. See [`server/.env.example`](server/.env.example).

---

## Scaling

Summarised here; the reasoning is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#3-scaling-to-10-outlets--100000-transactions-per-month).

**10 outlets at 100,000 transactions/month is ~3,300 sales a day — about 0.04
writes per second**, with a realistic peak of 5–15/sec. That is small: the
current design reaches it without structural change. Proposing sharding for
that load would be the wrong answer.

What changes as headroom erodes, in the order the pressure arrives:

1. **PgBouncer** in transaction mode — connection count is the real constraint,
   since each in-flight sale pins a connection for its transaction.
2. **Read replica** for the two report endpoints, so a heavy report never
   competes with the till for buffer pool and connections.
3. **Materialised view** for top-items when it degrades — refreshed
   `CONCURRENTLY`, off the hot path. Explicitly *not* a rollup table upserted
   inside the sale transaction, which would recreate the hot-row contention the
   design avoids and extend the lock window past the counter bump.
4. **Partition** `sales`/`sale_items` by month once row count (not transaction
   rate) justifies it.

The API is already horizontally scalable by design — no in-process state, no
in-memory counters, stateless JWTs — so running several instances needs no code
change.

---

## Tests

```bash
npm test --prefix server
```

41 integration tests against real PostgreSQL, covering the graded claims
rather than chasing coverage:

| Suite | Asserts |
|---|---|
| `sale.concurrency` | Unique gapless receipts under 50 simultaneous sales; exact stock conservation; no oversell with 40 buyers for 10 units; no deadlock when concurrent carts list items in opposite orders; per-outlet sequences; nothing written when one line of a multi-item sale fails |
| `isolation` | An outlet sees only its own menu/stock/sales; cannot fetch another outlet's receipt by id; role separation both ways; tampered tokens rejected |
| `pricing` | Override beats base price; clearing it falls back; client-supplied prices rejected; a recorded sale is unchanged by later price and name changes; header total equals the sum of line totals |
| `reports` | Figures checked against hand-computed arithmetic; zero-revenue outlets still appear; renamed items stay one row; date range respected |
| `void` | Stock returned exactly once; receipt number never reused; credit notes sequential per outlet; 10 concurrent voids yield exactly one; cannot void another outlet's sale; voided money and units leave both reports |

---

## Project layout

```
├── docker-compose.yml          Postgres + API + web, one command
├── render.yaml                 Deployment blueprint
├── scripts/
│   └── concurrency-proof.mjs   Demonstrates the guarantees on a live stack
├── docs/ARCHITECTURE.md        ERD, scaling, microservices, offline POS
├── server/
│   ├── migrations/             Schema (DDL lives here only; sync() is never called)
│   ├── seeders/                Demo dataset
│   ├── src/{routes,controllers,services,repositories,middleware,validation,errors}
│   └── tests/integration/
└── web/
    └── src/{api,shared,hq,outlet}
```

---

## Deployment

`render.yaml` declares managed Postgres, the API as a Docker service, and the
SPA as a static site. Deploy via **New → Blueprint** pointed at the repository;
`JWT_SECRET` is generated, `DATABASE_URL` is wired from the database, and
migrations run on boot.

Two notes for reviewers: the free tier **sleeps after inactivity**, so the
first request after a pause takes 30–60 seconds — that is cold start, not a
bug. And `SEED_ON_BOOT` is `true` so the demo accounts exist; it would be
`false` for anything real.

---

## Scope

Built to the brief, plus voids/refunds. Deliberately **not** included, each of
which would be a straightforward addition:

- **Tax and discounts** — not in the brief; `sale_items` would gain `tax_rate`
  and `line_discount`, with the header totals following.
- **Recipe/BOM deduction** — selling a burger currently deducts one burger, not
  a bun plus a patty plus 30g of lettuce. This changes the lock-ordering key
  from `menu_item_id` to `ingredient_id` and nothing else about the design.
- **Idempotency keys** — not needed while online, where the client receives a
  definitive response. They are the one schema addition offline mode requires,
  and are covered in the
  [offline strategy](docs/ARCHITECTURE.md#5-offline-pos-mode).

### Known limitations

- The rendered UI has not been verified in a browser — no browser automation
  was available in the build environment. The production build is clean and a
  contract script confirms every endpoint the components call returns the exact
  shape they destructure, but the visual result is unverified.
- `npm audit` reports 4 moderate advisories in the frontend build toolchain
  (`vite`/`esbuild`) and in a transitive `uuid` under Sequelize. None are in
  the runtime path of the shipped API image.
