import { z } from 'zod';
import { money, signedQuantity, uuid } from './common.schemas.js';

// --- outlets ---------------------------------------------------------------

export const createOutletSchema = {
  body: z
    .object({
      code: z.string().trim().min(2).max(16).regex(/^[A-Za-z0-9-]+$/, 'Letters, digits and hyphens only'),
      name: z.string().trim().min(1).max(120),
      address: z.string().trim().max(500).optional(),
    })
    .strict(),
};

// --- master menu -----------------------------------------------------------

export const listMenuItemsSchema = {
  query: z
    .object({
      search: z.string().trim().min(1).max(100).optional(),
      category: z.string().trim().min(1).max(60).optional(),
      includeInactive: z
        .enum(['true', 'false'])
        .optional()
        .transform((v) => v === 'true'),
    })
    .strict(),
};

export const createMenuItemSchema = {
  body: z
    .object({
      sku: z.string().trim().min(2).max(32).regex(/^[A-Za-z0-9-]+$/, 'Letters, digits and hyphens only'),
      name: z.string().trim().min(1).max(120),
      category: z.string().trim().min(1).max(60).optional(),
      basePrice: money,
    })
    .strict(),
};

export const updateMenuItemSchema = {
  params: z.object({ id: uuid }),
  body: z
    .object({
      name: z.string().trim().min(1).max(120).optional(),
      category: z.string().trim().min(1).max(60).optional(),
      basePrice: money.optional(),
      isActive: z.boolean().optional(),
    })
    .strict()
    .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided'),
};

export const menuItemIdSchema = {
  params: z.object({ id: uuid }),
};

// --- assignment ------------------------------------------------------------

export const outletIdSchema = {
  params: z.object({ outletId: uuid }),
};

export const assignMenuItemSchema = {
  params: z.object({ outletId: uuid }),
  body: z
    .object({
      menuItemId: uuid,
      // Omitted means "inherit the master base price".
      priceOverride: money.nullable().optional(),
      isAvailable: z.boolean().optional(),
    })
    .strict(),
};

export const updateAssignmentSchema = {
  params: z.object({ outletId: uuid, menuItemId: uuid }),
  body: z
    .object({
      // Explicit null clears the override and falls back to the base price,
      // which is why nullable and optional mean different things here.
      priceOverride: money.nullable().optional(),
      isAvailable: z.boolean().optional(),
    })
    .strict()
    .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided'),
};

export const assignmentParamsSchema = {
  params: z.object({ outletId: uuid, menuItemId: uuid }),
};

// --- inventory -------------------------------------------------------------

export const adjustStockSchema = {
  params: z.object({ outletId: uuid }),
  body: z
    .object({
      menuItemId: uuid,
      // Signed: positive restocks, negative corrects downward.
      delta: signedQuantity,
    })
    .strict(),
};
