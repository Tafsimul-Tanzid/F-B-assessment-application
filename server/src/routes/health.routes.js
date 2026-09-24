import { Router } from 'express';

import * as healthController from '../controllers/health.controller.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();

// Deliberately outside /api and unauthenticated: orchestrators and load
// balancers must be able to probe it without credentials.
router.get('/health', asyncHandler(healthController.health));

export default router;
