import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

import { config } from './config/index.js';
import { requestContext } from './middleware/requestContext.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import healthRoutes from './routes/health.routes.js';
import apiRoutes from './routes/index.js';

/**
 * Builds the Express app without starting it, so tests can drive it through
 * supertest with no port binding.
 */
export function createApp() {
  const app = express();

  // Render/any reverse proxy terminates TLS; trust it so req.ip and secure
  // cookie handling see the real client.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    cors({
      origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',').map((o) => o.trim()),
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '256kb' }));
  app.use(requestContext);

  app.use(healthRoutes);
  app.use('/api', apiRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;
