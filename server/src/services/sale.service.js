import { Transaction } from 'sequelize';

import { sequelize } from '../db/sequelize.js';
import { config } from '../config/index.js';
import { isRetryableDbError, mapDbError } from '../db/errors.js';
import {
  ConflictError,
  InsufficientStockError,
  ItemNotStockedError,
  NotFoundError,
  UnprocessableError,
} from '../errors/index.js';
import { logger } from '../utils/logger.js';
import * as inventoryRepository from '../repositories/inventory.repository.js';
import * as outletMenuRepository from '../repositories/outletMenu.repository.js';
import * as saleRepository from '../repositories/sale.repository.js';

/**
 * Collapses repeated lines for the same item into one, summing quantities.
 *
 * Two things depend on this:
 *  1. Correctness — a cart listing the same item twice must deduct the total,
 *     not the last line's quantity.
 *  2. Deadlock avoidance — one deduction per item is what lets the sorted
 *     order below be a strict total order.
 */
function aggregateLines(lines) {
  const byItem = new Map();

  for (const line of lines) {
    const existing = byItem.get(line.menuItemId);
    if (existing) {
      // Quantities are strings (numeric columns). Summing them as Numbers is
      // safe here because a cart quantity is small and has at most 3 decimals;
      // the value goes back to Postgres as a string for the actual arithmetic.
      existing.quantity = String(Number(existing.quantity) + Number(line.quantity));
    } else {
      byItem.set(line.menuItemId, { menuItemId: line.menuItemId, quantity: line.quantity });
    }
  }

  // Ascending menu item id. Every sale in the system acquires inventory row
  // locks in this same global order, so two concurrent sales touching the same
  // items can never hold locks in opposite orders — a deadlock cycle cannot
  // form. Do not use localeCompare here: it is locale-dependent.
  return [...byItem.values()].sort((a, b) =>
    a.menuItemId < b.menuItemId ? -1 : a.menuItemId > b.menuItemId ? 1 : 0,
  );
}

/**
 * Resolves each requested item's price and name from the outlet's own menu.
 *
 * The client never sends a price. It is read here, inside the transaction,
 * from the outlet's assignment — otherwise anyone holding a terminal's token
 * could sell at a price of their choosing.
 */
async function priceLines(outletId, aggregated, { transaction }) {
  const menuItemIds = aggregated.map((l) => l.menuItemId);
  const resolved = await outletMenuRepository.resolveForSale(outletId, menuItemIds, { transaction });
  const byId = new Map(resolved.map((r) => [r.menuItemId, r]));

  return aggregated.map((line) => {
    const item = byId.get(line.menuItemId);

    if (!item) {
      throw new UnprocessableError(
        'One or more items are not on this outlet\'s menu',
        'ITEM_NOT_ON_MENU',
        { menuItemId: line.menuItemId },
      );
    }
    if (!item.isAvailable || !item.isActive) {
      throw new UnprocessableError(
        `"${item.name}" is not currently available at this outlet`,
        'ITEM_UNAVAILABLE',
        { menuItemId: line.menuItemId, itemName: item.name },
      );
    }

    return {
      menuItemId: line.menuItemId,
      itemName: item.name,
      unitPrice: item.unitPrice,
      quantity: line.quantity,
    };
  });
}

/**
 * Deducts stock for every line, in the order established above.
 *
 * Sequential on purpose. `Promise.all` would be wrong here for two separate
 * reasons: it would destroy the lock ordering that prevents deadlock, and a
 * Sequelize transaction is bound to a single pooled connection, so concurrent
 * queries on it serialise arbitrarily or error outright.
 */
async function deductStock(outletId, lines, { transaction }) {
  for (const line of lines) {
    const result = await inventoryRepository.deduct(
      outletId,
      line.menuItemId,
      line.quantity,
      { transaction },
    );

    if (result) continue;

    // The guarded UPDATE matched nothing. That is either "not enough stock" or
    // "no inventory row at all", and they deserve different responses. One
    // extra read distinguishes them — on the failure path only, so it costs
    // nothing in the normal case.
    const current = await inventoryRepository.findOne(outletId, line.menuItemId, { transaction });

    if (!current) {
      throw new ItemNotStockedError({ menuItemId: line.menuItemId, itemName: line.itemName });
    }

    throw new InsufficientStockError({
      menuItemId: line.menuItemId,
      itemName: line.itemName,
      requested: line.quantity,
      available: current.quantity,
    });
  }
}

/**
 * Creates a sale.
 *
 * The whole operation is one database transaction, in this order:
 *
 *   1. resolve prices from the outlet's menu       (no locks)
 *   2. deduct stock, ascending menu_item_id        (inventory row locks)
 *   3. bump the receipt counter and insert the sale (counter row lock)
 *   4. insert the line items
 *
 * Isolation is READ COMMITTED, deliberately. Both mutations are single
 * statements that read and write in one step, so Postgres re-evaluates them
 * against the latest committed row after any lock wait, and no anomaly is
 * reachable. REPEATABLE READ would be strictly worse: it raises a
 * serialization failure whenever two transactions touch the same row, which
 * for a POS is the ordinary case — two cashiers selling the same popular item,
 * or any two sales at one outlet hitting the same counter row — forcing
 * retries for no correctness gain.
 */
