# Multi-Outlet F&B POS

## Project Overview

A head-office system managing multiple food & beverage outlets. HQ owns the
master menu and assigns items to outlets with per-outlet price overrides; each
outlet holds its own stock, rings up sales that deduct it, and issues receipts
numbered sequentially per outlet; HQ reports revenue and best sellers across
every outlet.

Business flow: **Single Company → Multiple Outlets → HQ assigns menu → Outlets
create sales → HQ sees reports.**

- [docs/architecture.md](docs/architecture.md) — system overview, request
  flow, frontend/backend architecture, database design, authentication,
  authorization, transaction and concurrency strategy, error handling,
  validation
- [docs/scaling.md](docs/scaling.md) — database, reporting, infrastructure
  and architectural evolution to 10 outlets / 100,000 transactions a month
- [docs/microservices.md](docs/microservices.md) — how this could evolve into
  services, and why it should not yet
- [docs/offline-pos.md](docs/offline-pos.md) — offline POS terminal strategy
  (design document; not implemented)
- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) — every line of the brief,
  mapped to where it is implemented and where it is proven

---

## Features

- **Master menu + outlet assignment** — HQ creates menu items, assigns them to
  specific outlets, and can override the price per outlet
- **Outlet-scoped menu retrieval** — an outlet sees only what is assigned to
  it, at its own effective price; enforced by the JWT claim, not by convention
- **Per-outlet inventory** — stock tracked per outlet, deducted on sale, and
  structurally prevented from going negative even under concurrent requests
- **Transactional multi-item sales** — validate, price, deduct stock, allocate
  a receipt number and record the sale in one database transaction; any
  failure rolls back everything
