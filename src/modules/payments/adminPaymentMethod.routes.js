'use strict';

const { Router } = require('express');
const { ROLES } = require('../../constants');
const PaymentMethod = require('./paymentMethod.model');
const { createPaymentMethodRepository } = require('./paymentMethod.repository');
const { PaymentMethodService } = require('./paymentMethod.service');
const { createAdminPaymentMethodController } = require('./adminPaymentMethod.controller');
const authenticate = require('../../middlewares/authenticate');
const resolveCurrentUser = require('../../middlewares/resolveCurrentUser');
const authorizeRoles = require('../../middlewares/authorizeRoles');
const { defaultUserService } = require('../users/user.routes');

const defaultAdminPaymentMethodService = new PaymentMethodService({
  paymentMethodRepository: createPaymentMethodRepository(PaymentMethod),
});

/**
 * Admin payment-method router, mounted at /api/v1/admin/payment-methods.
 *
 * ADMIN-only: STAFF cannot manage payment methods (they may only review
 * payments). Deactivation is always soft (`isActive: false`).
 */
function createAdminPaymentMethodRouter({
  paymentMethodService = defaultAdminPaymentMethodService,
  userService = defaultUserService,
  verifier,
} = {}) {
  const router = Router();
  const controller = createAdminPaymentMethodController({ paymentMethodService });

  const admin = [
    authenticate(verifier),
    resolveCurrentUser({ userService }),
    authorizeRoles(ROLES.ADMIN),
  ];

  router.post('/', admin, controller.createPaymentMethod);
  router.patch('/:id', admin, controller.updatePaymentMethod);

  return router;
}

const defaultAdminRouter = createAdminPaymentMethodRouter();

module.exports = {
  createAdminPaymentMethodRouter,
  defaultAdminRouter,
  defaultAdminPaymentMethodService,
};
