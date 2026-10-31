'use strict';

const { Router } = require('express');
const { ROLES } = require('../../constants');
const Payment = require('./payment.model');
const PaymentMethod = require('./paymentMethod.model');
const Order = require('../orders/order.model');
const { createPaymentRepository } = require('./payment.repository');
const { createPaymentMethodRepository } = require('./paymentMethod.repository');
const { createOrderRepository } = require('../orders/order.repository');
const { PaymentService } = require('./payment.service');
const { createAdminPaymentController } = require('./adminPayment.controller');
const { createCloudinaryMediaService } = require('../../integrations/media/cloudinary/cloudinary.adapter');
const authenticate = require('../../middlewares/authenticate');
const resolveCurrentUser = require('../../middlewares/resolveCurrentUser');
const authorizeRoles = require('../../middlewares/authorizeRoles');
const { defaultUserService } = require('../users/user.routes');

const defaultAdminPaymentService = new PaymentService({
  paymentRepository: createPaymentRepository(Payment),
  paymentMethodRepository: createPaymentMethodRepository(PaymentMethod),
  orderRepository: createOrderRepository(Order),
  mediaService: createCloudinaryMediaService(),
});

/**
 * Admin/Staff payment router, mounted at /api/v1/admin/payments.
 *
 * ADMIN+STAFF only. The acting id always comes from the authenticated user —
 * never from the request body. Verification does NOT mutate the order.
 */
function createAdminPaymentRouter({
  paymentService = defaultAdminPaymentService,
  userService = defaultUserService,
  verifier,
} = {}) {
  const router = Router();
  const controller = createAdminPaymentController({ paymentService });

  const staff = [
    authenticate(verifier),
    resolveCurrentUser({ userService }),
    authorizeRoles(ROLES.ADMIN, ROLES.STAFF),
  ];

  router.get('/', staff, controller.listPayments);
  router.get('/:id', staff, controller.getPayment);
  router.post('/:id/verify', staff, controller.verifyPayment);
  router.post('/:id/reject', staff, controller.rejectPayment);

  return router;
}

const defaultAdminRouter = createAdminPaymentRouter();

module.exports = { createAdminPaymentRouter, defaultAdminRouter, defaultAdminPaymentService };
