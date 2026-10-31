'use strict';

const { Router } = require('express');
const { ROLES } = require('../../constants');
const Return = require('./return.model');
const Order = require('../orders/order.model');
const { createReturnRepository } = require('./return.repository');
const { createOrderRepository } = require('../orders/order.repository');
const { ReturnService } = require('./return.service');
const { createReturnController } = require('./return.controller');
const { defaultRefundService } = require('../refunds/refund.routes');
const { InventoryService } = require('../inventory/inventory.service');
const { createInventoryRepository } = require('../inventory/inventory.repository');
const { createInventoryMovementRepository } = require('../inventory/inventoryMovement.repository');
const Inventory = require('../inventory/inventory.model');
const InventoryMovement = require('../inventory/inventoryMovement.model');
const { createVariantRepository } = require('../products/variants/productVariant.repository');
const ProductVariant = require('../products/variants/productVariant.model');
const authenticate = require('../../middlewares/authenticate');
const resolveCurrentUser = require('../../middlewares/resolveCurrentUser');
const authorizeRoles = require('../../middlewares/authorizeRoles');
const { defaultUserService } = require('../users/user.routes');

/**
 * Default return services bound to the central config. Only DB operations
 * happen at request time — module load is connection-free.
 */
const defaultInventoryService = new InventoryService({
  inventoryRepository: createInventoryRepository(Inventory),
  movementRepository: createInventoryMovementRepository(InventoryMovement),
  variantRepository: createVariantRepository(ProductVariant),
});

const defaultReturnService = new ReturnService({
  returnRepository: createReturnRepository(Return),
  orderRepository: createOrderRepository(Order),
  refundService: defaultRefundService,
  inventoryService: defaultInventoryService,
});

/**
 * Customer return router, mounted at /api/v1/orders (routes are
 * /:orderId/returns...). CUSTOMER-only and strictly customer-scoped: every
 * service call passes `req.user.id`, so cross-customer reads → 404.
 *
 * The order context comes from the URL (`/:orderId`); the customer identity
 * ALWAYS comes from the authenticated user.
 */
function createReturnRouter({
  returnService = defaultReturnService,
  userService = defaultUserService,
  verifier,
} = {}) {
  const router = Router();
  const controller = createReturnController({ returnService });

  const customer = [
    authenticate(verifier),
    resolveCurrentUser({ userService }),
    authorizeRoles(ROLES.CUSTOMER),
  ];

  router.get('/:orderId/returns', customer, controller.listReturns);
  router.post('/:orderId/returns', customer, controller.createReturn);
  router.get('/:orderId/returns/:returnId', customer, controller.getReturn);
  router.post('/:orderId/returns/:returnId/cancel', customer, controller.cancelReturn);

  return router;
}

const defaultRouter = createReturnRouter();

module.exports = { createReturnRouter, defaultRouter, defaultReturnService };
