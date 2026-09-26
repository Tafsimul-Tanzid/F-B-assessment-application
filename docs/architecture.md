# Architecture

How the system is put together: the request path from browser to database,
the layering rules that keep business logic out of routes and controllers,
the schema and its ERD, and the transaction/concurrency strategy behind the
sale path.

Scaling, the microservices evolution, and the offline POS strategy are
separate, larger documents — see [`scaling.md`](scaling.md),
[`microservices.md`](microservices.md) and [`offline-pos.md`](offline-pos.md).

---

## 1. System overview

One company, several outlets. HQ manages a master menu and assigns items to
outlets with optional per-outlet price overrides; each outlet holds its own
inventory, rings up sales that deduct it, and gets a receipt numbered
sequentially from its own sequence; HQ reads revenue and top-seller reports
across every outlet.

```
                    ┌─────────────────┐
                    │   React (SPA)   │
                    │  HQ console  +  │
                    │  outlet POS     │
                    └────────┬────────┘
                             │ HTTPS, JSON, Bearer JWT
                             ▼
                    ┌─────────────────┐
                    │   Express API   │
                    │ routes → ctrl → │
                    │ services → repo │
                    └────────┬────────┘
                             │ pooled connections
                             ▼
                    ┌─────────────────┐
                    │   PostgreSQL    │
                    └─────────────────┘
```

One deployable API, one database, one frontend build. There is no message
queue, cache layer or second datastore — at this scale (see
[`scaling.md`](scaling.md)) none of them would pay for their own complexity,
and the brief is explicit that this should not become an unnecessarily large
system for a 3–5 day assessment.

## 2. Request flow

A concrete example — creating a sale — end to end:

1. **Browser** sends `POST /api/outlet/sales` with a bearer token and a cart.
2. **`authenticate` middleware** verifies the JWT signature and attaches
   `req.user` (id, role, outlet id — outlet id comes from the token, never
   from the request).
3. **`outletScope` middleware** refuses the request unless the caller is
   outlet staff, and sets `req.outletId` from `req.user.outletId`.
4. **`validate(createSaleSchema)`** parses `req.body` with Zod; a malformed
   cart never reaches the controller.
5. **Controller** (`sale.controller.js`) reads `req.outletId`, `req.user.id`
   and `req.validated.body`, and calls the service with plain arguments — no
   HTTP objects cross this boundary.
6. **Service** (`sale.service.js`) opens one database transaction and, inside
   it, calls repository functions in a specific order (price resolution →
   stock deduction → receipt allocation → line items). This is the only layer
   that owns transaction boundaries.
7. **Repositories** run parameterised SQL against Postgres and return plain
   rows; they never open a transaction, only receive one.
8. On success, the service returns a plain object; the controller serialises
   it as JSON. On failure, a typed error propagates to the **central error
   middleware**, which is the only place an error becomes an HTTP response.

Every other endpoint in the system follows the same shape: routes wire up
validation and access control, controllers translate HTTP, services own
business rules and transactions, repositories own SQL.

## 3. Frontend architecture

A single Vite/React SPA serving two roles from one login:

```
web/src/
├── api/client.js       fetch wrapper: attaches the bearer token, maps
│                        non-2xx responses to a typed ApiError
├── shared/              AuthContext (session state), Layout (nav shell),
│                        ui.jsx (Card, ErrorNote, StockPill, Field), BarChart
├── hq/                  ReportsPage, MenuItemsPage, OutletsPage,
│                        OutletDetailPage — visible only to HQ_ADMIN
└── outlet/              PosPage, SalesHistoryPage — visible only to
                          OUTLET_STAFF
```

Routing is role-gated (`Protected` in `main.jsx` redirects a mismatched role
before a page even mounts), but this is a UX convenience, not the security
boundary — every request the page makes is independently authorized by the
API regardless of what the UI shows. Server state is fetched with TanStack
Query rather than kept in component state or a global store; mutations
invalidate the relevant query keys on success so the UI reflects what the
database now holds, rather than an optimistic guess.

## 4. Backend layered architecture

```
routes/         paths, validation schemas, access control — no logic
controllers/    HTTP in/out — no business rules, no SQL
services/       business rules; owns transaction boundaries
repositories/   all SQL and model access; receives transactions, never opens them
```

The rule that makes this real rather than cosmetic: **a repository never
opens a transaction, it receives one.** Transaction boundaries are a business
concern, so a repository that called `sequelize.transaction()` itself would
make it impossible to compose several repository calls into one atomic
unit — which is exactly what the sale path needs. See
[`server/src/repositories/README.md`](../server/src/repositories/README.md)
for the full contract, including why `{ transaction }` is passed explicitly
rather than via an ambient context.

