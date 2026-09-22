import { z } from 'zod';

export const uuid = z.string().uuid('Must be a valid UUID');

/**
 * Money arrives as a string or a number and is kept as a STRING all the way to
 * Postgres, where it lands in a `numeric` column.
 *
 * It is deliberately never converted to a JS number: a float cannot represent
 * most decimal money values exactly, so parsing here would quietly introduce
 * rounding error into prices and totals.
 */
export const money = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === 'number' ? v.toFixed(2) : v.trim()))
  .refine((v) => /^\d+(\.\d{1,2})?$/.test(v), 'Must be a non-negative amount with at most 2 decimals');

/**
 * Quantities allow 3 decimal places to match the `numeric(14,3)` columns,
 * which leaves room for weighed items.
 */
export const quantity = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === 'number' ? String(v) : v.trim()))
  .refine((v) => /^\d+(\.\d{1,3})?$/.test(v), 'Must be a positive quantity with at most 3 decimals')
  .refine((v) => Number(v) > 0, 'Must be greater than zero');

export const signedQuantity = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === 'number' ? String(v) : v.trim()))
  .refine((v) => /^-?\d+(\.\d{1,3})?$/.test(v), 'Must be a quantity with at most 3 decimals')
  .refine((v) => Number(v) !== 0, 'Must not be zero');

/**
 * Report date range. Both bounds are optional; the service supplies defaults.
 * `to` is treated as exclusive by the reporting queries.
 */
export const dateRangeQuery = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, {
    message: '`from` must not be after `to`',
    path: ['from'],
  });
