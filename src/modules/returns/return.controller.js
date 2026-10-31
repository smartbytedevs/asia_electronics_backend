'use strict';

const {
  validateCreateInput,
  validateIdempotencyKey,
} = require('./return.validation');
const { RETURN_MESSAGES } = require('./return.constants');

/**
 * Thin customer return controller (Phase 10): validate input, delegate to the
 * service, serialize the envelope. The customer id ALWAYS comes from
 * `req.user.id` — never from the request body. Every service call is
 * customer-scoped, so cross-customer access resolves as 404 RETURN_NOT_FOUND.
 */
function createReturnController({ returnService }) {
  if (!returnService || typeof returnService.createReturn !== 'function') {
    throw new Error('createReturnController requires a returnService');
  }

  const customerId = (req) => req.user.id;

  return {
    // GET /api/v1/orders/:orderId/returns — CUSTOMER (own).
    listReturns: async (req, res) => {
      const data = await returnService.listCustomerReturns({
        customerId: customerId(req),
        orderId: req.params.orderId,
        page: req.query.page,
        limit: req.query.limit,
      });
      res.status(200).json({
        success: true,
        message: RETURN_MESSAGES.RETURNS_FETCHED,
        data,
      });
    },

    // POST /api/v1/orders/:orderId/returns — CUSTOMER (own).
    createReturn: async (req, res) => {
      const { value } = validateCreateInput(req.body);
      const idempotencyKey = validateIdempotencyKey(req.get('Idempotency-Key'));
      const outcome = await returnService.createReturn({
        customerId: customerId(req),
        orderId: req.params.orderId,
        value,
        idempotencyKey,
      });
      res.status(outcome.created ? 201 : 200).json({
        success: true,
        message: RETURN_MESSAGES.RETURN_CREATED,
        data: { return: outcome.return },
      });
    },

    // GET /api/v1/orders/:orderId/returns/:returnId — CUSTOMER (own).
    getReturn: async (req, res) => {
      const returnDoc = await returnService.getCustomerReturn({
        customerId: customerId(req),
        orderId: req.params.orderId,
        returnId: req.params.returnId,
      });
      res.status(200).json({
        success: true,
        message: RETURN_MESSAGES.RETURN_FETCHED,
        data: { return: returnDoc },
      });
    },

    // POST /api/v1/orders/:orderId/returns/:returnId/cancel — CUSTOMER (own).
    cancelReturn: async (req, res) => {
      const returnDoc = await returnService.cancelCustomerReturn({
        customerId: customerId(req),
        orderId: req.params.orderId,
        returnId: req.params.returnId,
        performedBy: customerId(req),
      });
      res.status(200).json({
        success: true,
        message: RETURN_MESSAGES.RETURN_CANCELLED,
        data: { return: returnDoc },
      });
    },
  };
}

module.exports = { createReturnController };
