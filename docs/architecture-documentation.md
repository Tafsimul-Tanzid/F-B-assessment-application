# F&B Multi-Outlet POS – Architecture Documentation

**Author:** Tafsimul Tanzid

**Repository:** https://github.com/Tafsimul-Tanzid/F-B-assessment-application
**Live application:** https://fnb-pos-web.onrender.com

---

## 1. What this system does

One company runs several F&B outlets. Head office (HQ) creates a master
menu and assigns items to outlets, with the option to charge a different
price at each outlet. Each outlet has its own stock. When an outlet makes a
sale, stock goes down and a receipt number is generated. HQ can see how
much revenue each outlet made and which items sell best.

That's the whole scope. There's no tax, no discounts, no delivery, no
loyalty points. Keeping it small was intentional — this is a 3–5 day
assessment, not a production POS company.

---

## 2. Database Schema (ERD)

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
        text address
        boolean is_active
    }
    USERS {
        uuid id PK
        text email UK
        text password_hash
        text role "HQ_ADMIN or OUTLET_STAFF"
        uuid outlet_id FK "null for HQ"
    }
    MENU_ITEMS {
        uuid id PK
        text sku UK
        text name
        text category
        numeric base_price
        boolean is_active
    }
    OUTLET_MENU_ITEMS {
        uuid outlet_id PK_FK
        uuid menu_item_id PK_FK
        numeric price_override "null = use base_price"
        boolean is_available
    }
    INVENTORY {
        uuid outlet_id PK_FK
        uuid menu_item_id PK_FK
        numeric quantity "CHECK quantity >= 0"
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
        text status "completed or voided"
        bigint credit_note_no
        uuid cashier_id FK
    }
    SALE_ITEMS {
        uuid id PK
        uuid sale_id FK
        uuid menu_item_id FK
        text item_name "copied at sale time"
        numeric unit_price "copied at sale time"
        numeric quantity
        numeric line_total "copied at sale time"
    }
```

This diagram matches the actual migrations in `server/migrations/`. It's
not hand-drawn separately — if the schema changes, this is the file that's
supposed to change with it.

### Why the schema is shaped this way

**`outlet_menu_items` is a separate table, not a column on `menu_items`.**
This is where the per-outlet price override lives. A single `price` column
on the menu item couldn't say "this outlet charges 13.50 for the same
pizza that's 12.00 elsewhere." The effective price a customer pays is just
`COALESCE(price_override, base_price)`.

**`sale_items` copies the item name and price instead of looking them up.**
A receipt is a record of what actually happened. If HQ changes a price
next week, last week's receipts and reports shouldn't change. So at the
moment of sale, the name and price get copied onto the sale line. Reports
read from these copies, not from the live menu.

**Receipt numbers come from a counter table (`outlet_receipt_counters`),
not a Postgres `SEQUENCE`.** A `SEQUENCE` is shared across the whole
database and skips numbers when a transaction rolls back. Neither of those
is acceptable for a receipt number that has to be sequential per outlet.
Section 6 explains exactly how this counter is used safely.

**Voiding a sale doesn't delete it.** It gets marked `status = 'voided'`
and given its own number from a second counter (`outlet_credit_note_counters`),
so the original receipt number is never reused and the sale stays in the
history.

**Menu items are deactivated, never deleted.** A real `DELETE` on a menu
item conflicts with locks taken by any sale currently being written for
that item, so a delete could block or deadlock against live sales. Setting
`is_active = false` avoids that entirely and also keeps old receipts
intact.

### Constraints and indexes that actually matter

| Constraint / Index | What it does |
|---|---|
| `inventory` — `CHECK (quantity >= 0)` | Backstop against negative stock on any write path, not just sales |
| `sales` — `UNIQUE (outlet_id, receipt_no)` | The database itself refuses a duplicate receipt number per outlet |
| `users` — `CHECK` role/outlet consistency | Outlet staff must have an outlet id, HQ must not |
| `sale_items` — `(sale_id)` index | Postgres does not automatically index a foreign key column, only the side it points to. Without this, printing a receipt or running the top-items report would scan every sale item in the table |
| `sales` — `(outlet_id, sold_at)` partial index, `WHERE status = 'completed'` | Lets the revenue report answer straight from the index without touching the actual rows |

One index was deliberately **not** added: `sale_items(menu_item_id)`. The
top-items report groups rows it already has from a join on `sale_id` — it
never looks an item up by id. That index would slow down every sale
(one more B-tree write per line item) for a query pattern that doesn't
exist. Adding indexes without a query to justify them is how a database
quietly gets slower.

---

## 3. System Architecture

### Request flow

```
Browser (React)
     │  fetch() with a JWT in the Authorization header
     ▼