## 5. Database architecture

See §6 for the full ERD. Design choices worth calling out on their own:

- **`sale_items` snapshots `item_name`, `unit_price` and `line_total`** at
  the moment of sale rather than referencing the live menu. A receipt is a
  financial record — it must reprint identically after HQ changes a price or
  renames an item, and a report must not silently restate history.
- **Receipt numbers come from a counter table, not a `SEQUENCE`.** Sequences
  are global and gappy by design; §9 covers this in full.
- **Menu items deactivate rather than delete**, because a hard `DELETE`
  would take a lock that conflicts with every concurrent sale of that item
  (§8 covers the mechanism).
- **A single `companies` row** sits above every outlet via `outlets.company_id`.
  The scenario is explicitly one company operating multiple outlets, so this
  is a plain foreign key rather than a many-to-many table — there is no
  relationship to model beyond "every outlet belongs to the one company."

## 6. ERD

Reflects the schema actually created by the migrations in
[`server/migrations/`](../server/migrations) — nothing here is aspirational.

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
        timestamptz created_at
    }

    OUTLETS {
        uuid id PK
        uuid company_id FK
        text code UK "unique across the company"
        text name
        text address
        boolean is_active
        timestamptz created_at
    }

    USERS {
        uuid id PK
        text email UK
        text password_hash "bcrypt"
        text full_name
        text role "HQ_ADMIN | OUTLET_STAFF"
        uuid outlet_id FK "NULL for HQ; required for staff"
        boolean is_active
    }

    MENU_ITEMS {
        uuid id PK
        text sku UK
        text name
        text category
        numeric base_price "company-wide default"
        boolean is_active "deactivated, never deleted"
    }

    OUTLET_MENU_ITEMS {
        uuid outlet_id PK_FK
        uuid menu_item_id PK_FK
        numeric price_override "NULL = inherit base_price"
        boolean is_available
        timestamptz assigned_at
    }

    INVENTORY {
        uuid outlet_id PK_FK
        uuid menu_item_id PK_FK
        numeric quantity "CHECK (quantity >= 0)"
        timestamptz updated_at
    }

    OUTLET_RECEIPT_COUNTERS {
        uuid outlet_id PK_FK
        bigint last_receipt_no "bumped inside the sale txn"
    }

    OUTLET_CREDIT_NOTE_COUNTERS {
        uuid outlet_id PK_FK
        bigint last_credit_note_no "separate sequence for voids"
    }

    SALES {
        uuid id PK
        uuid outlet_id FK
        bigint receipt_no "UNIQUE per outlet"
        numeric total_amount
        integer item_count
        timestamptz sold_at
        uuid cashier_id FK
        text status "completed | voided"
        bigint credit_note_no "UNIQUE per outlet, set on void"
        timestamptz voided_at
        uuid voided_by FK
        text void_reason
    }

    SALE_ITEMS {
        uuid id PK
        uuid sale_id FK
        uuid menu_item_id FK
        text item_name "SNAPSHOT at sale time"
        numeric unit_price "SNAPSHOT at sale time"
        numeric quantity
        numeric line_total "SNAPSHOT at sale time"
    }
