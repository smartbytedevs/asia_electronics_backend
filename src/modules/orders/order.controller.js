'use strict';

const {
  validateCheckoutInput,
  validateIdempotencyKey,
  validateOrderStatusLookup,
} = require('./order.validation');
const { ORDER_MESSAGES } = require('./order.constants');

/**
 * Thin customer order controller (Phase 07): validate input, delegate to the
 * service, serialize the response envelope. No MongoDB access and no business
 * rules here. The customer id ALWAYS comes from `req.user.id` — never from the
 * request body (the validator rejects customer/user id and client money).
 */
function createOrderController({ orderService }) {
  if (!orderService || typeof orderService.checkout !== 'function') {
    throw new Error('createOrderController requires an orderService');
  }

  const customerId = (req) => req.user.id;

  return {
    // POST /api/v1/orders/checkout — CUSTOMER (own).
    checkout: async (req, res) => {
      const { value } = validateCheckoutInput(req.body);
      const idempotencyKey = validateIdempotencyKey(req.get('Idempotency-Key'));
      const outcome = await orderService.checkout({
        customerId: customerId(req),
        ...value,
        idempotencyKey,
      });
      res.status(outcome.isRetry ? 200 : 201).json({
        success: true,
        message: ORDER_MESSAGES.ORDER_CREATED,
        data: { order: outcome.order },
      });
    },

    // GET /api/v1/orders — CUSTOMER (own).
    listOrders: async (req, res) => {
      const data = await orderService.listCustomerOrders({
        customerId: customerId(req),
        page: req.query.page,
        limit: req.query.limit,
      });
      res.status(200).json({
        success: true,
        message: ORDER_MESSAGES.ORDERS_FETCHED,
        data,
      });
    },

    // GET /api/v1/orders/:id — CUSTOMER (own).
    getOrder: async (req, res) => {
      const order = await orderService.getCustomerOrder({
        customerId: customerId(req),
        orderId: req.params.id,
      });
      res.status(200).json({
        success: true,
        message: ORDER_MESSAGES.ORDER_FETCHED,
        data: { order },
      });
    },

    // POST /api/v1/orders/:id/cancel — CUSTOMER (own).
    cancelOrder: async (req, res) => {
      const order = await orderService.cancelCustomerOrder({
        customerId: customerId(req),
        orderId: req.params.id,
        performedBy: customerId(req),
      });
      res.status(200).json({
        success: true,
        message: ORDER_MESSAGES.ORDER_CANCELLED,
        data: { order },
      });
    },

    // GET /api/v1/orders/status — PUBLIC (requires order id/number + phone).
    lookupOrderStatus: async (req, res) => {
      const { value } = validateOrderStatusLookup(req.query);
      const order = await orderService.lookupOrderStatus(value);
      res.status(200).json({
        success: true,
        message: ORDER_MESSAGES.ORDER_STATUS_FETCHED,
        data: { order },
      });
    },
  };
}

module.exports = { createOrderController };
