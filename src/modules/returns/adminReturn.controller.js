'use strict';

const { validateReturnListQuery, validateReviewInput } = require('./return.validation');
const { RETURN_MESSAGES } = require('./return.constants');

/**
 * Thin admin/staff return controller (Phase 10): validate input, delegate to
 * the service, serialize the envelope. The acting staff/admin id ALWAYS comes
 * from `req.user.id` — never from the request body.
 */
function createAdminReturnController({ returnService }) {
  if (!returnService || typeof returnService.approveReturn !== 'function') {
    throw new Error('createAdminReturnController requires a returnService');
  }

  const performedBy = (req) => req.user.id;

  return {
    // GET /api/v1/admin/returns — ADMIN/STAFF.
    listReturns: async (req, res) => {
      const { filter, dateFrom, dateTo } = validateReturnListQuery(req.query);
      const data = await returnService.listReturns({
        ...filter,
        dateFrom,
        dateTo,
        page: req.query.page,
        limit: req.query.limit,
      });
      res.status(200).json({
        success: true,
        message: RETURN_MESSAGES.RETURNS_FETCHED,
        data,
      });
    },

    // GET /api/v1/admin/returns/:id — ADMIN/STAFF.
    getReturn: async (req, res) => {
      const returnDoc = await returnService.getReturn(req.params.id);
      res.status(200).json({
        success: true,
        message: RETURN_MESSAGES.RETURN_FETCHED,
        data: { return: returnDoc },
      });
    },

    // POST /api/v1/admin/returns/:id/approve — ADMIN/STAFF.
    approveReturn: async (req, res) => {
      const { value } = validateReviewInput(req.body);
      const returnDoc = await returnService.approveReturn({
        returnId: req.params.id,
        performedBy: performedBy(req),
        note: value.note,
      });
      res.status(200).json({
        success: true,
        message: RETURN_MESSAGES.RETURN_APPROVED,
        data: { return: returnDoc },
      });
    },

    // POST /api/v1/admin/returns/:id/reject — ADMIN/STAFF.
    rejectReturn: async (req, res) => {
      const { value } = validateReviewInput(req.body);
      const returnDoc = await returnService.rejectReturn({
        returnId: req.params.id,
        performedBy: performedBy(req),
        note: value.note,
      });
      res.status(200).json({
        success: true,
        message: RETURN_MESSAGES.RETURN_REJECTED,
        data: { return: returnDoc },
      });
    },

    // POST /api/v1/admin/returns/:id/complete — ADMIN/STAFF.
    completeReturn: async (req, res) => {
      const { value } = validateReviewInput(req.body);
      const returnDoc = await returnService.completeReturn({
        returnId: req.params.id,
        performedBy: performedBy(req),
        note: value.note,
      });
      res.status(200).json({
        success: true,
        message: RETURN_MESSAGES.RETURN_COMPLETED,
        data: { return: returnDoc },
      });
    },

    // POST /api/v1/admin/returns/:id/cancel — ADMIN/STAFF.
    cancelReturn: async (req, res) => {
      const { value } = validateReviewInput(req.body);
      const returnDoc = await returnService.cancelReturn({
        returnId: req.params.id,
        performedBy: performedBy(req),
        note: value.note,
      });
      res.status(200).json({
        success: true,
        message: RETURN_MESSAGES.RETURN_CANCELLED,
        data: { return: returnDoc },
      });
    },
  };
}

module.exports = { createAdminReturnController };
