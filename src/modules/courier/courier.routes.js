'use strict';

const { Router } = require('express');
const { ROLES } = require('../../constants');
const config = require('../../config');
const Order = require('../orders/order.model');
const { createOrderRepository } = require('../orders/order.repository');
const Payment = require('../payments/payment.model');
const { createPaymentRepository } = require('../payments/payment.repository');
const CourierShipment = require('./courierShipment.model');
const { createCourierShipmentRepository } = require('./courierShipment.repository');
const { CourierService } = require('./courier.service');
const { createCourierController } = require('./courier.controller');
const { createMockCourierProvider } = require('./courier.provider.mock');
const { createPathaoCourierProvider, PathaoClient } = require('./pathao/pathao.provider');
const { COURIER_PROVIDERS } = require('./courier.constants');
const authenticate = require('../../middlewares/authenticate');
const resolveCurrentUser = require('../../middlewares/resolveCurrentUser');
const authorizeRoles = require('../../middlewares/authorizeRoles');
const { defaultUserService } = require('../users/user.routes');

/**
 * Builds the provider selected in config. COURIER_PROVIDER=mock (default) is
 * deterministic and needs no credentials; COURIER_PROVIDER=pathao validates
 * credentials at config load and defers the rest to first use.
 */
function buildCourierProvider() {
  if (config.courier.provider === COURIER_PROVIDERS.PATHAO) {
    const client = new PathaoClient(config.pathao);
    return createPathaoCourierProvider({ client, config: config.pathao });
  }
  return createMockCourierProvider();
}

const defaultCourierService = new CourierService({
  shipmentRepository: createCourierShipmentRepository(CourierShipment),
  orderRepository: createOrderRepository(Order),
  paymentRepository: createPaymentRepository(Payment),
  provider: buildCourierProvider(),
  config: {
    defaultItemWeightKg: config.pathao.defaultItemWeightKg,
    webhookSecret: config.pathao.webhookSecret,
    reconcileStaleAfterMs: config.courier.reconcileStaleAfterMs,
  },
});

/**
 * Courier router. Mounted at the API root so the public paths match the
 * contract exactly:
 *   POST   /api/v1/admin/orders/:orderId/courier/dispatch   (ADMIN/STAFF)
 *   POST   /api/v1/admin/shipments/:shipmentId/retry        (ADMIN/STAFF)
 *   POST   /api/v1/admin/shipments/:shipmentId/cancel       (ADMIN/STAFF)
 *   GET    /api/v1/admin/shipments                          (ADMIN/STAFF)
 *   GET    /api/v1/admin/shipments/:shipmentId              (ADMIN/STAFF)
 *   GET    /api/v1/orders/:orderId/tracking                 (CUSTOMER, own)
 *   POST   /api/v1/webhooks/pathao                          (public, signed)
 */
function createCourierRouter({
  courierService = defaultCourierService,
  userService = defaultUserService,
  verifier,
} = {}) {
  const router = Router();
  const controller = createCourierController({ courierService });

  const staff = [
    authenticate(verifier),
    resolveCurrentUser({ userService }),
    authorizeRoles(ROLES.ADMIN, ROLES.STAFF),
  ];
  const customer = [
    authenticate(verifier),
    resolveCurrentUser({ userService }),
    authorizeRoles(ROLES.CUSTOMER),
  ];

  router.post('/admin/orders/:orderId/courier/dispatch', staff, controller.dispatchOrder);
  router.post('/admin/shipments/:shipmentId/retry', staff, controller.retryDispatch);
  router.post('/admin/shipments/:shipmentId/cancel', staff, controller.cancelShipment);
  router.get('/admin/shipments', staff, controller.listShipments);
  router.get('/admin/shipments/:shipmentId', staff, controller.getShipment);
  router.get('/orders/:orderId/tracking', customer, controller.getTracking);
  router.post('/webhooks/pathao', controller.webhook);

  return router;
}

const defaultRouter = createCourierRouter();

module.exports = { createCourierRouter, defaultRouter, defaultCourierService };
