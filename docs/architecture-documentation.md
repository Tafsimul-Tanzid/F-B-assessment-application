# F&B Multi-Outlet POS – Architecture Documentation

**Author:** Tafsimul Tanzid

**Repository:** https://github.com/Tafsimul-Tanzid/F-B-assessment-application
**Live application:** https://fnb-pos-web.onrender.com

---

## 1. ERD Diagram

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
        text name UK "unique"
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

This is the actual schema, generated from `server/migrations/`. It's not a
separate hand-drawn diagram, so it can't go out of sync with the real
database.

### Why the schema is shaped this way

**`outlet_menu_items` is its own table, not a column on `menu_items`.**
This is where the per-outlet price override lives. A single `price` column
on the menu item can't say "this outlet charges 13.50 for the same pizza
that's 12.00 somewhere else." The price a customer actually pays is
`COALESCE(price_override, base_price)`.

**`sale_items` copies the item name and price at the time of sale**,
instead of looking them up from the menu later. A receipt is a record of
what happened at that moment. If HQ changes a price next week, last week's
receipts and reports shouldn't change with it.

**Receipt numbers come from a counter table
(`outlet_receipt_counters`), not a Postgres `SEQUENCE`.** A `SEQUENCE` is
shared across the whole database and skips numbers when a transaction
rolls back — neither works for a receipt number that has to stay
sequential per outlet.

**Voiding a sale doesn't delete it.** It's marked `status = 'voided'` and
given its own number from a second counter
(`outlet_credit_note_counters`). The original receipt number is never
reused, and the sale stays in the history.

**Menu items get deactivated, not deleted.** A real `DELETE` on a menu
item would conflict with row locks that an in-progress sale for that item
already holds, so it could end up blocking a live sale. Setting
`is_active = false` avoids that and keeps old receipts intact.

### Foreign keys, unique constraints and indexes

| Constraint / Index | What it does |
|---|---|
| `outlets.company_id` FK, `outlets.code` UNIQUE | Every outlet belongs to one company; outlet codes don't collide |
| `users.outlet_id` FK | Ties outlet staff to their outlet; NULL for HQ |
| `outlet_menu_items` — composite PK `(outlet_id, menu_item_id)` | One assignment row per outlet/item pair |
| `inventory` — composite PK `(outlet_id, menu_item_id)`, `CHECK (quantity >= 0)` | Backstop against negative stock on any write path, not just sales |
| `sales` — `UNIQUE (outlet_id, receipt_no)` | The database refuses a duplicate receipt number per outlet |
| `sales` — `UNIQUE (outlet_id, credit_note_no)` | Same idea for void/credit note numbers |
| `sale_items` — index on `(sale_id)` | Postgres doesn't automatically index a foreign key column, only the side it points to. Without this, printing a receipt or running the top-items report would scan every sale item in the table |
| `sales` — partial index on `(outlet_id, sold_at)`, `WHERE status = 'completed'` | Lets the revenue report answer from the index alone, without reading the actual rows |

One index I left out on purpose: `sale_items(menu_item_id)`. The top-items
report groups rows it already has from a join on `sale_id` — it never
looks an item up by id, so that index would just add write cost with no
read benefit.

---

## 2. Scaling Plan — 10 outlets, ~100,000 transactions/month

**What's actually running now:** one Express instance, one Postgres
database, no cache, no queue, no read replica. The implementation doesn't
need to support the scale below — this section is about how it could
evolve to support it, not a claim that it already does.

Before listing changes, I want to do the actual math. 100,000 transactions
a month is about 3,300 a day, roughly 0.04 writes per second on average.
Even with a busy lunch/dinner rush across ten outlets, that's maybe 5–15
sales a second. A single Postgres instance can take that load today.
Nothing below is needed to hit this number — it's what I'd do if usage
grew well past it.

### Database scaling strategies

| Change | Why |
|---|---|
| **Connection pooling (PgBouncer, transaction mode)** | Each sale holds a database connection for its whole transaction. As more API instances run, the connection count adds up. PgBouncer lets many app connections share a smaller number of real Postgres connections |
| **Read replica for reports** | Reports read a range of sales; the till needs fast writes. Keeping them on separate connections, or a separate replica, stops a slow report from competing with a sale for resources |
| **Partitioning `sales`/`sale_items` by month** | Not needed yet — at this volume the tables stay small for years. I'd do this once cleaning up old data becomes a real need, since dropping an old partition is instant, but deleting millions of old rows one by one is not |

The indexes already in place (section 1) are the ones this workload
actually needs. At a bigger scale the same rule applies: add an index when
a specific slow query needs it, not ahead of time.

### Reporting performance considerations

The revenue report already runs off a covering index and stays fast. The
top-items report is the one that slows down as the number of sale line
items grows, since it scans however many rows fall in the requested date
range.

