import { Router } from 'express';

import * as authController from '../controllers/auth.controller.js';
import { loginSchema } from '../validation/auth.schemas.js';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

/**
 * Routes declare path, validation and access control only. Any logic here
 * would be logic the service layer cannot be tested without an HTTP server.
 */
const router = Router();

router.post('/login', validate(loginSchema), asyncHandler(authController.login));
router.get('/me', authenticate, asyncHandler(authController.me));

export default router;
