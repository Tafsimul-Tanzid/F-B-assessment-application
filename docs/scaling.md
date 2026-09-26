# Scaling

How this system would evolve to support **10 outlets and 100,000
transactions a month**. The current implementation does not need to operate
at that scale — every section below is explicit about what exists today
versus what is proposed for later, and does not claim more than has actually
been built.

---

## Start with the arithmetic

100,000 transactions a month is **~3,300 per day**, or **0.04 writes per
second** averaged out. Even concentrated into two lunch and dinner peaks
across ten outlets, the realistic peak is **5–15 sales per second**, each
one a short transaction touching a handful of rows.

This is small. A single modestly-sized Postgres instance handles it with
room to spare — [`scripts/concurrency-proof.mjs`](../scripts/concurrency-proof.mjs)
shows fifty concurrent sales completing in 133 ms on a laptop container.
Proposing sharding for 0.04 writes per second would be the wrong answer, and
recognising that is the point of this document: the sections below describe
what to do **as headroom actually erodes**, not a queue of upgrades to apply
on day one.

> **CURRENT IMPLEMENTATION:** a single Express instance, a single PostgreSQL
> database, no cache, no queue, no read replica. This comfortably serves the
> assessment's scope and the 10-outlet target above.

---

## Database scaling

> **CURRENT IMPLEMENTATION:** one PostgreSQL database, a Sequelize
> connection pool sized by `DB_POOL_MAX`/`DB_POOL_MIN`, standard B-tree
> indexes (see [`architecture.md`](architecture.md#indexes)), no partitioning,
> no replica, no external pooler.

**FUTURE SCALING PLAN**, in the order pressure actually arrives:

**Connection pooling comes first.** This is the real constraint, well
before CPU or disk. Each in-flight sale pins a connection for the duration
of its transaction, and Postgres connections are expensive (several MB
each, plus a backend process). With several API instances each holding a
pool, the connection count multiplies quickly. Introduce **PgBouncer in
transaction mode**, which returns a connection to the pool at commit rather
than at disconnect, letting hundreds of application connections share tens
of server ones. The application is already compatible: every query is
parameterised and no session state is carried across statements. One
caveat worth noting: transaction mode breaks session-level features
(prepared statement caching, advisory locks held across statements,
`LISTEN`) — none of which this design relies on.

**Read replicas separate reporting from the write path.** Reports scan
ranges of sales while the till needs sub-100ms writes; a heavy report
should never compete for the same buffer pool and connections as a sale.
Add a streaming read replica and route both report endpoints to it.
Replication lag of a second or two is irrelevant for a revenue dashboard,
and the application layer is already structured for this — every reporting
query lives in one repository file with no writes in it.

**Query optimization** stays largely unnecessary at this scale: the
revenue report already runs as an index-only scan against a covering
index, and the top-items report is a single aggregation query. The one
query to watch is the top-items report, because its cost grows with the
number of rows in the reporting *period* rather than with the number of
outlets — covered under Reporting below.

**Partitioning is deliberately not implemented, because it is not yet
justified.** At 100k sales a month with ~3 lines each, `sale_items` grows
by roughly 3.6M rows a year. Postgres handles tens of millions of rows in a
well-indexed table without complaint. Partition `sales` and `sale_items`
by month, using declarative range partitioning, once the table passes
roughly 50M rows or once a retention policy requires cheap deletion of old
data — dropping a partition is instant where a `DELETE` of millions of
rows is a vacuum problem.

**Backups and recovery.** Automated daily snapshots **plus** point-in-time
recovery (WAL archiving) — for financial records, "restore to just before
the incident" matters more than a nightly snapshot. Most managed Postgres
providers (RDS, Neon, Render's paid tier) offer this as a checkbox, not a
build.

---

## Reporting performance

> **CURRENT IMPLEMENTATION:** both reports run directly against `sales` and
> `sale_items` with no caching and no pre-aggregation. The revenue report is
> served by a partial covering index as an index-only scan; the top-items
> report is a single `ROW_NUMBER() OVER (PARTITION BY outlet_id ...)` query.

**FUTURE SCALING PLAN:**

The revenue report will stay fast for years purely on the covering index.
The top-items report is the one that degrades first, because its cost
scales with the number of `sale_items` rows in the requested period rather
than with the number of outlets.

Two cheap wins come before any architectural change: **cache** the report
response for 30–60 seconds (a revenue dashboard does not need to be current
to the second, and this alone absorbs a room full of managers refreshing
the page), and **require a bounded date range** rather than defaulting to
all-time as the dataset grows.

When caching is no longer enough, the right escalation is a **materialized
view** — `mv_daily_item_sales (outlet_id, business_date, menu_item_id,
units, revenue)` — refreshed `CONCURRENTLY` on a schedule, off the hot
path. Reports then query pre-aggregated daily rows, turning a scan of
millions of line items into a scan of thousands.

It is worth being explicit about the alternative that should be
**rejected**: a rollup table upserted inside the sale transaction. It
sounds appealing (always current, no refresh job) but it would serialise
every sale of a popular item at an outlet onto a single
`(outlet_id, date, item)` row — recreating exactly the hot-row contention
the current design took care to avoid — and it would extend the lock-hold
window past the receipt counter bump, reopening the deadlock question the
lock-ordering rule already closed. Correctness of the write path outranks
freshness of a dashboard.

If reporting eventually needs genuinely separate analytical workload (ad
hoc queries, exports, BI tooling), that traffic should be **separated
entirely** onto the read replica above or a dedicated analytical store —
never allowed to compete with the transactional database at all.

---

## Infrastructure

> **CURRENT IMPLEMENTATION:** one containerized API instance, one
> containerized Postgres instance (or a managed equivalent in production),
> structured JSON logs with a request id on every line, and a `/health`
> endpoint that pings the database.

**FUTURE SCALING PLAN:**

**The API is already horizontally scalable, by design rather than luck.**
It holds no in-process state: sessions are stateless JWTs, receipt numbers
come from the database rather than an in-memory counter, and nothing is
cached in a module-level variable. Running three instances behind a load
balancer requires no code change — only infrastructure.

| Concern | Approach |
|---|---|
| Load balancing | A standard reverse proxy or platform load balancer in front of ≥2 API instances |
| Horizontal API scaling | Stateless by construction (above); scale by instance count, not by rewriting |
| Containers | Already containerized (`server/Dockerfile`, `web/Dockerfile`); orchestrate with the platform's own scaler once beyond one host |
| Availability | ≥2 API instances across zones; managed Postgres with a standby |
| Monitoring | p99 **sale** latency specifically (not blended with report latency — the two have completely different profiles); lock wait time and `lock_timeout` firings; deadlock count (should be zero — any non-zero value means the lock-ordering rule was violated by new code); connection pool saturation; any `23514` check violation (should be impossible — alert on it, don't just log it) |
| Logging | Already structured JSON with a request id in every log line and every error response; ship to a searchable store (e.g. CloudWatch, Loki) once there is more than one instance to correlate across |
| Health checks | Already implemented (`/health` pings the database); use it to gate rolling deploys so an instance that cannot reach Postgres never receives traffic |

---

## Architectural evolution

> **CURRENT IMPLEMENTATION:** a single layered monolith — one deployable,
> one database, strict internal layering (routes → controllers → services →
> repositories). No background jobs, no queue, no cache.

**FUTURE SCALING PLAN**, staged by the trigger that would justify each step
— none of this should happen on a fixed schedule:

**Stage 0 — stay here.** At 10 outlets and 100k transactions a month this
is the correct architecture. Nothing below is a queue of upgrades; each is
a response to a measured problem.

**Stage 1 — enforce module boundaries inside the monolith**, triggered by
the team growing past the point where everyone knows the whole codebase, or
by changes to reporting starting to break the till. Group the existing
layers by domain rather than by technical role (`catalog/`, `inventory/`,
`sales/`, `reporting/`, each owning its own routes/services/repositories)
and forbid cross-domain repository imports. This is a directory move plus a
lint rule — no runtime change — and it is the step that makes every later
stage tractable, because a future service extraction then means replacing
one service-interface call with a network call.

**Stage 2 — separate the read path from the write path**, triggered by
reports measurably competing with the till (p99 sale latency rising when
someone opens the dashboard). Point reporting at the read replica above,
then materialize the aggregates if it is still slow. The trade-off being
bought is staleness: a dashboard a minute behind is fine, a till a minute
behind is not — which is exactly why the split runs along this line.

**Stage 3 — move non-transactional work out of the request**, triggered by
slow work getting added to checkout (kitchen display push, receipt
printing, loyalty accrual, e-receipt email). Introduce a **background
job / queue**: an outbox table written inside the sale transaction and a
worker that relays from it. Every one of those features is a candidate for
being bolted on inline, and each would extend the lock-hold window of the
sale transaction — degrading exactly the concurrency properties documented
in [`architecture.md`](architecture.md#9-transaction-strategy-inventory-concurrency-and-receipt-numbering).
The outbox is also the precondition for asynchronous reporting and for
offline sync (see [`offline-pos.md`](offline-pos.md)).

**Stage 4 — extract services, if and only if the pressure is real**
(independent scaling or independent deployment becomes a genuine
constraint, not a preference). Covered in full in
[`microservices.md`](microservices.md): extract Reporting first, and keep
Sales and Inventory together permanently.

**What deliberately does not change at any stage.** The API stays
stateless, so horizontal scaling remains free. The sale stays a single ACID
transaction — every stage above is designed to leave that untouched,
because it is the one property that makes "prevent negative stock" a
one-line database guarantee rather than a distributed-systems problem. And
Postgres stays the system of record; adding a second datastore before
Postgres is demonstrably the bottleneck buys a consistency problem in
exchange for nothing.