- **Sequential per-outlet receipt numbers** — safe under concurrency by
  construction, not by locking convention alone (see
  [docs/architecture.md § 9](docs/architecture.md#9-transaction-strategy-inventory-concurrency-and-receipt-numbering))
- **Voids with credit notes** — a voided sale restores stock and is numbered
  from its own sequence; the original receipt number is never reused
- **Reporting** — total revenue by outlet, top 5 selling items per outlet
- **Role-based access** — HQ admin vs. outlet staff, enforced server-side on
  every request

---

## Tech Stack

| Layer | Choice |
|---|---|
| Database | PostgreSQL 16 |
| Backend | Node.js 22, Express 4, Sequelize 6 |
| Validation | Zod |
| Auth | JWT (jsonwebtoken), bcrypt |
| Frontend | React 18, Vite, TanStack Query, React Router |
| Testing | Vitest, Supertest |
| Containerization | Docker, docker-compose |

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

Full reasoning, including why READ COMMITTED beats REPEATABLE READ here, why
strict gaplessness is unachievable, and how a forced post-deduction failure
still rolls back completely, is in
[docs/architecture.md § 9](docs/architecture.md#9-transaction-strategy-inventory-concurrency-and-receipt-numbering).

### Configuration

Environment is parsed and validated **once**, at boot, by `src/config/index.js`;
`process.env` is not read anywhere else. A missing or malformed variable exits
with a readable message rather than surfacing later as a confusing runtime
error.

---

## Folder Structure

```
├── docker-compose.yml          Postgres + API + web, one command
├── render.yaml                 Deployment blueprint
├── scripts/
│   └── concurrency-proof.mjs   Demonstrates the guarantees on a live stack
├── docs/                       architecture.md, scaling.md, microservices.md,
│                                offline-pos.md, REQUIREMENTS.md
├── server/
│   ├── migrations/             Schema (DDL lives here only; sync() is never called)
│   ├── seeders/                Demo dataset
│   ├── src/{routes,controllers,services,repositories,middleware,validation,errors}
│   └── tests/integration/
└── web/
    └── src/{api,shared,hq,outlet}
```

---

## Database Schema

Full ERD and rationale in [docs/architecture.md § 5](docs/architecture.md#5-database-architecture).

```
companies ── outlets ──┬── outlet_menu_items ──── menu_items   HQ assigns; price_override per outlet
                        ├── inventory ─────────────┘            stock per outlet, CHECK (quantity >= 0)
                        ├── outlet_receipt_counters             one counter row per outlet
                        ├── outlet_credit_note_counters         separate sequence for voids
                        └── sales ──── sale_items               UNIQUE (outlet_id, receipt_no)
                   users ┘                                      HQ_ADMIN | OUTLET_STAFF (+ outlet_id)
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
| `outlets.company_id NOT NULL` FK | An outlet existing without belonging to the (single) company |
| FKs with `ON DELETE RESTRICT` on sales | Deleting an outlet or item that has sales history |

### Schema decisions

**A single `companies` row, referenced by every outlet.** The scenario is
explicitly one company operating multiple outlets, so this is a plain foreign
key rather than a many-to-many table — there is no relationship to model
beyond "every outlet belongs to the one company."

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
(total_amount) WHERE status = 'completed'` makes the revenue report an
index-only scan.

`sale_items (menu_item_id)` is **deliberately omitted**: the top-items report
hash-aggregates rows it already has via the `sale_id` join and never looks an
item up by id, so the index would cost a B-tree insert per *line item* against
a random UUID for no read benefit.

---

## ERD

```mermaid
erDiagram
    COMPANIES ||--o{ OUTLETS : "operates"
    OUTLETS ||--o{ USERS : "employs"
    OUTLETS ||--o{ OUTLET_MENU_ITEMS : "is assigned"
    OUTLETS ||--o{ INVENTORY : "holds stock in"
    OUTLETS ||--|| OUTLET_RECEIPT_COUNTERS : "numbers receipts with"
    OUTLETS ||--|| OUTLET_CREDIT_NOTE_COUNTERS : "numbers voids with"
    OUTLETS ||--o{ SALES : "rings up"

    MENU_ITEMS ||--o{ OUTLET_MENU_ITEMS : "is assigned to"
    MENU_ITEMS ||--o{ INVENTORY : "is stocked as"
    MENU_ITEMS ||--o{ SALE_ITEMS : "referenced by"

    SALES ||--|{ SALE_ITEMS : "contains"
    USERS ||--o{ SALES : "rung up by"

    COMPANIES {
        uuid id PK
        text name UK
    }
    OUTLETS {
        uuid id PK
        uuid company_id FK
        text code UK
        text name
    }
    USERS {
        uuid id PK
        text email UK
        text role "HQ_ADMIN | OUTLET_STAFF"
        uuid outlet_id FK
    }
    MENU_ITEMS {
        uuid id PK
        text sku UK
        text name
        numeric base_price
    }
    OUTLET_MENU_ITEMS {
        uuid outlet_id PK_FK
        uuid menu_item_id PK_FK
        numeric price_override "NULL = inherit base_price"
    }
    INVENTORY {
        uuid outlet_id PK_FK
        uuid menu_item_id PK_FK
        numeric quantity "CHECK (quantity >= 0)"
    }
    OUTLET_RECEIPT_COUNTERS {
        uuid outlet_id PK_FK
        bigint last_receipt_no
    }
    OUTLET_CREDIT_NOTE_COUNTERS {
        uuid outlet_id PK_FK
        bigint last_credit_note_no
    }
    SALES {
        uuid id PK
        uuid outlet_id FK
        bigint receipt_no "UNIQUE per outlet"
        numeric total_amount
        text status "completed | voided"
        bigint credit_note_no
    }
    SALE_ITEMS {
        uuid id PK
        uuid sale_id FK
        uuid menu_item_id FK
        text item_name "SNAPSHOT"
        numeric unit_price "SNAPSHOT"
        numeric line_total "SNAPSHOT"
    }
```

The full ERD with every column and its type is in
[docs/architecture.md § 6](docs/architecture.md#6-erd) — this is a trimmed
version for a quick read; both are generated from the same schema, not drawn
by hand, so neither can drift from the actual migrations.

---

## API Documentation

All endpoints are under `/api`. Authenticated requests carry
`Authorization: Bearer <token>`.

### Auth

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/auth/login` | none | Log in |
| `GET` | `/api/auth/me` | any role | Current user |

**`POST /api/auth/login`**

Request:
```json
{ "email": "hq@fnb.test", "password": "Password123!" }
```

Response `200`:
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": { "id": "...", "email": "hq@fnb.test", "fullName": "HQ Admin", "role": "HQ_ADMIN", "outletId": null }
}
```

Errors: `400 VALIDATION_ERROR` (malformed body), `401 UNAUTHORIZED` (wrong
email or password — one generic message for both, so the response cannot be
used to enumerate valid accounts).

### HQ — requires role `HQ_ADMIN`

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/hq/outlets` | List outlets |
| `POST` | `/api/hq/outlets` | Create an outlet (and its receipt/credit-note counters, same transaction) |
| `GET` | `/api/hq/menu-items` | Master menu — `?search=`, `?category=`, `?includeInactive=` |
| `POST` | `/api/hq/menu-items` | Create a master menu item |
| `PATCH` | `/api/hq/menu-items/:id` | Update name, category, base price, active flag |
| `DELETE` | `/api/hq/menu-items/:id` | **Deactivate** (never hard-deletes — see Schema decisions above) |
| `GET` | `/api/hq/outlets/:outletId/menu` | What this outlet is assigned, with effective prices and stock |
| `POST` | `/api/hq/outlets/:outletId/menu` | Assign an item, optional `priceOverride` |
| `PATCH` | `/api/hq/outlets/:outletId/menu/:menuItemId` | Set/clear `priceOverride`, toggle `isAvailable` |
| `DELETE` | `/api/hq/outlets/:outletId/menu/:menuItemId` | Unassign (refused while stock remains) |
| `GET` | `/api/hq/outlets/:outletId/inventory` | Stock for one outlet |
| `POST` | `/api/hq/outlets/:outletId/inventory/adjust` | Signed `delta` — restock or correct |
| `GET` | `/api/hq/reports/revenue` | Revenue by outlet — `?from=&to=` |
| `GET` | `/api/hq/reports/top-items` | Top items per outlet — `?from=&to=&limit=5` |

**`POST /api/hq/outlets/:outletId/menu`** — assign a menu item, with a price
override

Request:
```json
{ "menuItemId": "b0000000-...", "priceOverride": "13.50" }
```

Response `201`:
```json
{
  "assignment": {
    "outletId": "a0000000-...",
    "menuItemId": "b0000000-...",
    "priceOverride": "13.50",
    "isAvailable": true
  }
}
```

Errors: `404 NOT_FOUND` (bad outlet or menu item id), `409 ALREADY_ASSIGNED`.

**`GET /api/hq/reports/revenue?from=2026-01-01&to=2026-02-01`**

Response `200`:
```json
{
  "range": { "from": "2026-01-01", "to": "2026-02-01" },
  "totals": { "revenue": "63.50", "saleCount": 3, "outletCount": 2 },
  "outlets": [
    { "outletId": "...", "outletCode": "GUL-01", "outletName": "Gulshan Outlet", "revenue": "51.50", "saleCount": 2, "itemsSold": "13", "averageSale": "25.75" },
    { "outletId": "...", "outletCode": "DHM-02", "outletName": "Dhanmondi Outlet", "revenue": "12.00", "saleCount": 1, "itemsSold": "2", "averageSale": "12.00" }
  ]
}
```

Note every outlet appears even with zero sales in the period — see
[docs/architecture.md § 9](docs/architecture.md) for why the join is written
the way it is.

**`GET /api/hq/reports/top-items?limit=5`**

Response `200`:
```json
{
  "range": { "from": null, "to": null },
  "limit": 5,
  "outlets": [
    {
      "outletId": "...", "outletCode": "GUL-01", "outletName": "Gulshan Outlet",
      "items": [
        { "menuItemId": "...", "itemName": "Burger", "unitsSold": "8.000", "revenue": "68.00", "rank": 1 }
      ]
    }
  ]
}
```

### Outlet — requires role `OUTLET_STAFF`

| Method | Path | Purpose |
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

**`POST /api/outlet/sales`**

Request:
```json
{ "items": [{ "menuItemId": "b0000000-...", "quantity": 2 }] }
```

Response `201`:
```json
{
  "sale": {
    "id": "e1a2...",
    "receiptNo": "1",
    "receiptNumber": "000001",
    "totalAmount": "17.00",
    "itemCount": 1,
    "soldAt": "2026-09-26T07:02:31.000Z",
    "outletId": "a0000000-...",
    "items": [
      { "menuItemId": "b0000000-...", "itemName": "Burger", "unitPrice": "8.50", "quantity": "2" }
    ]
  }
}
```

Errors: `409 INSUFFICIENT_STOCK` (with `details.available`), `422
ITEM_NOT_ON_MENU` / `ITEM_UNAVAILABLE`, `400 VALIDATION_ERROR` (empty cart,
non-positive quantity, malformed id).

**`POST /api/outlet/sales/:id/void`**

Request:
```json
{ "reason": "Customer changed their mind" }
```

Response `200`:
```json
{
  "sale": {
    "id": "e1a2...",
    "receiptNo": "1",
    "receiptNumber": "000001",
    "status": "voided",
    "creditNoteNo": "1",
    "voidedAt": "2026-09-26T07:05:00.000Z",
    "restoredItems": [{ "menuItemId": "b0000000-...", "itemName": "Burger", "quantity": "2", "stockRestored": true }]
  }
}
```

Errors: `409 ALREADY_VOIDED`, `404 NOT_FOUND` (wrong outlet or bad id), `400
VALIDATION_ERROR` (missing reason).

### Errors

Every error has the same shape, with a request id that also appears in the logs:

```json
{
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "Insufficient stock for \"Burger\": requested 1, available 0.000",
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

Production responses never include a stack trace or an internal message — see
[docs/architecture.md § 10](docs/architecture.md#10-error-handling).

---

## Local Setup

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
cp .env.example .env             # only needed for a production-style build
npm install
npm run dev                      # http://localhost:5173, proxies /api
```

---

## Environment Variables

### `server/.env.example`

| Variable | Purpose | Default |
|---|---|---|
| `NODE_ENV` | `development` \| `test` \| `production` | `development` |
| `PORT` | API port | `4010` |
| `DATABASE_URL` | Full connection string (managed hosts) — overrides the discrete vars below | unset |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | Discrete connection parts, used if `DATABASE_URL` is unset | see file |
| `DB_SSL` | Required `true` for managed Postgres (Render, Neon, RDS) | `false` |
| `DB_POOL_MAX` / `DB_POOL_MIN` | Connection pool size — size against peak **concurrent sales**, not RPS | `20` / `2` |
| `JWT_SECRET` | Signing secret, min. 16 characters — **never commit a real one** | none, required |
| `JWT_EXPIRES_IN` | Token lifetime | `12h` |
| `CORS_ORIGIN` | Comma-separated allowed origins | `*` |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` \| `silent` | `info` |
| `LOCK_TIMEOUT_MS` | Per-transaction lock wait ceiling | `3000` |
| `RUN_MIGRATIONS_ON_BOOT` | Apply pending migrations at startup | `true` |
| `SEED_ON_BOOT` | Insert demo data at startup | `true` (local) |

### `web/.env.example`

| Variable | Purpose | Default |
|---|---|---|
| `VITE_API_BASE_URL` | API origin, baked into the bundle at **build** time | unset (same-origin) |

Never put a private secret in a `VITE_` variable — anything under that prefix
ships to every visitor's browser.

`.env` is gitignored everywhere; only `.env.example` files are committed.

---

## Docker Setup

- `server/Dockerfile` — multi-stage, `node:22-alpine`, runs as the non-root
  `node` user, `HEALTHCHECK` against `/health`.
- `web/Dockerfile` — Vite build stage, served by `nginx:1.27-alpine`; the API
  base URL is a build arg (`VITE_API_BASE_URL`), not a runtime one.
- `docker-compose.yml` — Postgres (with a `pg_isready` healthcheck the API
  waits on), the API, and the web container. Migrations and seeding run
  automatically on the API's first boot against the named volume.

```bash
docker compose up --build       # first run, or after a Dockerfile change
docker compose up -d             # subsequent runs
docker compose down -v           # tear down, including the database volume
```

---

## Demo Credentials

All use the password `Password123!`

| Email | Role | Sees |
|---|---|---|
| `hq@fnb.test` | HQ admin | All outlets, master menu, reports |
| `gulshan@fnb.test` | Outlet staff | Gulshan Outlet till (full menu) |
| `dhanmondi@fnb.test` | Outlet staff | Dhanmondi Outlet till (no Pasta, Pizza overridden to 13.50, Burger stock deliberately thin) |

Dhanmondi's thin Burger stock (6 units) makes the insufficient-stock path easy
to demonstrate without any setup, and its missing Pasta and overridden Pizza
demonstrate outlet-scoped menus and price overrides immediately after login.

These credentials only exist because `SEED_ON_BOOT=true` — see Deployment
below for what that means for the live instance.

---

## Deployment

`render.yaml` declares managed Postgres, the API as a Docker web service, and
the frontend as a static site, all on Render. Deploy via **New → Blueprint**
pointed at this repository; `JWT_SECRET` is generated, `DATABASE_URL` is wired
from the database, and migrations run on boot.

**Current status:** _to be filled in once deployed — see the top of this file
for the live URL, or ask if it is not yet present._

Two things worth knowing as a reviewer:

- Render's free tier **sleeps after inactivity**, so the first request after a
  pause takes 30–60 seconds. That is cold start, not a bug.
- **Render's free PostgreSQL is deleted 30 days after creation** (a 14-day
  grace period, then it and its data are gone). If this is reviewed after that
  window, the database will need to be recreated and reseeded — the blueprint
  makes that a five-minute operation, not a rebuild.
- `SEED_ON_BOOT=true` so the demo accounts above exist on the live instance.
  That is the correct choice for a review deployment and the wrong one for a
  real deployment, where it would be set to `false`.

---

## Scaling Strategy

Full reasoning in [docs/scaling.md](docs/scaling.md), clearly separating what
is implemented today from what is proposed for later. Summary:

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
change. See [docs/microservices.md](docs/microservices.md) for how this could
further evolve into services (Reporting first; Sales and Inventory stay
together permanently), and [docs/offline-pos.md](docs/offline-pos.md) for the
offline POS terminal strategy.

---

## Verifying the concurrency guarantees

The brief requires that receipt numbers "remain correct under concurrent
requests" and that the system "must prevent negative stock". Both are asserted
by the test suite, and both can be demonstrated against a running stack:

```bash
npm test --prefix server
node scripts/concurrency-proof.mjs
```

Actual output from the containerised stack:

```
[1] 50 simultaneous sales at one outlet

  item                             Coffee
  requests fired at once           50
  succeeded                        50                           PASS
  elapsed                          149 ms
  receipt range                    1 .. 50
  distinct receipt numbers         50                           PASS
  contiguous (no gaps)             true                         PASS
  stock                            60 -> 10                     PASS

[2] 40 simultaneous buyers competing for limited stock

  item                             Burger (6 in stock)
  buyers                           40
  succeeded                        6                            PASS
  rejected                         34 {"INSUFFICIENT_STOCK":34}
  all rejections are clean 409     true                         PASS
  final stock                      0                            PASS
  stock never went negative        true                         PASS
  no receipt numbers burned        true                         PASS

[3] Two outlets selling at the same time keep separate sequences

  outlet A receipts                51..60                       PASS
  outlet B receipts                7..16                        PASS
```

Test 2 is the one worth dwelling on: **34 failed sales consumed no receipt
numbers.** That is the payoff from bumping the counter at
the *end* of the transaction rather than the start — had it been bumped first,
every rejected sale would have burned a number and left a gap in the outlet's
books.

Tests run against a real PostgreSQL instance, not a mock. What they exist to
prove — row locking, guarded updates re-evaluated after a lock wait, per-outlet
sequencing under contention — is behaviour of the database engine itself. A
mock would only assert that the code calls the functions we wrote.

### Test suites

| Suite | Asserts |
|---|---|
| `sale.concurrency` | Unique gapless receipts under 50 simultaneous sales; exact stock conservation; no oversell with 40 buyers for 10 units; no deadlock when concurrent carts list items in opposite orders; per-outlet sequences; nothing written when one line of a multi-item sale fails |
| `rollback` | Forces a database-constraint failure **after** a real stock deduction and proves the deduction, the sale, the sale items and the receipt allocation all roll back together |
| `isolation` | An outlet sees only its own menu/stock/sales; cannot fetch another outlet's receipt by id; role separation both ways; tampered tokens rejected |
| `pricing` | Override beats base price; clearing it falls back; client-supplied prices rejected; a recorded sale is unchanged by later price and name changes; header total equals the sum of line totals |
| `reports` | Figures checked against hand-computed arithmetic; zero-revenue outlets still appear; renamed items stay one row; date range respected |
| `void` | Stock returned exactly once; receipt number never reused; credit notes sequential per outlet; 10 concurrent voids yield exactly one; cannot void another outlet's sale; voided money and units leave both reports |

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
  definitive response. They are the one schema addition offline mode would
  require, and are covered in
  [docs/offline-pos.md](docs/offline-pos.md#7-idempotency).
- **Offline POS mode itself** — documented as a design only in
  [docs/offline-pos.md](docs/offline-pos.md); nothing offline-related is
  implemented in the running system.

### Known limitations

- The rendered UI has not been verified in a browser during development — no
  browser automation was available in the build environment. The production
  build is clean and an endpoint-contract check confirms every request the
  components make returns the exact shape they destructure, but a manual
  click-through is worth doing before relying on it.
- `npm audit` reports a handful of moderate advisories in the frontend build
  toolchain (`vite`/`esbuild`) and in a transitive dependency under Sequelize.
  None are in the runtime path of the shipped API image.
- Render's free PostgreSQL is deleted 30 days after creation — see Deployment
  above.
- Demo credentials are intentionally public knowledge for this review
  deployment (documented above); they would be removed or rotated for any
  real deployment.
