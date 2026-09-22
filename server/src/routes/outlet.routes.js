import { Router } from 'express';

import * as outlet from '../controllers/outlet.controller.js';
import * as sale from '../controllers/sale.controller.js';
import { authenticate, outletScope } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { createSaleSchema, listSalesSchema, saleIdSchema } from '../validation/sale.schemas.js';

const router = Router();

// Outlet routes are scoped by the JWT claim. Note that no route below takes an
// outlet id: there is deliberately no parameter through which a terminal could
// point itself at a different outlet.
router.use(authenticate, outletScope);

router.get('/menu', asyncHandler(outlet.listMenu));
router.get('/inventory', asyncHandler(outlet.listInventory));

router.post('/sales', validate(createSaleSchema), asyncHandler(sale.createSale));
router.get('/sales', validate(listSalesSchema), asyncHandler(sale.listSales));
router.get('/sales/:id', validate(saleIdSchema), asyncHandler(sale.getSale));

export default router;
