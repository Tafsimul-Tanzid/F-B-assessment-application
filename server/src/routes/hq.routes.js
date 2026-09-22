import { Router } from 'express';

import * as hq from '../controllers/hq.controller.js';
import * as reports from '../controllers/report.controller.js';
import { authenticate, requireRole, ROLES } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  adjustStockSchema,
  assignMenuItemSchema,
  assignmentParamsSchema,
  createMenuItemSchema,
  createOutletSchema,
  listMenuItemsSchema,
  menuItemIdSchema,
  outletIdSchema,
  updateAssignmentSchema,
  updateMenuItemSchema,
} from '../validation/hq.schemas.js';
import { revenueReportSchema, topItemsReportSchema } from '../validation/report.schemas.js';

const router = Router();

// Every HQ route requires an authenticated HQ admin. Applied once here rather
// than repeated per route, so a new route cannot be added unprotected.
router.use(authenticate, requireRole(ROLES.HQ_ADMIN));

// --- outlets ---------------------------------------------------------------
router.get('/outlets', asyncHandler(hq.listOutlets));
router.post('/outlets', validate(createOutletSchema), asyncHandler(hq.createOutlet));

// --- master menu -----------------------------------------------------------
router.get('/menu-items', validate(listMenuItemsSchema), asyncHandler(hq.listMenuItems));
router.post('/menu-items', validate(createMenuItemSchema), asyncHandler(hq.createMenuItem));
router.patch('/menu-items/:id', validate(updateMenuItemSchema), asyncHandler(hq.updateMenuItem));
router.delete('/menu-items/:id', validate(menuItemIdSchema), asyncHandler(hq.deactivateMenuItem));

// --- assigning master menu items to an outlet ------------------------------
router.get('/outlets/:outletId/menu', validate(outletIdSchema), asyncHandler(hq.listAssignments));
router.post('/outlets/:outletId/menu', validate(assignMenuItemSchema), asyncHandler(hq.assignMenuItem));
router.patch(
  '/outlets/:outletId/menu/:menuItemId',
  validate(updateAssignmentSchema),
  asyncHandler(hq.updateAssignment),
);
router.delete(
  '/outlets/:outletId/menu/:menuItemId',
  validate(assignmentParamsSchema),
  asyncHandler(hq.unassignMenuItem),
);

// --- inventory -------------------------------------------------------------
router.get('/outlets/:outletId/inventory', validate(outletIdSchema), asyncHandler(hq.listInventory));
router.post(
  '/outlets/:outletId/inventory/adjust',
  validate(adjustStockSchema),
  asyncHandler(hq.adjustStock),
);

// --- reporting -------------------------------------------------------------
router.get('/reports/revenue', validate(revenueReportSchema), asyncHandler(reports.revenueByOutlet));
router.get('/reports/top-items', validate(topItemsReportSchema), asyncHandler(reports.topItemsByOutlet));

export default router;
