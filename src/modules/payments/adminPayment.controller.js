'use strict';

const {
  validatePaymentListQuery,
  validateReviewInput,
} = require('./payment.validation');
const { PAYMENT_MESSAGES } = require('./payment.constants');

/**
 * Thin admin/staff payment controller (Phase 08): validate input, delegate to
 * the service, serialize the envelope. The acting staff/admin id ALWAYS comes
 * from `req.user.id` — never from the request body.
 */
function createAdminPaymentController({ paymentService }) {
  if (!paymentService || typeof paymentService.verifyPayment !== 'function') {
    throw new Error('createAdminPaymentController requires a paymentService');
  }

  const performedBy = (req) => req.user.id;

  return {
    // GET /api/v1/admin/payments — ADMIN/STAFF.
    listPayments: async (req, res) => {
      const { filter, dateFrom, dateTo } = validatePaymentListQuery(req.query);
      const data = await paymentService.listPayments({
        ...filter,
        dateFrom,
        dateTo,
        page: req.query.page,
        limit: req.query.limit,
      });
      res.status(200).json({
        success: true,
        message: PAYMENT_MESSAGES.PAYMENTS_FETCHED,
        data,
      });
    },

    // GET /api/v1/admin/payments/:id — ADMIN/STAFF.
    getPayment: async (req, res) => {
      const payment = await paymentService.getPayment(req.params.id);
      res.status(200).json({
        success: true,
        message: PAYMENT_MESSAGES.PAYMENT_FETCHED,
        data: { payment },
      });
    },

    // POST /api/v1/admin/payments/:id/verify — ADMIN/STAFF.
    verifyPayment: async (req, res) => {
      const { value } = validateReviewInput(req.body);
      const payment = await paymentService.verifyPayment({
        paymentId: req.params.id,
        performedBy: performedBy(req),
        note: value.note,
      });
      res.status(200).json({
        success: true,
        message: PAYMENT_MESSAGES.PAYMENT_VERIFIED,
        data: { payment },
      });
    },

    // POST /api/v1/admin/payments/:id/reject — ADMIN/STAFF.
    rejectPayment: async (req, res) => {
      const { value } = validateReviewInput(req.body);
      const payment = await paymentService.rejectPayment({
        paymentId: req.params.id,
        performedBy: performedBy(req),
        note: value.note,
      });
      res.status(200).json({
        success: true,
        message: PAYMENT_MESSAGES.PAYMENT_REJECTED,
        data: { payment },
      });
    },
  };
}

module.exports = { createAdminPaymentController };
