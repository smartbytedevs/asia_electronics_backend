'use strict';

const { validateReviewInput, validateRefundListQuery } = require('./refund.validation');
const { REFUND_MESSAGES } = require('./refund.constants');

/**
 * Thin admin/staff refund controller (Phase 10, ADR-0018): validate input,
 * delegate to the service, serialize the envelope. The acting staff/admin id
 * ALWAYS comes from `req.user.id` — never from the request body.
 */
function createAdminRefundController({ refundService }) {
  if (!refundService || typeof refundService.processRefund !== 'function') {
    throw new Error('createAdminRefundController requires a refundService');
  }

  const performedBy = (req) => req.user.id;

  return {
    // GET /api/v1/admin/refunds — ADMIN/STAFF.
    listRefunds: async (req, res) => {
      const { filter, dateFrom, dateTo } = validateRefundListQuery(req.query);
      const data = await refundService.listRefunds({
        ...filter,
        dateFrom,
        dateTo,
        page: req.query.page,
        limit: req.query.limit,
      });
      res.status(200).json({
        success: true,
        message: REFUND_MESSAGES.REFUNDS_FETCHED,
        data,
      });
    },

    // GET /api/v1/admin/refunds/:id — ADMIN/STAFF.
    getRefund: async (req, res) => {
      const refundDoc = await refundService.getRefund(req.params.id);
      res.status(200).json({
        success: true,
        message: REFUND_MESSAGES.REFUND_FETCHED,
        data: { refund: refundDoc },
      });
    },

    // POST /api/v1/admin/refunds/:id/process — ADMIN/STAFF.
    processRefund: async (req, res) => {
      const { value } = validateReviewInput(req.body);
      const refundDoc = await refundService.processRefund({
        refundId: req.params.id,
        performedBy: performedBy(req),
        note: value.note,
      });
      res.status(200).json({
        success: true,
        message: REFUND_MESSAGES.REFUND_PROCESSED,
        data: { refund: refundDoc },
      });
    },

    // POST /api/v1/admin/refunds/:id/void — ADMIN/STAFF.
    voidRefund: async (req, res) => {
      const { value } = validateReviewInput(req.body);
      const refundDoc = await refundService.voidRefund({
        refundId: req.params.id,
        performedBy: performedBy(req),
        note: value.note,
      });
      res.status(200).json({
        success: true,
        message: REFUND_MESSAGES.REFUND_VOIDED,
        data: { refund: refundDoc },
      });
    },
  };
}

module.exports = { createAdminRefundController };
