import { z } from 'zod';
import { dateRangeQuery, quantity, uuid } from './common.schemas.js';

export const createSaleSchema = {
  body: z
    .object({
      items: z
        .array(
          z
            .object({
              menuItemId: uuid,
              quantity,
              // Note there is no price field. Prices are resolved server-side
              // from the outlet's own menu inside the sale transaction, so a
              // terminal cannot choose what it charges.
            })
            .strict(),
        )
        .min(1, 'A sale must contain at least one item')
        .max(100, 'A single sale cannot contain more than 100 lines'),
    })
    .strict(),
};

export const listSalesSchema = {
  query: dateRangeQuery.and(
    z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
  ),
};

export const saleIdSchema = {
  params: z.object({ id: uuid }),
};