Express API
  routes/        which URL, is the caller allowed here
  controllers/   read the request, call a service, send the response
  services/      the actual business rules, opens/owns the DB transaction
  repositories/  the SQL
     │
     ▼
PostgreSQL
```

A concrete example, creating a sale:

1. The outlet POS sends `POST /api/outlet/sales` with a cart and a bearer
   token.
2. Middleware checks the token and pulls the outlet id straight out of it
   — the request body has no outlet id field at all, so there's nothing to
   tamper with there.
3. Zod validates the request shape (item ids, quantities) before anything
   else runs.
4. The controller passes plain values into `sale.service.js`.
5. The service opens one database transaction and, inside it: prices the
   items from the outlet's own menu, deducts stock, allocates a receipt
   number, and inserts the sale.
6. If anything fails partway through, the whole transaction rolls back —
   nothing is half-written.

### Why it's split into these four layers

This is the part of the assignment that's easy to fake and easy to check,
so it's worth being specific:

- **Routes** only decide the URL, the validation schema, and who's allowed
  to call it. No business logic here.
- **Controllers** read `req`, call one service function, and send the
  response. They never touch SQL and never contain a business rule.
- **Services** own the business rules and, importantly, own the database
  transaction. A repository is never allowed to start its own transaction
  — it only receives one that a service already opened. That's what makes
  it possible to call several repository functions (check stock, deduct
  stock, insert the sale) as one atomic unit.
- **Repositories** are the only place SQL is written. Every query is
  parameterised.

The reason for the strict "repositories never open a transaction" rule:
if they did, there'd be no way to make "deduct stock" and "create the
sale" happen together as one operation, and that's exactly the guarantee
this system depends on.

### Frontend

The React app is one codebase with two views behind one login: an HQ
console (menu, assignment, reports) and an outlet till (menu grid, cart,
checkout, sales history). Routing shows the right view based on the
logged-in user's role, but that's just for a better experience — the API
enforces the real access control independently on every request, so
showing the wrong screen would never leak data.

Data fetching uses TanStack Query rather than storing server data in
component state by hand. When a mutation succeeds (a sale, a menu change),
the relevant query is invalidated and refetched, so the screen reflects
what's actually in the database instead of a locally guessed update.

---

## 4. Transaction and Concurrency Handling

This is the part of the assessment that actually matters most, so it gets
the most detail.

### The sale, step by step

```
BEGIN transaction (READ COMMITTED)
  1. look up the price for each item from the outlet's own menu
  2. deduct stock, one item at a time, in a fixed order
  3. allocate the next receipt number and insert the sale row
  4. insert the sale line items
COMMIT
```

If any step fails, everything from step 1 onward is undone by Postgres.
Nothing partial is left behind — no sale with no stock deducted, no stock
deducted with no sale recorded.

### Stopping negative stock

The stock deduction is one SQL statement, not a "read the stock, check it
in JavaScript, then write it back" sequence:

```sql
UPDATE inventory
   SET quantity = quantity - $3
 WHERE outlet_id = $1 AND menu_item_id = $2 AND quantity >= $3
