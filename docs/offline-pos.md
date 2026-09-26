# Offline POS strategy

> **WHAT IS IMPLEMENTED NOW: nothing described in this document is built.**
> The deployed system requires connectivity to create a sale — there is no
> local storage, no sync queue, no offline mode in the current codebase. This
> is a design document only, describing how offline support **could** be
> added later, written so the distinction between "exists today" and
> "proposed" is never ambiguous.

An outlet's internet connection is the least reliable part of this system,
and it is also the part that must never stop a customer being served. The
design principle throughout is that **the WAN link is required for
head-office synchronization, never for service** — a terminal that loses
connectivity should keep selling, not degrade.

---

## 1. Local POS database/storage

Each terminal keeps a local store — SQLite on a native terminal, IndexedDB
in a browser-based one — holding:

- the outlet's assigned menu and effective prices, refreshed while online;
- its own last-known view of stock;
- an **append-only outbox** of sales that have not yet reached HQ.

## 2. Local sales creation

A sale is written to the local store and the outbox first, and the receipt
prints immediately from that local write. Reaching HQ is a background
concern layered behind it. The terminal is therefore not "degraded" when
offline — the offline path is the same code path as the online one, with
synchronization running asynchronously behind it rather than being on the
critical path of ringing up a sale.

## 3. Unique local transaction IDs

Each sale is minted with a client-generated `client_request_id` (a UUID
created on the terminal the moment the cashier taps Charge), before it is
known whether or when the sale will reach the server. This id is what makes
every other guarantee in this document possible — idempotency, duplicate
prevention, and safe retries all key off it, not off the server-assigned
receipt number, which does not exist yet at the moment the id is minted.

## 4. Local receipt handling

The receipt prints from the local write, using the terminal's own
provisional numbering (§ below) — never blocked on a round trip to HQ. Once
sync succeeds, the local record is reconciled with whatever the server
allocated, but the customer's paper receipt is not reprinted or invalidated;
it already reflects a completed, real sale.

