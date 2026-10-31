'use strict';

const { PAYMENT_MESSAGES } = require('./payment.constants');

/**
 * Thin customer payment-method controller (Phase 08): list ACTIVE methods only.
 */
function createPaymentMethodController({ paymentMethodService }) {
  if (!paymentMethodService || typeof paymentMethodService.listActiveForCustomer !== 'function') {
    throw new Error('createPaymentMethodController requires a paymentMethodService');
  }

  return {
    // GET /api/v1/payment-methods — CUSTOMER (active only).
    listPaymentMethods: async (req, res) => {
      const paymentMethods = await paymentMethodService.listActiveForCustomer();
      res.status(200).json({
        success: true,
        message: PAYMENT_MESSAGES.PAYMENT_METHODS_FETCHED,
        data: { paymentMethods },
      });
    },
  };
}

module.exports = { createPaymentMethodController };
