# Microservices evolution

How this system could evolve into microservices, which components would
separate and why, and — just as importantly — why the current layered
monolith is the correct choice for this assessment rather than a compromise.

---

## Why the current modular monolith is reasonable here

At ten outlets and 100,000 transactions a month (the target discussed in
[`scaling.md`](scaling.md)) this system should **not** be split. A single
deployable with clean internal layering is faster to build, easier to
reason about, and — the part that matters most — able to keep stock
deduction and sale creation in one ACID transaction. Splitting into
services early would trade a correctness guarantee the business actually
depends on for scaling headroom it does not yet need.

The layering already present is what makes a later split tractable without
a rewrite: routes → controllers → services → repositories, with all SQL
confined to the repository layer (see
[`architecture.md`](architecture.md#4-backend-layered-architecture)). A
service extraction, when it eventually happens, means replacing a
repository call with a network call to another service — not untangling
business logic out of HTTP handlers first.

Microservices are not recommended here merely because they are a common
next step to mention. They are a real cost — network calls where there
were function calls, eventual consistency where there was a transaction,
and an operational surface (deployments, dashboards, on-call) that
multiplies with every service. That cost should only be paid against a
real, measured pressure — see the triggers in
[`scaling.md`](scaling.md#architectural-evolution).

---

## Candidate services

Boundaries follow how the data is *used*, not the table list.

| Service | Responsibility | Data ownership |
|---|---|---|
| **Identity** | Login, JWT issuance and verification, user/role management | `users` |
| **Catalog** | Master menu, outlet assignment, price overrides | `menu_items`, `outlet_menu_items` |
| **Sales + Inventory** | Sale creation, stock deduction, receipt/credit-note numbering, voids | `sales`, `sale_items`, `inventory`, `outlet_receipt_counters`, `outlet_credit_note_counters` |
| **Reporting** | Revenue and top-items aggregation | Read-only projection of sales data |

### Identity

**Why it might separate:** no business coupling to the rest of the system —
every other service only needs to verify a JWT's signature, never to query
the identity service on the request path. This is usually the first thing
extracted in any system, anywhere, because the boundary is already this
clean.

**Communication:** every other service verifies tokens locally (the JWT
secret, shared or via a public key); Identity is called only for
login/logout/user-management, not for every authenticated request.

**Scaling benefit:** login and user management have a completely different
load and security profile from the transactional core, and can scale (or
be locked down) independently.

**Consistency:** trivial — a user's identity does not need to agree with
anything else in real time.

### Catalog

**Why it might separate:** overwhelmingly read-heavy (outlets fetch their
menu far more often than HQ edits it) and changes rarely relative to
sales volume, making it the easiest read load to take off the transactional
database via caching.

**Data ownership:** owns `menu_items` and `outlet_menu_items` outright. The
Sales service needs to *read* effective prices at the moment of sale — see
Consistency below for why that read has to stay synchronous.

**Communication:** a synchronous call (or a well-cached local read) from
Sales, because price resolution happens inside the sale transaction and
cannot tolerate stale data the way a menu display screen can.

**Scaling benefit:** heavy read caching (a CDN or an in-memory cache in
front of "get this outlet's menu") without touching the transactional
database at all.

**Consistency:** eventual is fine for outlet-facing menu *display*; price
resolution for an actual sale still needs a strongly consistent read at
transaction time, which is why price resolution should call Catalog
synchronously rather than trust a cached copy for money-affecting decisions.

### Sales + Inventory — extracted together, or not at all

**Why they are one service, not two.** This is the substantive decision in
this document. The obvious-looking split — an Inventory service and a
separate Sales service — is the one to refuse. Today, "deduct stock and
record the sale" is one database transaction that either fully happens or
fully does not. Split across two services with separate databases, that
single `BEGIN...COMMIT` becomes a **saga**:

1. Sales asks Inventory to *reserve* stock — a new concept, with its own
   table, its own expiry semantics, and its own orphan-cleanup job for
   reservations that are never confirmed or released.
2. Sales records the sale.
3. If step 2 fails, Sales issues a compensating *release* to Inventory —
   which must itself be retried, made idempotent, and monitored for when
   it fails.

The failure modes multiply: a reservation that is never released leaks
stock; a compensation that itself fails leaves the two stores permanently
disagreeing; and "prevent negative stock" — currently a one-line database
guarantee (a `CHECK` constraint plus a guarded `UPDATE`) — becomes a
distributed-systems problem with a reconciliation process attached. That is
a large, permanent correctness cost paid in exchange for independently
scaling two components that scale together anyway: they are both driven by
exactly the same event, a customer buying something.

**Data ownership:** `sales`, `sale_items`, `inventory`, both receipt/credit
counters — one database, one transaction, unchanged from today.

**Communication:** publishes a `SaleCompleted` event (via the outbox
pattern — see below) for anything downstream that cares: Reporting, a
future loyalty service, a future kitchen-display integration.

**Consistency:** strong, transactional, non-negotiable — this is the one
place in the system where "maybe eventually consistent" would mean
sometimes selling stock that does not exist.

### Reporting — the one to extract first

**Why it separates cleanly:** read-only, no consistency requirement beyond
eventual, already sits behind a clean repository boundary with zero writes
in it, and its resource profile (analytical scans) genuinely differs from
the transactional core's (many small point writes). It delivers most of
the benefit of a split — independent scaling, independent deployment, no
risk to the sale path — at a fraction of the risk of touching Sales or
Inventory.

**Data ownership:** its own read-optimized copy of sale facts, kept current
by consuming `SaleCompleted` events rather than querying the Sales database
directly.

**Communication:** consumes events asynchronously; never called
synchronously by anything on the write path, and never calls anything on
the write path itself.

**Scaling benefit:** can run against a completely different kind of store
(a column-oriented warehouse, a materialized-view-heavy read replica)
without any of that choice touching the transactional system.

**Consistency:** eventual, by design — a report a few seconds behind is the
correct trade for never letting a report compete with a sale for database
resources.

---

## What the split requires, in general

- **Per-service data ownership.** No service reads another's tables
  directly; the moment two services share a table, they are one service
  with extra network hops and none of the benefits.
- **The outbox pattern for events.** Writing to Postgres and publishing to
  a message broker are not atomic — a crash between the two either loses
  the event or invents a duplicate. Write events to an `outbox` table *in
  the same transaction* as the business change, then relay them with a
  separate worker; the transaction that records a sale is exactly where its
  `SaleCompleted` event should be written.
- **Accept what is lost.** Cross-service joins (Reporting needs its own
  copy of outlet and item names, kept current by events, rather than a SQL
  join across a network boundary), single-transaction guarantees between
  services, and a great deal of operational simplicity. Four services need
  four pipelines, four dashboards, four on-call runbooks, and distributed
  tracing to debug what a single stack trace used to explain outright.
