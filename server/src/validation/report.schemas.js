import { z } from 'zod';
import { dateRangeQuery } from './common.schemas.js';

export const revenueReportSchema = {
  query: dateRangeQuery,
};

export const topItemsReportSchema = {
  // The brief asks for a top 5; the limit is exposed so HQ can widen it, and
  // capped so a report cannot be turned into an unbounded export.
  query: dateRangeQuery.and(
    z.object({ limit: z.coerce.number().int().min(1).max(50).default(5) }),
  ),
};
