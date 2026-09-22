import * as reportService from '../services/report.service.js';

export async function revenueByOutlet(req, res) {
  res.json(await reportService.getRevenueByOutlet(req.validated.query));
}

export async function topItemsByOutlet(req, res) {
  res.json(await reportService.getTopItemsByOutlet(req.validated.query));
}
