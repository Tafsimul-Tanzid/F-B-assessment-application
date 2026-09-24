# Architecture

This document covers the database design, how the system would evolve to
support ten outlets at 100,000 transactions a month, how it could be broken
into services, and how offline terminals would work.

The implementation does not need to operate at that scale today. What follows
is the reasoning for how it would get there, and — just as importantly — which
steps should *not* be taken early.

---

## 1. Data model

### ERD

```mermaid
erDiagram
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

    OUTLETS {
        uuid id PK
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

### The four decisions worth explaining

**Assignment is its own table, not a column.** `outlet_menu_items` is the join
between the master menu and an outlet, and it is where the per-outlet price
override lives. A single `price` column on `menu_items` could not express "the
airport kiosk charges 5.75 for the same latte that costs 4.50 downtown", and a
price column per outlet would mean a schema change for every new outlet.
`COALESCE(price_override, base_price)` resolves the effective price in one
expression.

**`sale_items` snapshots the name and price.** A receipt is a financial
record. If reports re-derived prices by joining the live menu, then every HQ
price change would silently restate historical revenue, and unassigning an
item would make past sales of it disappear from reports entirely. Three extra
columns per line buy immutability, and they make the revenue report a
two-table query rather than a four-table one.

**Receipt numbers come from a counter table, not a sequence.** A Postgres
`SEQUENCE` is global rather than per-outlet, and it is gappy by design — a
rolled-back transaction never returns its number. `outlet_receipt_counters`
gives each outlet its own counter, incremented and read atomically inside the
sale transaction. Section 2 covers the locking.

**Voids keep the sale and number themselves separately.** Voiding does not
delete the sale or free its receipt number — the sale happened, and the books
must show both it and the correction. The sale is marked `voided`, stock is
returned, and a credit note is allocated from `outlet_credit_note_counters`,
a sequence deliberately distinct from receipts so the two document types can
never be confused in an audit. Concurrent double-voids are prevented by the
same guarded-update pattern as stock deduction: `AND status = 'completed'` in
the `WHERE` clause means the loser of a race re-evaluates against the
committed row and matches nothing.

**Menu items deactivate rather than delete.** Besides preserving historical
references, a hard `DELETE` takes a `FOR UPDATE` lock on the `menu_items` row,
which conflicts with the `FOR KEY SHARE` lock that every concurrent
`INSERT INTO sale_items` takes on it. A single HQ deletion would block — and
could deadlock against — in-flight sales of that item at every outlet
simultaneously.

### Indexes

| Index | Why it exists |
|---|---|
| `inventory (outlet_id, menu_item_id)` PK | The stock deduction is a single-row lookup; also the canonical lock-ordering key |
| `outlet_menu_items (outlet_id, menu_item_id)` PK | Outlet menu fetch and price resolution |
| `outlet_receipt_counters (outlet_id)` PK | The lock target — must be an exact lookup, never a scan |
| `sales (outlet_id, receipt_no)` UNIQUE | The per-outlet sequence invariant itself, enforced by the database |
| `sale_items (sale_id)` | **Not automatic.** Postgres indexes a foreign key's *target*, never the referencing column. Without it, receipt reprint and the top-items join both sequential-scan |
| `sales (outlet_id, sold_at) INCLUDE (total_amount) WHERE status = 'completed'` | Makes the revenue report an index-only scan. Partial, because every report counts completed sales only, so voided rows would be dead weight. `sold_at` is monotonic, so inserts land at the right edge of the B-tree with minimal page splitting |
| `users (email)` UNIQUE | Login |

**Deliberately omitted: `sale_items (menu_item_id)`.** The top-items report
hash-aggregates rows it already has via the `sale_id` join — it never looks an
item *up* by id. The index would cost a B-tree insert per **line item** (several
times the per-sale cost of a `sales` index) against a random UUID, dirtying a
random leaf page on every write. It is worth adding the moment a "where has
item X sold" query ships, and not before.

---

## 2. The sale transaction

Everything the brief asks for in one place, so the ordering is visible:

```
BEGIN (READ COMMITTED, lock_timeout = 3s)
  1. resolve prices from the outlet's own menu        no locks
  2. deduct stock, ascending menu_item_id             inventory row locks
  3. bump receipt counter + insert the sale           counter row lock
  4. insert line items
