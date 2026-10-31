'use strict';

const { Router } = require('express');
const { ROLES } = require('../../constants');
const { PAYMENT_LIMITS } = require('./payment.constants');
const Payment = require('./payment.model');
const PaymentMethod = require('./paymentMethod.model');
const Order = require('../orders/order.model');
const { createPaymentRepository } = require('./payment.repository');
const { createPaymentMethodRepository } = require('./paymentMethod.repository');
const { createOrderRepository } = require('../orders/order.repository');
const { PaymentService } = require('./payment.service');
const { createPaymentController } = require('./payment.controller');
const { createCloudinaryMediaService } = require('../../integrations/media/cloudinary/cloudinary.adapter');
const authenticate = require('../../middlewares/authenticate');
const resolveCurrentUser = require('../../middlewares/resolveCurrentUser');
const resolveStorefrontCustomer = require('../../middlewares/resolveStorefrontCustomer');
const authorizeRoles = require('../../middlewares/authorizeRoles');
const { defaultUserService } = require('../users/user.routes');
const { defaultNotificationService } = require('../notifications/notification.routes');

/**
 * Default payment services bound to the central config. Only DB operations and
 * uploads happen at request time — module load is connection-free. The default
 * media service reads Cloudinary credentials lazily from the config; when they
 * are missing, submissions fail cleanly with PAYMENT_PROOF_UPLOAD_FAILED.
 */
const defaultMediaService = createCloudinaryMediaService();

const defaultPaymentService = new PaymentService({
  paymentRepository: createPaymentRepository(Payment),
  paymentMethodRepository: createPaymentMethodRepository(PaymentMethod),
  orderRepository: createOrderRepository(Order),
  mediaService: defaultMediaService,
  notificationService: defaultNotificationService,
});

/**
 * Customer payment router, mounted at /api/v1/orders (routes are
 * /:orderId/payment). CUSTOMER-only and strictly customer-scoped: every
 * service call passes `req.user.id`, so cross-customer reads → 404.
 *
 * The POST route (manual proof submission) is GUEST-capable: guests who
 * checked out with a manual method (MANUAL/BKASH/BANK_TRANSFER) may submit
 * their proof using the `X-Guest-Id` identity, exactly like an authenticated
 * customer. The GET route stays authenticated-CUSTOMER only.
 *
 * The POST route consumes multipart/form-data raw bytes (the proof file); the
 * `express.raw` limit is deliberately above the per-file cap so oversized
 * submissions surface as a clean 400 from the payment validator.
 */
function createPaymentRouter({
  paymentService = defaultPaymentService,
  userService = defaultUserService,
  verifier,
} = {}) {
  const router = Router();
  const controller = createPaymentController({ paymentService });

  const customer = [
    authenticate(verifier),
    resolveCurrentUser({ userService }),
    authorizeRoles(ROLES.CUSTOMER),
  ];

  const storefrontCustomer = [
    resolveStorefrontCustomer({ verifier, userService }),
    authorizeRoles(ROLES.CUSTOMER),
  ];

  router.get('/:orderId/payment', customer, controller.getPayment);
  router.post(
    '/:orderId/payment',
    storefrontCustomer,
    require('express').raw({
      type: 'multipart/form-data',
      limit: PAYMENT_LIMITS.MULTIPART_BODY_MAX_BYTES,
    }),
    controller.submitPayment
  );

  return router;
}

const defaultRouter = createPaymentRouter();

module.exports = { createPaymentRouter, defaultRouter, defaultPaymentService };
