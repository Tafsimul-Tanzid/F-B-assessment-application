# Requirements traceability

Every line of the brief, mapped to where it is implemented and where it is
proven. Written so a reviewer can verify each item without hunting.

`npm test --prefix server` runs the tests referenced below.

---

## Master menu + outlet assignment

| Requirement | Implementation | Verified by |
|---|---|---|
| HQ creates master menu items | `POST /api/hq/menu-items` → [`menuItem.service.js`](../server/src/services/menuItem.service.js) | `pricing.test.js`, HQ console → Master menu |
| HQ assigns menu items to specific outlets | `POST /api/hq/outlets/:outletId/menu` → [`outletMenu.service.js`](../server/src/services/outletMenu.service.js) | `isolation.test.js`, HQ console → Outlets → Manage |
| HQ overrides menu price per outlet | `price_override` on `outlet_menu_items`; `PATCH .../menu/:menuItemId` | `pricing.test.js` — "charges the outlet override rather than the master base price" |
| Outlet retrieves **only** items assigned to it | `GET /api/outlet/menu`, scoped by JWT claim — no route accepts an outlet id | `isolation.test.js` — outlet A sees 3 items, outlet B sees 1 |

## Inventory management

| Requirement | Implementation | Verified by |
|---|---|---|
| Stock tracked per outlet | `inventory (outlet_id, menu_item_id)` composite PK | `0001-core-schema.js` |
| Sales deduct stock from outlet inventory | Guarded `UPDATE` in [`inventory.repository.js`](../server/src/repositories/inventory.repository.js) | `sale.concurrency.test.js` — "deducts stock exactly once per sale under concurrency" |
| System must prevent negative stock | `AND quantity >= $3` guard **plus** `CHECK (quantity >= 0)` backstop | `sale.concurrency.test.js` — "never oversells: 40 simultaneous buyers competing for 10 units" |

## Sales transaction

| Requirement | Implementation | Verified by |
|---|---|---|
| Create a sale with multiple items | `POST /api/outlet/sales` → [`sale.service.js`](../server/src/services/sale.service.js) | `pricing.test.js` — multi-line totals |
| Deduct stock per outlet | Deduction scoped by `outlet_id` from the JWT | `isolation.test.js` |
| Prevent negative stock | As above | `sale.concurrency.test.js` |
| Sequential receipt number per outlet | `outlet_receipt_counters` + `UPDATE … RETURNING` in a CTE | `sale.concurrency.test.js` — "keeps each outlet on its own receipt sequence" |
| **Receipt correct under concurrent requests** | Counter bumped last; row lock serialises | `sale.concurrency.test.js` — 50 simultaneous sales yield receipts 1–50, no duplicates, no gaps; plus [`scripts/concurrency-proof.mjs`](../scripts/concurrency-proof.mjs) on a live stack |
| Wrapped in database transaction | Single `sequelize.transaction()`, READ COMMITTED | `sale.concurrency.test.js` — "writes nothing at all when one line of a multi-item sale fails" |

## Reporting

| Requirement | Implementation | Verified by |
|---|---|---|
| Total revenue by outlet | `GET /api/hq/reports/revenue` → [`report.repository.js`](../server/src/repositories/report.repository.js) | `reports.test.js` — figures checked against hand-computed arithmetic |
| Top 5 selling items per outlet | `GET /api/hq/reports/top-items`, `ROW_NUMBER() PARTITION BY outlet_id` | `reports.test.js` — "returns at most five items per outlet by default" |

## Engineering requirements

