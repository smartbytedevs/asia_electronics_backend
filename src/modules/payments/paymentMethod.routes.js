'use strict';

const { Router } = require('express');
const PaymentMethod = require('./paymentMethod.model');
const { createPaymentMethodRepository } = require('./paymentMethod.repository');
const { PaymentMethodService } = require('./paymentMethod.service');
const { createPaymentMethodController } = require('./paymentMethod.controller');

const defaultPaymentMethodService = new PaymentMethodService({
  paymentMethodRepository: createPaymentMethodRepository(PaymentMethod),
});

/**
 * Payment-method router, mounted at /api/v1/payment-methods.
 *
 * PUBLIC storefront read (customer authentication is optional): returns ACTIVE
 * methods only (with their transfer instructions). The raw metadata is
 * intentional — customers need the account details to make a manual transfer.
 * Management lives in the ADMIN-only router at /api/v1/admin/payment-methods.
 */
function createPaymentMethodRouter({
  paymentMethodService = defaultPaymentMethodService,
} = {}) {
  const router = Router();
  const controller = createPaymentMethodController({ paymentMethodService });

  router.get('/', controller.listPaymentMethods);

  return router;
}

const defaultRouter = createPaymentMethodRouter();

module.exports = { createPaymentMethodRouter, defaultRouter, defaultPaymentMethodService };
