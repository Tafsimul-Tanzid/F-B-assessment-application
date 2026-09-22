import * as outletService from '../services/outlet.service.js';
import * as menuItemService from '../services/menuItem.service.js';
import * as outletMenuService from '../services/outletMenu.service.js';
import * as inventoryService from '../services/inventory.service.js';

/**
 * HQ-facing controllers. HTTP translation only — the outlet id comes from the
 * path here because HQ legitimately acts across outlets, which is why these
 * routes are gated on the HQ_ADMIN role.
 */

// --- outlets ---------------------------------------------------------------

export async function listOutlets(_req, res) {
  res.json({ outlets: await outletService.listOutlets() });
}

export async function createOutlet(req, res) {
  const outlet = await outletService.createOutlet(req.validated.body);
  res.status(201).json({ outlet });
}

// --- master menu -----------------------------------------------------------

export async function listMenuItems(req, res) {
  res.json({ menuItems: await menuItemService.listMenuItems(req.validated.query) });
}

export async function createMenuItem(req, res) {
  const menuItem = await menuItemService.createMenuItem(req.validated.body);
  res.status(201).json({ menuItem });
}

export async function updateMenuItem(req, res) {
  const menuItem = await menuItemService.updateMenuItem(req.validated.params.id, req.validated.body);
  res.json({ menuItem });
}

export async function deactivateMenuItem(req, res) {
  const menuItem = await menuItemService.deactivateMenuItem(req.validated.params.id);
  res.json({ menuItem });
}

// --- assignment ------------------------------------------------------------

export async function listAssignments(req, res) {
  const menu = await outletMenuService.listAssignments(req.validated.params.outletId);
  res.json({ menu });
}

export async function assignMenuItem(req, res) {
  const assignment = await outletMenuService.assignMenuItem(
    req.validated.params.outletId,
    req.validated.body,
  );
  res.status(201).json({ assignment });
}

export async function updateAssignment(req, res) {
  const { outletId, menuItemId } = req.validated.params;
  const assignment = await outletMenuService.updateAssignment(outletId, menuItemId, req.validated.body);
  res.json({ assignment });
}

export async function unassignMenuItem(req, res) {
  const { outletId, menuItemId } = req.validated.params;
  res.json(await outletMenuService.unassignMenuItem(outletId, menuItemId));
}

// --- inventory -------------------------------------------------------------

export async function listInventory(req, res) {
  const inventory = await inventoryService.listInventoryForHq(req.validated.params.outletId);
  res.json({ inventory });
}

export async function adjustStock(req, res) {
  const { outletId } = req.validated.params;
  const { menuItemId, delta } = req.validated.body;
  res.json(await inventoryService.adjustStock(outletId, menuItemId, delta));
}