COMMIT
```

**Preventing negative stock.** The guard lives in the `WHERE` clause:

```sql
UPDATE inventory SET quantity = quantity - $3
 WHERE outlet_id = $1 AND menu_item_id = $2 AND quantity >= $3
RETURNING quantity;
```

When a concurrent transaction holds the row lock, this statement blocks; when
that transaction commits, Postgres does **not** continue from this
transaction's original snapshot. It re-reads the newly committed row and
re-evaluates the whole `WHERE` clause, guard included. The check is therefore
always made against the latest committed quantity, and a lost update cannot
occur. Doing that comparison in application code would be wrong twice over: it
would race, and `numeric` arrives from the driver as a *string*, where
`"9" >= "10"` is `true`.

A `CHECK (quantity >= 0)` constraint also exists, as a backstop rather than
the mechanism. It defends the paths that do not go through the sale service —
restocks, corrections, future admin tooling, and bugs. If it ever fires, that
is logged at ERROR, because it means a guard was bypassed.

**Why the counter is bumped last.** Postgres holds row locks until commit, so
whenever the counter is bumped it stays locked for the rest of the
transaction. Bumping it first would make it a per-outlet global mutex held
across every stock update and every network round trip, capping the outlet at
roughly one sale per transaction duration, and it would burn a receipt number
on every validation failure. Bumping it after stock has been deducted holds it
only across two inserts and the commit.

The cost of that choice is that lock acquisition order becomes load-bearing:
inventory locks are always taken *before* the counter lock. The counter bump
therefore lives in exactly one function with exactly one caller, so no future
code path can invert the order.

**Why deadlock is structurally impossible.** Line items are aggregated by
`menu_item_id` (so a cart listing the same item twice deducts the sum, once)
and then deducted sequentially in ascending id order. Every sale in the system
acquires inventory locks in that same global order, so two concurrent sales
touching the same items can never hold them in opposite orders, and no wait
cycle can form. A test fires twenty concurrent two-item sales with the items
deliberately listed in opposite orders and asserts they all succeed.

**Why READ COMMITTED rather than something stricter.** Both mutations are
single statements that read and write in one step, which is exactly the case
READ COMMITTED's re-evaluation handles correctly. REPEATABLE READ would be
strictly worse here: it raises a serialization failure whenever two
transactions touch the same row, which for a POS is the *ordinary* case — two
cashiers selling the same popular item, or any two sales at one outlet hitting
the same counter row — forcing full retries for no correctness gain.

**On gaps.** No in-transaction scheme can be strictly gapless: the number must
be allocated before `COMMIT`, and `COMMIT` can fail. Allocating last confines
gaps to infrastructure failures occurring after all validation has passed. If
a tax authority required provably gapless numbering, the answer would be an
audited "unused receipt" ledger, not a different locking strategy.

---

## 3. Scaling to 10 outlets / 100,000 transactions per month

### Start with the arithmetic

100,000 transactions a month is **~3,300 per day**, or **0.04 writes per
second** averaged out. Even concentrated into two lunch and dinner peaks across
ten outlets, the realistic peak is **5–15 sales per second**, each one a short
transaction touching a handful of rows.

This is small. A single modestly-sized Postgres instance handles it with room
to spare — the measured figures above show fifty concurrent sales completing in
133 ms on a laptop container. The honest engineering answer is that **the
current design needs no structural change to reach this scale**; what follows
is what to do as headroom erodes, in the order the pressure actually arrives.

Proposing sharding for 0.04 writes per second would be the wrong answer, and
recognising that is the point of this section.

### 3.1 Database

**Connection pooling comes first.** This is the real constraint, well before
CPU or disk. Each in-flight sale pins a connection for the duration of its
transaction, and Postgres connections are expensive (several MB each, plus a
backend process). With several API instances each holding a pool, the
connection count multiplies quickly.

Introduce **PgBouncer in transaction mode**, which returns the connection to
the pool at commit rather than at disconnect, letting hundreds of application
connections share tens of server ones. The application is already compatible:
every query is parameterised and no state is carried across transactions.
Caveat to note explicitly — transaction mode breaks session-level features
(prepared statement caching, advisory locks held across statements, `LISTEN`),
none of which this design relies on.

**Separate reporting from the write path.** Reports scan ranges of sales while
the till needs sub-100ms writes; a heavy report should never compete for the
same buffer pool and connections. Add a **streaming read replica** and route
the two report endpoints to it. Replication lag of a second or two is
irrelevant for a revenue dashboard, and the application layer is already
clean — reporting queries live in one repository file with no writes in them.

**Partition when the row count, not the transaction rate, demands it.** At
100k sales a month with ~3 lines each, `sale_items` grows by ~3.6M rows a
year. Postgres handles tens of millions of rows in a well-indexed table
without complaint, so partitioning is *not* needed at this scale. When it is —
say past 50M rows, or when retention policy requires cheap deletion — partition
`sales` and `sale_items` by month using declarative range partitioning. The
payoff is not query speed so much as operational: dropping a partition is
instant where a `DELETE` of millions of rows is a vacuum problem.

**Retention and archival.** Define this before it is urgent: keep detailed
line items hot for 13 months (so year-on-year comparison works), then roll
older data into monthly aggregates and move the detail to cold storage.

### 3.2 Reporting performance

Today both reports run directly against `sales` and `sale_items`. The revenue
report is served by the covering index as an index-only scan and will stay fast
for years. The top-items report aggregates line items and is the one that
degrades first, because its cost grows with the number of rows in the period
rather than with the number of outlets.

When it does, the right escalation is a **materialised view** —
`mv_daily_item_sales (outlet_id, business_date, menu_item_id, units, revenue)`
— refreshed `CONCURRENTLY` on a schedule, off the hot path. Reports then query
pre-aggregated daily rows, reducing a scan of millions of line items to a scan
of thousands.

It is worth being explicit about the alternative that should be **rejected**: a
rollup table upserted inside the sale transaction. It sounds appealing (always
current, no refresh job) but it would serialise every sale of a popular item at
an outlet on a single `(outlet_id, date, item)` row — recreating exactly the
hot-row contention this design took care to avoid — and it would extend the
lock-hold window past the counter bump, reopening the deadlock question the
ordering rule closed. Correctness of the write path outranks freshness of a
dashboard.

Two cheaper wins first, in order: **cache** the report response for 30–60
seconds (a revenue dashboard does not need to be current to the second, and
this alone absorbs a room full of managers refreshing), and **require a bounded
date range** rather than defaulting to all-time as the dataset grows.

### 3.3 Infrastructure

**The API is already horizontally scalable** and this was a design choice, not
luck: it holds no in-process state. Sessions are stateless JWTs, receipt
numbers come from the database rather than an in-memory counter, and nothing is
cached in a module-level variable. Running three instances behind a load
balancer requires no code change.

| Concern | Approach |
|---|---|
| Availability | ≥2 API instances across zones; managed Postgres with a standby |
| Backups | Automated daily snapshots **plus** point-in-time recovery — for financial records, "restore to just before the incident" matters more than the snapshot |
| Deploys | Rolling, gated on `/health` (which pings the database, so an instance that cannot reach Postgres never receives traffic) |
| Logs | Already structured JSON with a request id on every line and in every error body; ship to a searchable store |
| Tracing | Propagate the existing request id as a trace id; a slow sale should be attributable to a specific lock wait |

**Metrics that actually matter here**, as opposed to generic dashboards:

- p99 **sale** latency specifically, not overall request latency — reports and
  the till have completely different profiles and averaging them hides both
- **lock wait time** and `lock_timeout` firings — the leading indicator that
  the counter or a hot item is becoming a bottleneck
- **deadlock count** — should be zero; any non-zero value means the lock
  ordering rule has been violated by new code
- **connection pool saturation** — the first thing to break under load
- **any `23514` check violation** — should be impossible, and means a write
  path bypassed the stock guard. Alert on it rather than merely logging it

### 3.4 Application-level

- **Size the pool against peak concurrent sales**, not requests per second —
  a sale holds its connection for the whole transaction.
- Set `idle_in_transaction_session_timeout` server-side, so an application
  crash mid-transaction cannot pin locks until TCP keepalive notices.
- **Keep slow work outside the transaction.** Receipt printing, kitchen display
  push, loyalty callouts and SMS must all happen *after* `COMMIT`. Every
  millisecond spent on them before commit is a millisecond of held locks. This
  is the single easiest way to destroy the concurrency properties above.

---

## 4. Evolution to microservices

### The honest precondition

At ten outlets this system should **not** be split. A single deployable with
clean internal layering is faster to build, easier to reason about, and — the
part that matters most here — able to keep stock deduction and sale creation in
one ACID transaction. Splitting early would trade a guarantee the business
actually depends on for scaling headroom it does not yet need.

The layering already present is what makes a later split tractable: routes →
controllers → services → repositories, with all SQL confined to the repository
layer. A service extraction means replacing a repository call with a client
call, not untangling business logic from HTTP handlers.

### Where the seams are

Boundaries follow how the data is *used*, not the table list.

| Candidate service | Owns | Why it separates cleanly |
|---|---|---|
| **Identity** | users, auth, tokens | No business coupling; every service only needs to verify a signature. Usually the first thing extracted anywhere |
| **Catalog** | master menu, outlet assignment, price overrides | Overwhelmingly read-heavy, changes rarely, highly cacheable. Its read load is the easiest to take off the transactional database |
| **Sales + Inventory** | sales, sale_items, receipt counters, inventory | The transactional core. Extract **together or not at all** — see below |
| **Reporting** | read-only aggregation | No writes, no consistency requirements beyond eventual. **Extract this first** |

### The decision that matters: Sales and Inventory stay together

The obvious-looking split — an Inventory service and a Sales service — is the
one to refuse. Today, "deduct stock and record the sale" is one transaction
that either fully happens or fully does not. Split across two services with
separate databases, that single `BEGIN…COMMIT` becomes a **saga**:

1. Sales asks Inventory to *reserve* stock (a new concept, with its own table,
   its own expiry semantics and its own orphan-cleanup job).
2. Sales records the sale.
3. If step 2 fails, Sales issues a compensating *release* — which must itself
   be retried, made idempotent, and monitored for when it fails.

The failure modes multiply: a reservation that is never released leaks stock;
a compensation that fails leaves the two stores permanently disagreeing; and
"prevent negative stock", currently a one-line database guarantee, becomes a
distributed-systems problem with a reconciliation process attached. That is a
large, permanent correctness cost in exchange for independent scaling of two
components that scale together anyway — they are both driven by exactly the
same event, a customer buying something.

**Extract Reporting first.** It is read-only, it has no consistency
requirement beyond eventual, it already sits behind a clean repository
boundary, and it is the component whose resource profile genuinely differs
from the rest. It delivers most of the benefit of a split at a fraction of the
risk.

### What the split requires

- **Per-service data ownership.** No service reads another's tables directly;
  the moment two services share a table, they are one service with extra
  network hops.
- **The outbox pattern for events.** Writing to Postgres and publishing to a
  broker are not atomic — a crash between them loses the event or invents one.
  Write events to an `outbox` table *in the same transaction* as the business
  change, then relay them; the transaction that records a sale is exactly where
  its `SaleCompleted` event should be written.
- **Accept what is lost:** cross-service joins (the reporting service needs its
  own copy of outlet and item names, kept current by events), single-transaction
  guarantees, and a great deal of operational simplicity. Four services need
  four pipelines, four dashboards, four on-call runbooks and distributed
  tracing to debug what a single stack trace used to explain.

---

## 5. Offline POS mode

An outlet's internet connection is the least reliable part of this system, and
it is also the part that must never stop a customer being served. The design
principle is that **the WAN link is required for head-office synchronisation,
never for service**.

### 5.1 Local-first terminal

Each terminal keeps a local store (SQLite on a native terminal, IndexedDB in a
browser-based one) holding:

- the outlet's assigned menu and effective prices, refreshed while online;
- its own view of stock;
- an **append-only outbox** of sales that have not yet reached HQ.

A sale is written to the local store and the outbox first, and the receipt
prints immediately. Reaching HQ is a background concern. The terminal is
therefore not "degraded" when offline — the offline path is the same code path,
with synchronisation running behind it.

### 5.2 Receipt numbering offline

This is the hardest part, because the central counter is exactly what is
unreachable. Two workable approaches:

**Terminal-scoped numbering (simpler).** Each terminal issues receipts under
its own namespace: `DT01-T02-000417`. Uniqueness is guaranteed by
construction, no coordination is needed, and the terminal is identifiable from
the receipt — useful when reconciling a till. The cost is that the outlet no
longer has one unbroken sequence, which matters only if a tax regime demands
it.

**Pre-allocated blocks (stricter).** While online, a terminal leases a block of
numbers from HQ (say 401–600) by bumping the counter by the block size in one
transaction. Offline, it allocates from its lease. This preserves a single
per-outlet sequence at the cost of gaps when a block is only partly used, plus
lease-exhaustion handling — a terminal offline longer than its lease must fall
back to terminal-scoped numbering rather than refuse to sell.

The approach to **avoid** is a naive local counter per terminal with no
namespace: two terminals offline simultaneously both issue receipt #418, and
the collision is discovered at sync time, after both customers hold a printed
receipt. The `UNIQUE (outlet_id, receipt_no)` constraint would then reject the
second sale — losing a real, completed transaction to protect a number.

### 5.3 Sync on reconnect

The outbox replays in order. The essential requirement is **idempotency**:
connectivity failures characteristically strike *after* the server has
committed but *before* the response arrives, so a replay must not double-charge
the customer.

Each sale carries a client-generated `client_request_id` (a UUID minted when
the cashier tapped Charge). The server adds
`UNIQUE (outlet_id, client_request_id)` and, on conflict, returns the
**existing** sale rather than creating a second one. Replay then becomes safe
by construction, and the terminal can retry as aggressively as it likes.

This is a deliberate note about the current implementation: that column is
**not** built, because online the client sees a definitive response and the
brief does not ask for offline support. It is the one schema addition the
offline mode requires, and it is additive — a column, a constraint, and a
lookup before insert.

### 5.4 Conflict resolution

**Sales never conflict with each other.** They are append-only facts about
things that already happened; two terminals selling simultaneously produce two
sales, not a conflict.

**Stock is where the real conflict lives.** Two terminals offline can each sell
the last croissant. On reconnect, the server's stock is authoritative and will
have gone negative in aggregate — except it cannot, because of the CHECK
constraint.

The resolution must start from a business fact, not a data-integrity
preference: **the customer already has the croissant.** Rejecting the sale
would mean the books show less revenue than the till took, which is worse than
an inaccurate stock count. So:

1. Accept both sales. They are historical facts.
2. Clamp stock at zero rather than allowing negative.
3. Record a **variance exception** (item, outlet, expected vs actual, the
   terminals involved) for the manager to reconcile.

Stock accuracy is recovered by a count; a lost transaction is not recoverable
at all. Offline stock limits should also be conservative — a terminal that has
been offline for an hour should warn on low-stock items rather than promising
availability it cannot verify.

### 5.5 POS ↔ KDS during an outage

The kitchen display must keep receiving orders when the WAN is down but the LAN
is up, which is the overwhelmingly common failure (a dead uplink, not dead
switches). Routing an order from a till to a screen four metres away via a
cloud service is a design that fails exactly when the restaurant is busiest.

**Order flow stays inside the outlet: POS → local hub → KDS.** The WAN is used
only for HQ synchronisation.

The local hub is either:

- **A small always-on device at the outlet** (the manager's mini-PC, or a
  Raspberry Pi) running a LAN broker — MQTT or a WebSocket server. Predictable,
  easy to reason about, and it can also hold the outlet's authoritative offline
  stock, which removes the terminal-vs-terminal conflict in 5.4 entirely. The
  cost is a piece of hardware per site.
- **An elected peer**, where terminals discover each other over mDNS and elect
  one as hub. No extra hardware, but leader election and split-brain handling
  on a shop floor is materially harder to get right.

Either way, three properties are required:

1. **Heartbeats and re-election.** If the hub dies mid-service the kitchen must
   not go dark; terminals detect the loss and promote another node. Orders
   queued locally during the gap are replayed to the new hub.
2. **Local persistence of open tickets.** A power cycle must not lose in-flight
   orders. Tickets are written to disk on both the POS and the KDS, so a
   rebooted screen redraws what is still cooking rather than starting blank.
3. **Acknowledgement, not fire-and-forget.** The POS marks a ticket "sent" only
   once the KDS acknowledges it; unacknowledged tickets are retried and surfaced
   to staff. A ticket silently lost between till and kitchen is the failure
   mode that actually costs a restaurant money.

The same outbox that syncs sales to HQ is what makes this coherent: the
kitchen path and the HQ path are both consumers of a durable local log, so
neither depends on the other being available.