Two cheap things before anything bigger: cache the report response for a
short period (a dashboard doesn't need to update every second), and
require a date range instead of defaulting to "all time."

If that's still not enough, the next step is a small materialized view
that pre-aggregates daily sales per item, refreshed on a schedule. One
thing I'd avoid: keeping a running total updated inside the sale
transaction itself. That would make every sale of a popular item wait on
one shared row, which brings back the same contention problem the stock
deduction is built to avoid.

### Infrastructure considerations

The API doesn't keep anything in memory between requests — no session
state, no in-memory counters. That was on purpose, and it means running
two or three API instances behind a load balancer needs no code change.
The database is the bottleneck here, not the API.

A response cache in front of the two report endpoints is the only caching
this needs at this scale. I wouldn't cache menu or stock data — stock
changes on every sale and has to stay accurate.

If features like kitchen-display notifications, email receipts, or
loyalty points get added later, those should run as background jobs after
the sale transaction commits, not inside it — anything slow inside the
transaction just holds locks longer. An outbox table (write an "event
happened" row in the same transaction, process it afterwards) is a
standard way to do this without losing events if a background job fails.

### Architectural evolution

None of the above means giving up the single-transaction sale. Stock
deduction and sale creation happening together, or not at all, is the one
thing I wouldn't trade away for scale. The next section covers when it
would make sense to split parts of this into separate services.

---

## 3. Conversion to Microservices

At the current size, I wouldn't split this into microservices. A single
deployable with clean internal layers (routes → controllers → services →
repositories) is simpler to build and run, and it's what makes the sale
transaction possible in the first place. That layering is also what would
make a future split realistic without a rewrite — a service extraction
later would mean replacing a repository call with a network call, not
untangling business logic out of route handlers.

If this did grow into separate services, here's roughly how I'd split it:

| Service | Would own | Why it could split off |
|---|---|---|
| **Auth / Users** | Logins, JWT issuing | No real coupling to anything else — every other service just checks a token signature. Usually the first thing anyone splits out |
| **Menu** | Master menu, outlet assignment, price overrides | Read-heavy, changes rarely. Easy to cache separately from the transactional data |
| **Sales + Inventory** | Sales, sale items, stock, both counters | I'd extract these together, or not at all — see below |
| **Reporting** | Revenue and top-items aggregation | Read-only, no strict consistency needed. Lowest-risk thing to split first |

### Why Sales and Inventory stay together

Splitting these two sounds fine on paper, but it breaks the one guarantee
this system is built around. "Deduct stock and record the sale" is one
transaction today. Split into two services with two databases, that turns
into a multi-step process: reserve stock, record the sale, and if the sale
fails, release the reservation. Each of those steps can fail on its own,
which means extra code just to handle a reservation that never gets
released, or a release that itself fails. "Prevent negative stock," a
one-line database constraint today, turns into a background reconciliation
job. That's a lot of extra complexity for very little benefit, since sales
and inventory are driven by the same event anyway — someone buying
something.

Reporting is different. It's read-only, already sits behind its own
repository file with no writes in it, and splitting it off doesn't touch
the sale path at all.

---

## 4. Offline POS Mode Strategy

Everything in this section is a design, not code. The deployed system
needs an internet connection to create a sale. This explains how offline
sync could be added later.

**Local storage.** Each terminal would keep a small local database
(SQLite, or IndexedDB for a browser-based terminal) with its menu, its
last-known stock, and a queue of sales that haven't reached the server
yet.

**Creating a sale offline.** The sale gets written locally first, and the
receipt prints from that local write. Reaching the server happens after,
in the background. The terminal works the same way whether it's online or
not — syncing is a separate step that happens later.

**Local receipt numbers.** This is the hardest part, since the real
per-outlet counter lives on the server and isn't reachable offline. The
simplest fix is giving each terminal its own prefix, something like
`GUL01-T02-000417`, so two offline terminals can never produce the same
number. The cost is that the outlet no longer has one single unbroken
sequence, which is fine unless a tax rule specifically requires one.

**Sync queue and retrying.** Sales sit in a local queue and get sent to HQ
in order once the connection comes back, retried with backoff if a send
fails.

**Avoiding duplicate sales when syncing.** A sale sent twice by accident
(network drops right after the server saved it, before the terminal gets
the confirmation) must not create two sales at HQ. Each sale would carry a
unique id generated on the terminal when it's created. The server checks
that id before inserting — if it's already seen it, it returns the
existing sale instead of making a new one. This is the one schema change
offline mode would actually need. It's not in the database today because
it isn't needed while the system is online-only.

**Stock conflicts after reconnecting.** Two terminals offline at the same
time could both sell the last unit of something. When they reconnect, the
server can't undo either sale — the customer already has the item. Both
sales get accepted as real, stock gets clamped at zero instead of going
negative, and the difference gets logged for a manager to check against an
actual stock count later.

**How POS and KDS keep working and talking to each other offline.** The
kitchen screen needs to keep getting orders even when the internet is
down, and a dead internet connection is far more common than the local
network at the outlet going down. So the fix is to not route POS-to-KDS
traffic through the internet at all. Orders would go from the till to the
kitchen screen over the outlet's own local network — either a small
always-on device at the outlet acting as a hub, or one of the terminals
itself taking that role. The internet connection is only needed for
syncing sales back to HQ, never for the POS and KDS to talk to each other.
That way the kitchen keeps working during an outage, and two things matter
for it to actually hold up:

- **Tickets are saved locally on both sides.** If a terminal or the
  kitchen screen restarts, it should reload from local storage instead of
  losing whatever was in progress.
- **The POS waits for the KDS to confirm it got the order**, not just that
  it was sent. If a ticket doesn't get confirmed, the POS retries it and
  flags it for staff rather than assuming it arrived.

Syncing to HQ is a separate, secondary concern that catches up once the
internet comes back — it never blocks the kitchen from getting orders in
the meantime.
