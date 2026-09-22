# Repository layer

The data access layer. **All** SQL and all Sequelize model access lives here —
nothing above this directory imports a model or writes a query.

## Contract

1. **A repository never opens a transaction; it receives one.**
   Transaction boundaries are a business concern and belong to the service
   layer. A repository that called `sequelize.transaction()` itself would make
   it impossible to compose several repository calls into one atomic unit —
   which is exactly what the sale path needs.

2. **Every method takes an options object with `{ transaction }` as its last
   parameter.** It is optional for standalone reads (a login lookup needs no
   transaction) and **required** for anything on the sale write path, which
   asserts its presence and throws otherwise.

   This is deliberately explicit rather than using `Sequelize.useCLS()`. An
   ambient transaction is invisible at the call site, so the lock-acquisition
   order of the sale path could not be audited by reading the service function
   top to bottom. The failure it guards against is also nasty: a query that
   silently omits the transaction checks out a *different* pooled connection,
   runs outside the transaction, and then blocks forever on a row lock its own
   request is holding — a self-deadlock Postgres cannot detect, because it is
   two separate sessions rather than a cycle of waits.

3. **Repositories return plain data, not HTTP concerns.** They throw typed
   errors from `src/errors` (never build a response), and they never touch
   `req`/`res`.

4. **Raw SQL where the ORM cannot express the requirement.** The ORM is used
   for straightforward finds and inserts. It is dropped for:
   - the guarded stock deduction (`... AND quantity >= $3 RETURNING`), which
     `Model.decrement` cannot express — it generates no guard predicate;
   - the receipt counter bump fused with the sale insert (a data-modifying
     CTE);
   - the two reports (window functions, predicate placement in a `LEFT JOIN`).

   Raw queries use `bind` (`$1`, a real server-side parameter) rather than
   `replacements` (`:name`, string substitution performed by Sequelize) for
   anything derived from user input.

5. **Money and quantities stay strings.** `numeric` columns arrive from
   node-postgres as strings so that arbitrary-precision decimals survive.
   Arithmetic and comparison happen in SQL. Parsing them into JS numbers
   reintroduces float error into totals, and comparing the raw strings is
   worse than useless — `"9" >= "10"` is `true`.
