'use strict';

const { Router } = require('express');
const { ROLES } = require('../../constants');
const Order = require('./order.model');
const Cart = require('../cart/cart.model');
const { createOrderRepository } = require('./order.repository');
const { createCartRepository } = require('../cart/cart.repository');
const { OrderService } = require('./order.service');
const { createOrderController } = require('./order.controller');
const { createProductRepository } = require('../products/product.repository');
const Product = require('../products/product.model');
const { createVariantRepository } = require('../products/variants/productVariant.repository');
const ProductVariant = require('../products/variants/productVariant.model');
const { createReservationRepository } = require('../inventory/reservation.repository');
const Reservation = require('../inventory/reservation.model');
const { createInventoryRepository } = require('../inventory/inventory.repository');
const Inventory = require('../inventory/inventory.model');
const { createInventoryMovementRepository } = require('../inventory/inventoryMovement.repository');
const InventoryMovement = require('../inventory/inventoryMovement.model');
const { ReservationService } = require('../inventory/reservation.service');
const authenticate = require('../../middlewares/authenticate');
const resolveCurrentUser = require('../../middlewares/resolveCurrentUser');
const resolveStorefrontCustomer = require('../../middlewares/resolveStorefrontCustomer');
const authorizeRoles = require('../../middlewares/authorizeRoles');
const { defaultUserService } = require('../users/user.routes');
const { defaultCourierService } = require('../courier/courier.routes');
const { defaultNotificationService } = require('../notifications/notification.routes');

/**
 * Default order services bound to the central config. Only DB operations
 * happen at request time — module load is connection-free.
 *
 * The order service composes catalog (products) + reservation (inventory)
 * reads through their repositories/services — never through their models
 * directly.
 */
const defaultReservationService = new ReservationService({
  reservationRepository: createReservationRepository(Reservation),
  inventoryRepository: createInventoryRepository(Inventory),
  movementRepository: createInventoryMovementRepository(InventoryMovement),
  variantRepository: createVariantRepository(ProductVariant),
});

const defaultOrderService = new OrderService({
  orderRepository: createOrderRepository(Order),
  cartRepository: createCartRepository(Cart),
  productRepository: createProductRepository(Product),
  variantRepository: createVariantRepository(ProductVariant),
  reservationService: defaultReservationService,
  courierService: defaultCourierService,
  notificationService: defaultNotificationService,
});

/**
 * Customer order router, mounted at /api/v1/orders.
 *
 * CHECKOUT is guest-capable: the storefront customer gate accepts a verified
 * Bearer token OR an `X-Guest-Id` guest identity (guests place orders without
 * an account). Order history, detail, and cancel remain authenticated-CUSTOMER
 * only — guest accounts are never exposed.
 *
 * Every customer-scoped service call passes `req.user.id` as the customer id,
 * so a customer can never read/mutate another customer's orders
 * (cross-customer reads → 404 ORDER_NOT_FOUND).
 *
 * `GET /status` is a PUBLIC order-status lookup that requires the order
 * identifier AND the delivery phone (see `OrderService.lookupOrderStatus`), so
 * a bare order id/number never reveals an order. It is registered before
 * `GET /:id` so `:id` can never shadow the status path.
 *
 * `orderService`, `userService`, and `verifier` are injectable for tests;
 * production uses the defaults.
 */
function createOrderRouter({
  orderService = defaultOrderService,
  userService = defaultUserService,
  verifier,
} = {}) {
  const router = Router();
  const controller = createOrderController({ orderService });

  const customer = [
    authenticate(verifier),
    resolveCurrentUser({ userService }),
    authorizeRoles(ROLES.CUSTOMER),
  ];

  const storefrontCustomer = [
    resolveStorefrontCustomer({ verifier, userService }),
    authorizeRoles(ROLES.CUSTOMER),
  ];

  router.post('/checkout', storefrontCustomer, controller.checkout);
  router.get('/', customer, controller.listOrders);
  router.get('/status', controller.lookupOrderStatus);
  router.get('/:id', customer, controller.getOrder);
  router.post('/:id/cancel', customer, controller.cancelOrder);

  return router;
}

const defaultRouter = createOrderRouter();

module.exports = { createOrderRouter, defaultRouter, defaultOrderService };