```

### Four schema decisions worth explaining

**Assignment is its own table, not a column.** `outlet_menu_items` is the
join between the master menu and an outlet, and it is where the per-outlet
price override lives. A single `price` column on `menu_items` could not
express "the Dhanmondi outlet charges 13.50 for the same pizza that costs
12.00 elsewhere", and a price column per outlet would mean a schema change
for every new outlet. `COALESCE(price_override, base_price)` resolves the
effective price in one expression.

**`sale_items` snapshots the name and price.** If reports re-derived prices
by joining the live menu, every HQ price change would silently restate
historical revenue, and unassigning an item would make past sales of it
disappear from reports entirely. Three extra columns per line buy
immutability, and they make the revenue report a two-table query rather
than a four-table one.

**Receipt numbers come from a counter table, not a sequence.** A Postgres
`SEQUENCE` is global rather than per-outlet, and it is gappy by design — a
rolled-back transaction never returns its number. `outlet_receipt_counters`
gives each outlet its own counter, incremented and read atomically inside
the sale transaction. §9 covers the locking.

**Voids keep the sale and number themselves separately.** Voiding does not
delete the sale or free its receipt number — the sale happened, and the
books must show both it and the correction. The sale is marked `voided`,
stock is returned, and a credit note is allocated from
`outlet_credit_note_counters`, a sequence deliberately distinct from
receipts so the two document types can never be confused in an audit.

**Menu items deactivate rather than delete.** Besides preserving historical
references, a hard `DELETE` takes a `FOR UPDATE` lock on the `menu_items`
row, which conflicts with the `FOR KEY SHARE` lock that every concurrent
`INSERT INTO sale_items` takes on it. A single HQ deletion would block —
and could deadlock against — in-flight sales of that item at every outlet
simultaneously.

### Indexes

| Index | Why it exists |
|---|---|
| `inventory (outlet_id, menu_item_id)` PK | The stock deduction is a single-row lookup; also the canonical lock-ordering key |
| `outlet_menu_items (outlet_id, menu_item_id)` PK | Outlet menu fetch and price resolution |
| `outlet_receipt_counters (outlet_id)` PK | The lock target — must be an exact lookup, never a scan |
| `sales (outlet_id, receipt_no)` UNIQUE | The per-outlet sequence invariant itself, enforced by the database |
| `sale_items (sale_id)` | **Not automatic.** Postgres indexes a foreign key's *target*, never the referencing column. Without it, receipt reprint and the top-items join both sequential-scan |
| `sales (outlet_id, sold_at) INCLUDE (total_amount) WHERE status = 'completed'` | Makes the revenue report an index-only scan. Partial, because every report counts completed sales only. `sold_at` is monotonic, so inserts land at the right edge of the B-tree with minimal page splitting |
| `users (email)` UNIQUE | Login |
| `outlets (company_id)` | Lookup only — not a hot path with a single company |

**Deliberately omitted: `sale_items (menu_item_id)`.** The top-items report
hash-aggregates rows it already has via the `sale_id` join — it never looks
an item *up* by id. The index would cost a B-tree insert per **line item**
against a random UUID for no read benefit. Add it only if a "where has item
X sold" query ships.

## 7. Authentication

Stateless JWT. `POST /api/auth/login` verifies email + bcrypt-hashed
password and returns a signed token carrying `sub` (user id), `role`, and
`outletId` (`null` for HQ). Every subsequent request carries it as
`Authorization: Bearer <token>`; the `authenticate` middleware verifies the
signature and expiry and attaches the decoded claims as `req.user` — nothing
is looked up from the database on every request, which is what makes the API
stateless and horizontally scalable for free (see
[`scaling.md`](scaling.md#infrastructure)).

Login returns the same generic message for an unknown email and a wrong
password, and spends the same bcrypt time either way, so response content
and timing do not reveal which addresses are registered.

## 8. Authorization

Two roles: `HQ_ADMIN` and `OUTLET_STAFF`. `requireRole(...)` gates HQ routes.
Outlet routes use a stricter mechanism than a role check: `outletScope`
middleware takes the acting outlet id **only** from `req.user.outletId` — the
JWT claim — and no outlet route accepts an outlet id as a path, query or body
parameter at all. There is therefore no field an outlet terminal could tamper
with to reach another outlet's menu, inventory, sales or reports; the
parameter that would carry that attack simply does not exist in the route
signature. This is asserted directly by tests in
[`server/tests/integration/isolation.test.js`](../server/tests/integration/isolation.test.js).

HQ routes, by contrast, do take an outlet id in the path — HQ legitimately
acts across every outlet, so the boundary there is the role check alone.

## 9. Transaction strategy, inventory concurrency and receipt numbering

The sale transaction is the core of the system and the part most worth
reading carefully. One transaction, in this exact order:

```
BEGIN (READ COMMITTED, lock_timeout = 3s)
  1. resolve prices from the outlet's own menu        no locks
  2. deduct stock, ascending menu_item_id             inventory row locks
  3. bump receipt counter + insert the sale           counter row lock
  4. insert line items
COMMIT
```

### Inventory concurrency strategy

The guard against negative stock lives in the `WHERE` clause of the
deduction itself, not in a read-then-write:

```sql
UPDATE inventory SET quantity = quantity - $3
 WHERE outlet_id = $1 AND menu_item_id = $2 AND quantity >= $3
