'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const { parseMultipartFormData } = require('../../utils/multipart');
const {
  validateSubmitMultipart,
  validateIdempotencyKey,
} = require('./payment.validation');
const { PAYMENT_MESSAGES, PAYMENT_LIMITS } = require('./payment.constants');

/**
 * Thin customer payment controller (Phase 08): parse the multipart submission,
 * validate, delegate to the service, serialize the envelope. The customer id
 * ALWAYS comes from `req.user.id` — never from the request body.
 */
function createPaymentController({ paymentService }) {
  if (!paymentService || typeof paymentService.submitPayment !== 'function') {
    throw new Error('createPaymentController requires a paymentService');
  }

  const customerId = (req) => req.user.id;

  return {
    // POST /api/v1/orders/:orderId/payment — CUSTOMER (own), multipart/form-data.
    submitPayment: async (req, res) => {
      const contentType = req.get('Content-Type') || '';
      if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
        throw new ApiError(
          400,
          PAYMENT_MESSAGES.MULTIPART_REQUIRED,
          ERROR_CODES.INVALID_PAYMENT
        );
      }
      const parsed = parseMultipartFormData(req.body, contentType, {
        maxFileBytes: PAYMENT_LIMITS.PROOF_MAX_BYTES,
      });
      const { value, proof } = validateSubmitMultipart(parsed);
      const idempotencyKey = validateIdempotencyKey(req.get('Idempotency-Key'));
      const outcome = await paymentService.submitPayment({
        customerId: customerId(req),
        orderId: req.params.orderId,
        value,
        proof,
        idempotencyKey,
      });
      res.status(outcome.created ? 201 : 200).json({
        success: true,
        message: PAYMENT_MESSAGES.PAYMENT_SUBMITTED,
        data: { payment: outcome.payment },
      });
    },

    // GET /api/v1/orders/:orderId/payment — CUSTOMER (own).
    getPayment: async (req, res) => {
      const payment = await paymentService.getCustomerPayment({
        customerId: customerId(req),
        orderId: req.params.orderId,
      });
      res.status(200).json({
        success: true,
        message: PAYMENT_MESSAGES.PAYMENT_FETCHED,
        data: { payment },
      });
    },
  };
}

module.exports = { createPaymentController };
