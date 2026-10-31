'use strict';

const { Router } = require('express');
const { ROLES } = require('../../constants');
const Order = require('./order.model');
const Cart = require('../cart/cart.model');
const { createOrderRepository } = require('./order.repository');
const { createCartRepository } = require('../cart/cart.repository');
const { OrderService } = require('./order.service');
const { AdminOrderService } = require('./adminOrder.service');
const { createAdminOrderController } = require('./adminOrder.controller');
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
const authorizeRoles = require('../../middlewares/authorizeRoles');
const { defaultUserService } = require('../users/user.routes');
const { defaultOrderService } = require('./order.routes');
const { defaultCourierService } = require('../courier/courier.routes');
const { defaultNotificationService } = require('../notifications/notification.routes');
const Payment = require('../payments/payment.model');
const { createPaymentRepository } = require('../payments/payment.repository');
const config = require('../../config');

const defaultAdminOrderService = new AdminOrderService({
  orderRepository: createOrderRepository(Order),
  orderService: defaultOrderService,
  courierService: defaultCourierService,
  notificationService: defaultNotificationService,
  paymentRepository: createPaymentRepository(Payment),
  autoDispatchOnConfirm: config.courier.autoDispatchOnConfirm,
});

/**
 * Admin/Staff order router, mounted at /api/v1/admin/orders.
 *
 * ADMIN+STAFF only. The acting id always comes from the authenticated user —
 * never from the request body.
 */
function createAdminOrderRouter({
  adminOrderService = defaultAdminOrderService,
  userService = defaultUserService,
  verifier,
} = {}) {
  const router = Router();
  const controller = createAdminOrderController({ adminOrderService });

  const staff = [
    authenticate(verifier),
    resolveCurrentUser({ userService }),
    authorizeRoles(ROLES.ADMIN, ROLES.STAFF),
  ];

  router.get('/', staff, controller.listOrders);
  router.get('/:id', staff, controller.getOrder);
  router.post('/:id/confirm', staff, controller.confirmOrder);
  router.post('/:id/process', staff, controller.processOrder);
  router.post('/:id/ship', staff, controller.shipOrder);
  router.post('/:id/deliver', staff, controller.deliverOrder);
  router.post('/:id/complete', staff, controller.completeOrder);
  router.post('/:id/return', staff, controller.returnOrder);
  router.post('/:id/cancel', staff, controller.cancelOrder);
  router.post('/:id/reject', staff, controller.rejectOrder);

  return router;
}

const defaultAdminRouter = createAdminOrderRouter();

module.exports = { createAdminOrderRouter, defaultAdminRouter, defaultAdminOrderService };