| Requirement | Where |
|---|---|
| PostgreSQL | 16 (compose), connection in [`db/sequelize.js`](../server/src/db/sequelize.js) |
| Express.js / Node.js | Express 4 on Node 22 |
| React.js | [`web/`](../web) — Vite, HQ console + outlet POS |
| Layered architecture — routes | [`src/routes/`](../server/src/routes) — paths, validation, access control only |
| — controllers | [`src/controllers/`](../server/src/controllers) — HTTP in/out, no logic |
| — services | [`src/services/`](../server/src/services) — business rules, owns transactions |
| — repositories | [`src/repositories/`](../server/src/repositories) — all SQL; contract in its [README](../server/src/repositories/README.md) |
| Input validation | Zod schemas in [`src/validation/`](../server/src/validation) via [`validate.js`](../server/src/middleware/validate.js) |
| Error middleware | [`errorHandler.js`](../server/src/middleware/errorHandler.js) + [typed errors](../server/src/errors/index.js) + [SQLSTATE mapper](../server/src/db/errors.js) |
| Environment config | [`config/index.js`](../server/src/config/index.js) — validated once at boot; `process.env` read nowhere else |
| Database constraints | FKs, uniques and CHECKs in [`migrations/`](../server/migrations) — see README § Schema |
| Proper indexing | See [architecture.md § Indexes](architecture.md#indexes), including one index deliberately *not* created and why |
| Dockerfile | [`server/Dockerfile`](../server/Dockerfile) (multi-stage, non-root, healthcheck), [`web/Dockerfile`](../web/Dockerfile) |
| docker-compose | [`docker-compose.yml`](../docker-compose.yml) — one command, waits for Postgres *healthy* |
| Deployed instance | [`render.yaml`](../render.yaml) blueprint — **requires the reviewer's own hosting account to activate** |

## Deliverables

| Deliverable | Status |
|---|---|
| Deployed instance | Blueprint ready; see the README's Deployment section for current status |
| GitHub repository | See `git log --oneline` for the commit history |
| Proper folder structure | See README § Project layout |
| Clean commits | `git log --oneline` — one concern per commit, reasoning in each message |
| README — setup instructions | [README § Local Setup](../README.md#local-setup) |
| README — API endpoints | [README § API Documentation](../README.md#api-documentation) |
| README — schema explanation | [README § Database Schema](../README.md#database-schema) |
| README — architecture explanation | [README § Architecture](../README.md#architecture) |
| README — scaling strategy | [README § Scaling Strategy](../README.md#scaling-strategy) |

## Architecture documentation

| Requirement | Where |
|---|---|
| ERD diagram for schema and relationships | [architecture.md § 6 ERD](architecture.md#6-erd) — Mermaid, rendered by GitHub from source |
| System overview, request flow, frontend/backend architecture | [architecture.md §§ 1–4](architecture.md#1-system-overview) |
| Authentication, authorization | [architecture.md §§ 7–8](architecture.md#7-authentication) |
| Transaction, inventory concurrency and receipt number strategy | [architecture.md § 9](architecture.md#9-transaction-strategy-inventory-concurrency-and-receipt-numbering) |
| Error handling, validation | [architecture.md §§ 10–11](architecture.md#10-error-handling) |
| Scaling plan — database scaling strategies | [scaling.md § Database scaling](scaling.md#database-scaling) |
| Scaling plan — reporting performance | [scaling.md § Reporting performance](scaling.md#reporting-performance) |
| Scaling plan — infrastructure | [scaling.md § Infrastructure](scaling.md#infrastructure) |
| Scaling plan — architectural evolution | [scaling.md § Architectural evolution](scaling.md#architectural-evolution) |
| Conversion to microservices — which components and why | [microservices.md](microservices.md) |
| Offline POS — all 12 discussion points + POS/KDS communication | [offline-pos.md](offline-pos.md) |

## Beyond the brief

| Item | Why |
|---|---|
| Voids / credit notes | Stock returned, receipt number never reused, separate credit-note sequence, reports exclude voided money. `void.test.js` |
| JWT auth with roles | The brief implies HQ vs outlet separation; enforcing it in middleware makes per-outlet isolation a system property rather than a convention |
| `scripts/concurrency-proof.mjs` | So the concurrency claims can be reproduced on a live stack, not just asserted |

## Deliberately out of scope

Tax, discounts, ingredient-level BOM, and idempotency keys — none are in the
brief. Each is discussed in [README § Scope](../README.md#scope) with the design
it would take.
