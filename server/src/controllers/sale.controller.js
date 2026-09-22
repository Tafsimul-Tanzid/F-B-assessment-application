import * as saleService from '../services/sale.service.js';

export async function createSale(req, res) {
  const sale = await saleService.createSale({
    // Both the outlet and the cashier come from the authenticated identity,
    // never from the request body.
    outletId: req.outletId,
    cashierId: req.user.id,
    lines: req.validated.body.items,
  });

  res.status(201).json({ sale });
}

export async function listSales(req, res) {
  const sales = await saleService.listSales(req.outletId, req.validated.query);
  res.json({ sales });
}

export async function getSale(req, res) {
  const sale = await saleService.getSale(req.validated.params.id, req.outletId);
  res.json({ sale });
}