**Receipt numbering offline** is the hardest part of this design, because
the central per-outlet counter described in
[`architecture.md`](architecture.md#9-transaction-strategy-inventory-concurrency-and-receipt-numbering)
is exactly what is unreachable. Two workable approaches:

- **Terminal-scoped numbering (simpler).** Each terminal issues receipts
  under its own namespace: `GUL01-T02-000417`. Uniqueness is guaranteed by
  construction, no coordination is needed, and the terminal is identifiable
  from the receipt itself. The cost is that the outlet no longer has one
  unbroken sequence, which matters only if a tax regime specifically
  requires it.
- **Pre-allocated blocks (stricter).** While online, a terminal leases a
  block of numbers from HQ (say 401–600) by bumping the real counter by the
  block size in one transaction. Offline, it allocates from its lease. This
  preserves a single per-outlet sequence at the cost of gaps when a block is
  only partly used, plus lease-exhaustion handling — a terminal offline
  longer than its lease must fall back to terminal-scoped numbering rather
  than refuse to sell.

The approach to **avoid** is a naive local counter per terminal with no
namespace at all: two terminals offline simultaneously both issue receipt
#418, and the collision is discovered only at sync time, after both
customers already hold a printed receipt. The existing
`UNIQUE (outlet_id, receipt_no)` constraint would then reject the second
sale outright — losing a real, completed transaction in order to protect a
number.

## 5. Sync queue

The outbox is a strictly ordered, append-only queue of not-yet-synced
sales per terminal. A background process drains it whenever connectivity is
available, oldest first, so the server sees sales in the order they actually
happened at that terminal.

## 6. Retry mechanism

Each queued sale is retried with backoff until the server acknowledges it.
A terminal offline for hours simply accumulates a longer queue; nothing is
lost, and nothing blocks the till from continuing to sell while the queue
grows.

## 7. Idempotency

Because connectivity failures characteristically strike *after* the server
has committed but *before* the acknowledgement reaches the terminal, a
retry must never double-charge the customer. The server would add
`UNIQUE (outlet_id, client_request_id)` on `sales` and, on a conflict,
return the **existing** sale rather than creating a second one. Replay then
becomes safe by construction, and the terminal can retry as aggressively as
it likes without a synchronization protocol to get right on top of it.

This is the one schema addition offline mode would actually require — a
column, a unique constraint, and a lookup-before-insert in the sale service.
Everything else in this document is process and client-side design; this is
the only piece that touches the current schema.

## 8. Duplicate prevention

A direct consequence of §7: duplicate prevention *is* idempotency here,
enforced by the database rather than by client-side bookkeeping trying to
track what has and hasn't been sent. A terminal that is unsure whether its
last sync attempt succeeded simply retries the same `client_request_id`;
the server's unique constraint is the single source of truth on whether
that sale already exists.

## 9. Conflict handling

**Sales never conflict with each other.** They are append-only facts about
things that already happened; two terminals selling simultaneously produce
two sales, not a conflict, regardless of what order sync happens to process
them in.

**Stock is where the real conflict lives.** Two terminals offline can each
sell the last unit of the same item. On reconnect, the server's stock is
authoritative and would, in aggregate, go negative — except it structurally
cannot, because of the existing `CHECK (quantity >= 0)` constraint.

The resolution has to start from a business fact, not a data-integrity
preference: **the customer already has the item.** Rejecting the sale at
sync time would mean the books show less revenue than the till actually
took, which is a worse outcome than an inaccurate stock count. So:

1. Accept both sales — they are historical facts, not proposals.
2. Clamp the resulting stock at zero rather than allowing it negative.
3. Record a **variance exception** (item, outlet, expected vs. actual, the
   terminals involved) for a manager to reconcile by a physical count.

Stock accuracy is recoverable by a count; a lost transaction is not
recoverable at all.

## 10. Inventory synchronization

Each terminal syncs a periodic snapshot of the outlet's stock while online,
so its offline view is reasonably current when connectivity drops. That
view is advisory only — it drives what the till warns about, never what it
strictly enforces, because it can never be perfectly current. A terminal
that has been offline for an extended period should degrade its confidence
accordingly (warn on low-stock items more readily) rather than promise
availability it cannot actually verify.

## 11. Sync after reconnect

On reconnect, the outbox drains in order (§5), each sale idempotent by
`client_request_id` (§7). Once the queue is empty, the terminal refreshes
its local menu and stock snapshot from the server, closing the loop until
the next disconnection.

## 12. Failure recovery

If a terminal is lost, damaged, or reset before its outbox fully syncs, the
outbox itself is the recovery mechanism: as long as its local storage
survives (or is itself backed up), the queue can be resumed. A sale that
never makes it into any surviving outbox is a genuine loss, no different in
kind from a paper till roll destroyed in a fire — the mitigation is
operational (periodic outbox backup for high-volume terminals), not
architectural.

---

## How POS and KDS communicate while offline

The kitchen display must keep receiving orders when the WAN is down but the
local network is up — the overwhelmingly common failure mode is a dead
uplink, not dead switches on-site. Routing an order from a till to a screen
four metres away via a cloud service is a design that fails exactly when
the restaurant is busiest.

```
POS  →  local network  →  KDS
```

**Order flow stays entirely inside the outlet.** The WAN is used only for
HQ synchronization, never for POS-to-KDS communication. A local hub — either
a small always-on device at the outlet (a Raspberry Pi or similar running a
lightweight LAN broker such as MQTT or a plain WebSocket server) or an
elected peer among the terminals themselves — relays orders locally.

An always-on hub is the simpler, more predictable option and can also hold
the outlet's authoritative offline stock view, which removes the
terminal-vs-terminal conflict discussed in §9 entirely for that outlet's own
tickets. An elected peer needs no extra hardware, but leader election and
split-brain handling on a shop floor is materially harder to get right than
it sounds.

Either approach needs three properties:

1. **Heartbeats and re-election.** If the hub dies mid-service the kitchen
   must not go dark; terminals detect the loss and promote another node,
   replaying anything queued locally during the gap.
2. **Local persistence of open tickets.** A power cycle must not lose
   in-flight orders — tickets are written to disk on both the POS and the
   KDS, so a rebooted screen redraws what is still cooking rather than
   starting blank.
3. **Acknowledgement, not fire-and-forget.** The POS marks a ticket "sent"
   only once the KDS acknowledges it; unacknowledged tickets are retried and
   surfaced to staff. A ticket silently lost between till and kitchen is the
   failure mode that actually costs a restaurant money — far more than a
   delayed sync to HQ ever would.

The same outbox that syncs sales to HQ is what makes this whole design
coherent: the kitchen path and the HQ path are both consumers of a durable
local log, so neither one depends on the other being available.
