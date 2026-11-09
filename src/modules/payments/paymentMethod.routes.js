'use strict';

const { Router } = require('express');
const PaymentMethod = require('./paymentMethod.model');
const { createPaymentMethodRepository } = require('./paymentMethod.repository');
const { PaymentMethodService } = require('./paymentMethod.service');
const { createPaymentMethodController } = require('./paymentMethod.controller');
const publicCache = require('../../middlewares/publicCache');

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

  // Public instructions, identical for every visitor; short edge cache keeps
  // admin edits visible quickly while absorbing repeat storefront reads.
  router.get('/', publicCache({ sMaxAge: 60 }), controller.listPaymentMethods);

  return router;
}

const defaultRouter = createPaymentMethodRouter();

module.exports = { createPaymentMethodRouter, defaultRouter, defaultPaymentMethodService };
