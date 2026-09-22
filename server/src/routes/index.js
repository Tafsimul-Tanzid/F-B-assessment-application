import { Router } from 'express';

import authRoutes from './auth.routes.js';
import hqRoutes from './hq.routes.js';
import outletRoutes from './outlet.routes.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/hq', hqRoutes);
router.use('/outlet', outletRoutes);

export default router;
