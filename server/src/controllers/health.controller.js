import * as healthService from '../services/health.service.js';

export async function health(_req, res) {
  const { healthy, body } = await healthService.getHealth();
  res.status(healthy ? 200 : 503).json(body);
}
