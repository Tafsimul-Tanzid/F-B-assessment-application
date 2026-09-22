import * as outletMenuService from '../services/outletMenu.service.js';
import * as inventoryService from '../services/inventory.service.js';

/**
 * Outlet-facing controllers.
 *
 * Every handler here reads `req.outletId`, which the `outletScope` middleware
 * derives from the JWT. None of these routes accepts an outlet id from the
 * client, so there is no parameter through which one outlet could reach
 * another's data.
 */

export async function listMenu(req, res) {
  const menu = await outletMenuService.listMenuForOutlet(req.outletId);
  res.json({ outletId: req.outletId, menu });
}

export async function listInventory(req, res) {
  const inventory = await inventoryService.listInventory(req.outletId);
  res.json({ outletId: req.outletId, inventory });
}