export async function createSale({ outletId, cashierId, lines }) {
  if (!lines?.length) {
    throw new UnprocessableError('A sale must contain at least one item', 'EMPTY_SALE');
  }

  const aggregated = aggregateLines(lines);

  return withRetry(async () => {
    try {
      return await sequelize.transaction(
        { isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED },
        async (transaction) => {
          // Bounds how long this transaction will wait on a lock, so one stuck
          // transaction cannot queue an entire outlet's sales behind it.
          await sequelize.query(`SET LOCAL lock_timeout = '${config.db.lockTimeoutMs}ms'`, {
            transaction,
          });

          const priced = await priceLines(outletId, aggregated, { transaction });

          await deductStock(outletId, priced, { transaction });

          const sale = await saleRepository.insertSaleWithReceipt(
            { outletId, cashierId, lines: priced },
            { transaction },
          );

          if (!sale) {
            throw new NotFoundError('Receipt counter for this outlet');
          }

          await saleRepository.insertSaleItems(sale.id, priced, { transaction });

          return {
            ...sale,
            outletId,
            items: priced.map((l) => ({
              menuItemId: l.menuItemId,
              itemName: l.itemName,
              unitPrice: l.unitPrice,
              quantity: l.quantity,
            })),
          };
        },
      );
    } catch (error) {
      // Translate SQLSTATEs into typed errors here, at the transaction
      // boundary, so the retry check below sees a classified error and
      // controllers never inspect a driver code.
      throw mapDbError(error);
    }
  });
}

/**
 * Retries the whole transaction on a deadlock or serialization failure.
 *
 * Two things matter here. The retry wraps the ENTIRE transaction: after any
 * error Postgres has aborted it, so re-running a single statement inside would
 * fail with "current transaction is aborted". And only genuine conflicts are
 * retried — an insufficient-stock error is a settled answer, and retrying it
 * would just hammer a contended row.
 *
 * With the lock ordering established above a deadlock should be unreachable;
 * this is a safety net, and it logs when it fires.
 */
async function withRetry(operation, attempts = 3) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const retryable = isRetryableDbError(error) || error?.code === 'RETRYABLE';

      if (!retryable || attempt >= attempts) throw error;

      logger.warn('Retrying sale after a transaction conflict', { attempt, code: error?.code });

      // Jittered backoff so simultaneous losers do not collide again in step.
      const delay = 20 * 2 ** (attempt - 1) + Math.random() * 20;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export async function listSales(outletId, filters) {
  return saleRepository.findByOutlet(outletId, filters);
}

export async function getSale(saleId, outletId) {
  const sale = await saleRepository.findByIdForOutlet(saleId, outletId);
  if (!sale) throw new NotFoundError('Sale');
  return sale;
}

/**
 * Voids a sale and returns its stock to the shelf.
 *
 * A sale is a financial record of something that happened, so voiding never
 * deletes the row and never frees the receipt number. The sale is marked,
 * and the void is issued its own number from a separate per-outlet
 * credit-note sequence, so the books carry both documents.
 *
 * Transaction order, chosen to match the sale path rather than to read well:
 *
 *   1. mark voided + allocate credit note   (locks the sales row)
 *   2. restore stock, ascending menu_item_id (inventory row locks)
 *
 * Marking first serialises concurrent voids of the same sale immediately and
 * fails the loser before it does any work. Restoring stock in ascending
 * menu_item_id order is the same global lock order the sale path uses, which
 * is what keeps a void and a concurrent sale of the same items from ever
 * holding locks in opposite orders.
 */
export async function voidSale({ saleId, outletId, userId, reason }) {
  return withRetry(async () => {
    try {
      return await sequelize.transaction(
        { isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED },
        async (transaction) => {
          await sequelize.query(`SET LOCAL lock_timeout = '${config.db.lockTimeoutMs}ms'`, {
            transaction,
          });

          const voided = await saleRepository.voidSale(
            { saleId, outletId, userId, reason },
            { transaction },
          );

          if (!voided) {
            // The guarded update matched nothing. One read on this cold path
            // separates "no such sale here" from "already voided".
            const current = await saleRepository.findStatus(saleId, outletId, { transaction });

            if (!current) throw new NotFoundError('Sale');

            throw new ConflictError(
              `Receipt #${current.receiptNo} was already voided (credit note #${current.creditNoteNo})`,
              'ALREADY_VOIDED',
              { saleId, receiptNo: current.receiptNo, creditNoteNo: current.creditNoteNo },
            );
          }

          const items = await saleRepository.findItemsForVoid(saleId, { transaction });

          const restored = [];
          for (const item of items) {
            const result = await inventoryRepository.restore(
              outletId,
              item.menuItemId,
              item.quantity,
              { transaction },
            );

            // The item has since been unassigned from this outlet, so there is
            // no stock row to credit. That must not block the refund - the
            // money side is what the customer is owed - so it is recorded and
            // reported back rather than thrown.
            restored.push({
              menuItemId: item.menuItemId,
              itemName: item.itemName,
              quantity: item.quantity,
              stockRestored: result !== null,
            });
          }

          const unrestored = restored.filter((r) => !r.stockRestored);
          if (unrestored.length) {
            logger.warn('Voided a sale containing items no longer stocked at the outlet', {
              saleId,
              outletId,
              items: unrestored.map((r) => r.itemName),
            });
          }

          return { ...voided, outletId, restoredItems: restored };
        },
      );
    } catch (error) {
      throw mapDbError(error);
    }
  });
}