RETURNING quantity;
```

When a concurrent transaction holds the row lock, this statement blocks;
when that transaction commits, Postgres does **not** continue from this
transaction's original snapshot. It re-reads the newly committed row and
re-evaluates the whole `WHERE` clause, guard included. The check is
therefore always made against the latest committed quantity, and a lost
update cannot occur. Doing that comparison in application code would be
wrong twice over: it would race, and `numeric` arrives from the driver as a
*string*, where `"9" >= "10"` is `true`.

A `CHECK (quantity >= 0)` constraint also exists, as a backstop rather than
the mechanism. It defends the paths that do not go through the sale
service — restocks, corrections, future admin tooling, and bugs. If it ever
fires, that is logged at ERROR, because it means a guard was bypassed.

**Deadlock is structurally impossible.** Line items are aggregated by
`menu_item_id` (so a cart listing the same item twice deducts the sum, once)
and then deducted sequentially in ascending id order. Every sale in the
system acquires inventory locks in that same global order, so two
concurrent sales touching the same items can never hold them in opposite
orders, and no wait cycle can form. A test fires twenty concurrent two-item
sales with the items deliberately listed in opposite orders and asserts
they all succeed.

### Receipt number strategy

A Postgres `SEQUENCE` is rejected outright: it is global rather than
per-outlet, and it is gappy by design. Instead, `outlet_receipt_counters`
gives each outlet its own row, bumped and read atomically in the same
statement as the sale insert:

```sql
WITH next_receipt AS (
  UPDATE outlet_receipt_counters SET last_receipt_no = last_receipt_no + 1
   WHERE outlet_id = $1 RETURNING last_receipt_no
)
INSERT INTO sales (outlet_id, receipt_no, ...)
SELECT $1, next_receipt.last_receipt_no, ... FROM next_receipt
RETURNING id, receipt_no;
```

**Why the counter is bumped last, not first.** Postgres holds row locks
until commit, so whenever the counter is bumped it stays locked for the
rest of the transaction. Bumping it first would make it a per-outlet global
mutex held across every stock update and every network round trip, and it
would burn a receipt number on every validation failure. Bumping it after
stock has been deducted holds it only across two inserts and the commit.

The cost of that choice is that lock acquisition order becomes
load-bearing: inventory locks are always taken *before* the counter lock.
The counter bump therefore lives in exactly one function with exactly one
caller, so no future code path can invert the order.

**Why READ COMMITTED rather than something stricter.** Both mutations above
are single statements that read and write in one step, which is exactly
the case READ COMMITTED's re-evaluation handles correctly. REPEATABLE READ
would be strictly worse here: it raises a serialization failure whenever
two transactions touch the same row, which for a POS is the *ordinary*
case — two cashiers selling the same popular item, or any two sales at one
outlet hitting the same counter row — forcing full retries for no
correctness gain.

**On gaps.** No in-transaction scheme can be strictly gapless: the number
must be allocated before `COMMIT`, and `COMMIT` can fail. Allocating last
confines gaps to infrastructure failures occurring after all validation has
passed. This is proven directly by
[`server/tests/integration/rollback.test.js`](../server/tests/integration/rollback.test.js),
which forces a database-level failure after a real stock deduction and
confirms the receipt counter's bump rolls back with everything else — the
next real sale still receives receipt #1.

**Verification.** [`scripts/concurrency-proof.mjs`](../scripts/concurrency-proof.mjs)
demonstrates all of the above against a running stack: 50 simultaneous
sales yield receipts 1–50 with no duplicates and no gaps; 40 buyers
competing for 10 units of stock yield exactly 10 sales, 30 clean 409s, and
final stock of exactly 0, with none of the 30 failures consuming a receipt
number.

## 10. Error handling

Every error becomes an HTTP response in exactly one place:
[`server/src/middleware/errorHandler.js`](../server/src/middleware/errorHandler.js).
Services and repositories throw typed errors from
[`server/src/errors/index.js`](../server/src/errors/index.js)
(`ValidationError`, `InsufficientStockError`, `ConflictError`, ...), each
carrying its own HTTP status and a stable machine-readable `code`. A
separate mapper,
[`server/src/db/errors.js`](../server/src/db/errors.js), translates raw
PostgreSQL SQLSTATE codes (unique violation, check violation, deadlock,
lock timeout) into the same typed errors, so a controller never inspects a
database error directly.

Every response has the same shape, carries a request id that also appears
in the server logs, and in production never includes a stack trace or an
internal message — the client sees `error.message`, `error.code`, and
optional `error.details` for field-level validation problems. Unexpected
errors are logged in full server-side and returned to the client as a
generic 500 with only the request id, so a report of "it broke" can be
traced back to the exact log line without ever exposing internals.

## 11. Validation

Every request body, query string and path parameter that matters is
validated by a [Zod](https://zod.dev) schema in
[`server/src/validation/`](../server/src/validation), applied by a single
`validate(schema)` middleware before the controller runs. Parsed output is
written to `req.validated` rather than the raw `req.body`/`req.query`, so a
controller can never accidentally read an unvalidated, uncoerced value —
query strings in particular arrive as strings and need coercion (a `limit`
of `"50"` must become the number `50`) before use.

Money and quantity fields are validated as strings matching a strict
decimal pattern and are never parsed into a JS number at the API boundary,
because a `numeric(12,2)` value must reach Postgres as a string to avoid
float rounding error. Every validation failure returns one consistent
shape — `400 VALIDATION_ERROR` with a `details` array naming the offending
field and the specific problem — rather than a generic message.