RETURNING quantity;
```

If two people try to buy the last item at the same time, the second
request's `UPDATE` waits for the first one to finish. Once it can run, it
checks the stock again — using the number the first request just left
behind, not the number it saw when the request started. If there's not
enough left, the `WHERE` clause matches zero rows, and the code treats
that as "not enough stock" rather than trying to write a negative number.

There's also a `CHECK (quantity >= 0)` constraint on the table itself.
That's not the main defence — it's a backstop for anything that isn't the
sale code (a manual stock correction, a bug, whatever). If it ever fires,
something else already went wrong.

### Sequential receipt numbers, safely

Each outlet has one row in `outlet_receipt_counters`. Getting the next
number and creating the sale happen in the same SQL statement:

```sql
WITH next_receipt AS (
  UPDATE outlet_receipt_counters
     SET last_receipt_no = last_receipt_no + 1
   WHERE outlet_id = $1
  RETURNING last_receipt_no
)
INSERT INTO sales (outlet_id, receipt_no, ...)
SELECT $1, next_receipt.last_receipt_no, ...
FROM next_receipt
RETURNING id, receipt_no;
```

Two things worth calling out:

- **This does not use a Postgres `SEQUENCE`.** A sequence is global, and
  it skips numbers on rollback. Neither behaviour is acceptable for a
  per-outlet, gap-free-as-possible receipt number.
- **The counter is updated last, not first.** If it were updated at the
  start of the transaction, it would stay locked for the entire sale
  (including the stock deduction and any network delay), turning it into
  a bottleneck for that whole outlet. Updating it right before the sale
  is inserted means the lock is only held for a moment.

The trade-off is that stock is always deducted *before* the receipt
counter is touched, in every code path, without exception — otherwise two
sales could end up waiting on each other in opposite orders and deadlock.

### Rollback on a real failure

This isn't just a claim — there's a test for it
(`server/tests/integration/rollback.test.js`) that forces a real database
constraint to fail partway through a sale, after stock has already been
deducted for one item, and checks that:

- the stock deduction is undone
- no sale row exists
- no sale line items exist
- the receipt counter itself is rolled back — the very next sale still
  gets the number this one would have used, not the one after it

### Voiding a sale

Voiding uses the same guarded-update pattern as stock deduction:

```sql
UPDATE sales SET status = 'voided', ...
WHERE id = $1 AND status = 'completed'
```

If two void requests hit the same sale at the same time, only one of them
finds a row with `status = 'completed'` to match. The other gets nothing
back and is told the sale was already voided. There's a test with ten
simultaneous void requests on the same sale that confirms exactly one
succeeds.

---

## 5. Scaling Plan — 10 outlets, ~100,000 transactions/month

**Current implementation:** one Express instance, one Postgres database,
no cache, no queue, no read replica.

Before listing changes, it's worth doing the actual math. 100,000
transactions a month is about 3,300 a day, which is roughly 0.04 writes
per second on average. Even with a busy lunch/dinner rush across ten
outlets, that's maybe 5–15 sales a second. A single Postgres instance
handles that comfortably. Nothing below needs to happen for this system to
hit that number — it's what to do if usage grows well past it.

### Database

| Change | Why |
|---|---|
| **Connection pooling (PgBouncer, transaction mode)** | Each sale holds a database connection for its whole transaction. As more API instances run, the connection count adds up fast. PgBouncer lets many app connections share a smaller number of real Postgres connections |
| **Read replica for reports** | Reports read a range of sales; the till needs fast writes. Keeping them on separate connections (or a separate replica) means a slow report can't compete with a sale for resources |
| **Partitioning `sales`/`sale_items` by month** | Not needed yet — at this volume the tables stay small for years. Worth doing once retention/cleanup of old data becomes a real need, because dropping an old partition is instant, but deleting millions of old rows is not |

### Indexing

The indexes already in place (see section 2) are the ones this workload
actually needs. At larger scale the same rule applies: add an index when a
specific slow query needs it, not in advance. An index that isn't used by
any query just slows down every write.

### Reporting performance

The revenue report already runs off a covering index and stays fast. The
top-items report is the one that gets slower as the number of sale line
items grows, because it scans however many rows fall in the requested date
range.

Two cheap steps before anything more complex: cache the report response
for a short period (a dashboard doesn't need to update every second), and
require a date range instead of defaulting to "all time."

If that's not enough, the next step is a small **materialized view** that
pre-aggregates daily sales per item, refreshed on a schedule. What should
**not** be done is keeping a running total updated inside the sale
transaction itself — that would make every sale of a popular item wait on
one shared row, which recreates the exact contention problem the stock
deduction design avoids.

### Caching

A response cache in front of the two report endpoints is the only caching
this system would need at this scale. There's no reason to cache menu or
stock data — stock changes on every sale and needs to stay accurate.

### Infrastructure / horizontal scaling

The API doesn't store anything in memory between requests — no session
state, no in-memory counters. That was a deliberate choice, and it means
running two or three API instances behind a load balancer requires no code
change. The bottleneck at scale is the database, not the API layer.

### Background jobs

Not needed today. If features like kitchen-display notifications, email
receipts, or loyalty points get added later, those should run *after* the
sale transaction commits, not inside it — anything slow running inside the
transaction just holds locks longer. An outbox table (write an "event
happened" row in the same transaction, process it afterwards) is the
standard way to do this without losing events if a job fails partway.

### Architectural changes

None of the above requires giving up the current single-transaction sale.
That guarantee — stock deduction and sale creation happening together, or
not at all — is the one thing that shouldn't be given up for scale. The
next section covers when it would make sense to split parts of this system
into separate services, and stock/sales is specifically the part that
should stay together the longest.

---

## 6. Microservices Evolution

**At the current scale, splitting this into microservices would be a
mistake.** A single deployable with clean internal layers is simpler to
build, simpler to run, and — more importantly — it's what makes the sale
transaction possible in the first place. The layering already in place
(routes → controllers → services → repositories) is what makes a future
split realistic without a rewrite: a service extraction later would mean
replacing a repository call with a network call, not untangling business
logic out of route handlers.

If this did need to grow into separate services, here's how the
boundaries would likely fall:

| Service | Would own | Why it could split off |
|---|---|---|
| **Auth / Users** | Logins, JWT issuing | No real coupling to anything else — every other service just checks a token signature. Usually the first thing anyone splits out |
| **Menu** | Master menu, outlet assignment, price overrides | Read-heavy, changes rarely. Easy to cache separately from the transactional data |
| **Sales + Inventory** | Sales, sale items, stock, both counters | Should be extracted **together, or not at all** — see below |
| **Reporting** | Revenue and top-items aggregation | Read-only, no consistency requirement beyond "close enough." Lowest-risk thing to split first |

### Why Sales and Inventory stay together

Splitting these two into separate services sounds clean on paper, but it
breaks the one guarantee this system is built around. "Deduct stock and
record the sale" is one transaction today. Split into two services with
two databases, that becomes a multi-step process: reserve stock, record
the sale, and if the sale fails, release the reservation. Every one of
those steps can itself fail, and now there's a whole extra layer of code
just to handle a reservation that never gets released, or a release that
itself fails. "Prevent negative stock," which is a one-line database
constraint today, turns into a background reconciliation job. That's a
real cost for very little benefit, since sales and inventory are driven by
exactly the same event anyway — someone buying something.

Reporting is the opposite case: it's read-only, it's already isolated
behind its own repository file with zero writes in it, and splitting it
off doesn't touch the sale path at all.

---

## 7. Offline POS Strategy (Proposed — not implemented)

**Everything in this section is a design, not code.** The deployed system
requires an internet connection to create a sale. Nothing here exists in
the repository. It's written to answer "how would this be added later,"
not to describe current behaviour.

The idea behind all of it: a terminal should keep selling when the
internet drops, and only need the internet again to tell HQ what happened.

**Local storage.** Each terminal keeps a small local database (SQLite, or
IndexedDB for a browser-based terminal) with its menu, its last-known
stock, and a queue of sales that haven't reached the server yet.

**Creating a sale offline.** The sale gets written locally first, and the
receipt prints from that local write. Reaching the server happens
afterwards, in the background. The terminal behaves the same way whether
it's online or not — sync is a separate, secondary step.

**Local receipt numbers.** This is the trickiest part, because the real
per-outlet counter lives on the server and isn't reachable offline. The
simplest fix is giving each terminal its own prefix — something like
`GUL01-T02-000417` — so two offline terminals can never produce the same
number. The cost is that the outlet no longer has one single unbroken
sequence, which is a reasonable trade unless a specific tax rule requires
one.

**Sync queue and retrying.** Sales sit in a local queue and get sent in
order once the connection comes back, retried with backoff if a send
fails.

**Idempotency / avoiding duplicate sales.** A sale sent twice by accident
(the network dropped right after the server saved it, before the terminal
got the confirmation) must not create two sales. Each sale would carry a
unique id generated on the terminal itself when it's created. The server
would check that id before inserting — if it's seen it already, it just
returns the existing sale instead of creating a second one. This is the
one schema change offline mode would actually need; it doesn't exist in
the database today because it isn't needed while the system is
online-only.

**Stock conflicts.** Two terminals offline at the same time could both
sell the last unit of something. When they reconnect, the server can't
undo either sale — the customer already has the item. Both sales get
accepted as real, stock is clamped at zero instead of going negative, and
the difference gets logged for a manager to check with an actual stock
count later.

**POS and KDS talking to each other offline.** The kitchen screen needs
orders from the till even when the internet is down, since a dead internet
connection is a much more common failure than the local network going
down. The fix is to never route that traffic through the internet in the
first place — orders go from the till to the kitchen screen over the
outlet's own local network (a small local device or one of the terminals
acting as a hub), and the internet is only needed for syncing sales back
to HQ afterwards. That way the kitchen keeps working even during an
outage, and syncing to HQ is just something that catches up later.

---

## 8. Deployment

**Local development:** `docker-compose.yml` runs three containers —
Postgres, the Express API, and the React app served by nginx. One command
(`docker compose up --build`) starts all three; the API waits for Postgres
to report healthy before it starts, then applies migrations and seeds demo
data on its own.

**Configuration:** All configuration comes from environment variables,
validated once at startup (`server/src/config/index.js`). If something
required is missing — a JWT secret, for example — the app refuses to
start with a clear message instead of failing partway through the first
request. `.env` files are never committed; `.env.example` files document
what's needed.

**Production deployment:** The live instance runs on Render —
`render.yaml` in the repo describes all three pieces (Postgres, the API as
a Docker service, the frontend as a static site) so the whole setup can be
recreated from the repo itself rather than clicked together by hand in a
dashboard.

| Piece | Where |
|---|---|
| Frontend | Render static site — https://fnb-pos-web.onrender.com |
| Backend | Render web service (Docker) |
| Database | Render managed PostgreSQL |

---

## 9. Testing / Verification

The test suite runs against a real PostgreSQL database, not a mock. The
things being tested here — row locking, a stock update re-checking itself
after waiting on a lock, receipt numbers staying correct under load — are
behaviours of the database itself. A mock would only prove the code calls
the right functions, not that the actual guarantee holds.

**42 tests**, across six files:

| File | Covers |
|---|---|
| `sale.concurrency.test.js` | Many sales at once still get unique, gap-free receipt numbers; stock comes out exactly right; overselling is rejected cleanly; two carts listing the same items in opposite order don't deadlock |
| `rollback.test.js` | A forced failure after a real stock deduction rolls back the deduction, the sale, and the receipt number together |
| `isolation.test.js` | An outlet only ever sees its own menu, stock, and sales; role checks work in both directions |
| `pricing.test.js` | Price overrides apply correctly; a sale's price stays the same even if the menu price changes afterwards |
| `reports.test.js` | Report numbers are checked against numbers worked out by hand, not just checked against themselves |
| `void.test.js` | Voiding restores stock exactly once, even with ten simultaneous void attempts on the same sale |

Run with `npm test` inside `server/`.

There's also a standalone script, `scripts/concurrency-proof.mjs`, that
fires real concurrent requests at a running instance of the app (local or
deployed) and prints the actual results — receipt numbers, stock before
and after, which requests succeeded or failed — so the concurrency
behaviour can be checked directly, not just trusted from a test file.

---

## 10. What's not built

Worth stating plainly rather than leaving it implied:

- No tax, discounts, or ingredient-level stock (selling a burger deducts
  one "burger," not a bun and a patty separately).
- No offline mode — section 7 is a proposal, not a feature.
- No idempotency key on sales, since that's only needed for offline retry
  scenarios, which don't exist yet.

Everything else described in this document — the schema, the transaction
handling, the layering, the tests, the deployment — is in the repository
and running on the live instance linked at the top of this document.
