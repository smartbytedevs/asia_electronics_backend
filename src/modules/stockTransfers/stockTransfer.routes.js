'use strict';

const { Router } = require('express');
const { ROLES } = require('../../constants');
const StockTransfer = require('./stockTransfer.model');
const Inventory = require('../inventory/inventory.model');
const InventoryMovement = require('../inventory/inventoryMovement.model');
const ProductVariant = require('../products/variants/productVariant.model');
const Outlet = require('../outlets/outlet.model');
const { createStockTransferRepository } = require('./stockTransfer.repository');
const { createInventoryRepository } = require('../inventory/inventory.repository');
const { createInventoryMovementRepository } = require('../inventory/inventoryMovement.repository');
const { createVariantRepository } = require('../products/variants/productVariant.repository');
const { createOutletRepository } = require('../outlets/outlet.repository');
const { StockTransferService } = require('./stockTransfer.service');
const { createStockTransferController } = require('./stockTransfer.controller');
const authenticate = require('../../middlewares/authenticate');
const resolveCurrentUser = require('../../middlewares/resolveCurrentUser');
const authorizeRoles = require('../../middlewares/authorizeRoles');
const { defaultUserService } = require('../users/user.routes');

/**
 * Default stock-transfer service bound to the central config. Only DB
 * operations happen at request time — module load is connection-free.
 */
const defaultStockTransferService = new StockTransferService({
  transferRepository: createStockTransferRepository(StockTransfer),
  inventoryRepository: createInventoryRepository(Inventory),
  movementRepository: createInventoryMovementRepository(InventoryMovement),
  variantRepository: createVariantRepository(ProductVariant),
  outletRepository: createOutletRepository(Outlet),
});

/**
 * Stock-transfer router, mounted at /api/v1/admin/stock-transfers.
 *
 * ALL endpoints are ADMIN-only — stock movement is a sensitive
 * administrative capability (see docs/rbac-matrix.md). Every route composes:
 *   authenticate → resolveCurrentUser → authorizeRoles(ADMIN) → controller
 * STAFF and CUSTOMER get 403; JWT role claims / body / query / header role
 * spoofing never elevates.
 *
 * `stockTransferService`, `userService`, and `verifier` are injectable for
 * tests; production uses the defaults.
 */
function createStockTransferRouter({
  stockTransferService = defaultStockTransferService,
  userService = defaultUserService,
  verifier,
} = {}) {
  const router = Router();
  const controller = createStockTransferController({ stockTransferService });

  const admin = [
    authenticate(verifier),
    resolveCurrentUser({ userService }),
    authorizeRoles(ROLES.ADMIN),
  ];

  router.post('/', admin, controller.createTransfer);
  router.get('/', admin, controller.listTransfers);
  router.get('/:id', admin, controller.getTransfer);

  return router;
}

const defaultRouter = createStockTransferRouter();

module.exports = { createStockTransferRouter, defaultRouter };
