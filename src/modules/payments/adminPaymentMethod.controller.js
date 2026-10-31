'use strict';

const {
  validatePaymentMethodCreate,
  validatePaymentMethodUpdate,
} = require('./paymentMethod.validation');
const { PAYMENT_MESSAGES } = require('./payment.constants');

/**
 * Thin admin payment-method controller (Phase 08): create and update (incl.
 * soft deactivation). ADMIN-only — STAFF cannot manage payment methods.
 */
function createAdminPaymentMethodController({ paymentMethodService }) {
  if (!paymentMethodService || typeof paymentMethodService.createPaymentMethod !== 'function') {
    throw new Error('createAdminPaymentMethodController requires a paymentMethodService');
  }

  return {
    // POST /api/v1/admin/payment-methods — ADMIN.
    createPaymentMethod: async (req, res) => {
      const { value } = validatePaymentMethodCreate(req.body);
      const paymentMethod = await paymentMethodService.createPaymentMethod(value);
      res.status(201).json({
        success: true,
        message: PAYMENT_MESSAGES.PAYMENT_METHOD_CREATED,
        data: { paymentMethod },
      });
    },

    // PATCH /api/v1/admin/payment-methods/:id — ADMIN.
    updatePaymentMethod: async (req, res) => {
      const { value } = validatePaymentMethodUpdate(req.body);
      const paymentMethod = await paymentMethodService.updatePaymentMethod({
        paymentMethodId: req.params.id,
        updates: value,
      });
      res.status(200).json({
        success: true,
        message: PAYMENT_MESSAGES.PAYMENT_METHOD_UPDATED,
        data: { paymentMethod },
      });
    },
  };
}

module.exports = { createAdminPaymentMethodController };
