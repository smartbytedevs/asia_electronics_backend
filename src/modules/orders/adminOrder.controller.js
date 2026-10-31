'use strict';

const { validateTransitionInput } = require('./order.validation');
const { ORDER_MESSAGES } = require('./order.constants');

/**
 * Thin admin/staff order controller (Phase 07): validate input, delegate to
 * the service, serialize the response envelope. The acting staff/admin id
 * ALWAYS comes from `req.user.id` — never from the request body.
 */
function createAdminOrderController({ adminOrderService }) {
  if (!adminOrderService) {
    throw new Error('createAdminOrderController requires an adminOrderService');
  }

  const performedBy = (req) => req.user.id;

  return {
    // GET /api/v1/admin/orders — ADMIN/STAFF.
    listOrders: async (req, res) => {
      const data = await adminOrderService.listOrders({
        status: req.query.status,
        customerId: req.query.customerId,
        page: req.query.page,
        limit: req.query.limit,
      });
      res.status(200).json({
        success: true,
        message: ORDER_MESSAGES.ORDERS_FETCHED,
        data,
      });
    },

    // GET /api/v1/admin/orders/:id — ADMIN/STAFF.
    getOrder: async (req, res) => {
      const order = await adminOrderService.getOrder(req.params.id);
      res.status(200).json({
        success: true,
        message: ORDER_MESSAGES.ORDER_FETCHED,
        data: { order },
      });
    },

    // POST /api/v1/admin/orders/:id/confirm — ADMIN/STAFF.
    confirmOrder: async (req, res) => {
      const { value } = validateTransitionInput(req.body);
      const order = await adminOrderService.confirmOrder({
        orderId: req.params.id,
        performedBy: performedBy(req),
        note: value.note,
      });
      res.status(200).json({
        success: true,
        message: ORDER_MESSAGES.ORDER_CONFIRMED,
        data: { order },
      });
    },

    // POST /api/v1/admin/orders/:id/process — ADMIN/STAFF.
    processOrder: async (req, res) => {
      const { value } = validateTransitionInput(req.body);
      const order = await adminOrderService.processOrder({
        orderId: req.params.id,
        performedBy: performedBy(req),
        note: value.note,
      });
      res.status(200).json({
        success: true,
        message: ORDER_MESSAGES.ORDER_PROCESSED,
        data: { order },
      });
    },

    // POST /api/v1/admin/orders/:id/ship — ADMIN/STAFF.
    shipOrder: async (req, res) => {
      const { value } = validateTransitionInput(req.body);
      const order = await adminOrderService.shipOrder({
        orderId: req.params.id,
        performedBy: performedBy(req),
        note: value.note,
      });
      res.status(200).json({
        success: true,
        message: ORDER_MESSAGES.ORDER_SHIPPED,
        data: { order },
      });
    },

    // POST /api/v1/admin/orders/:id/deliver — ADMIN/STAFF.
    deliverOrder: async (req, res) => {
      const { value } = validateTransitionInput(req.body);
      const order = await adminOrderService.deliverOrder({
        orderId: req.params.id,
        performedBy: performedBy(req),
        note: value.note,
      });
      res.status(200).json({
        success: true,
        message: ORDER_MESSAGES.ORDER_DELIVERED,
        data: { order },
      });
    },

    // POST /api/v1/admin/orders/:id/complete — ADMIN/STAFF.
    completeOrder: async (req, res) => {
      const { value } = validateTransitionInput(req.body);
      const order = await adminOrderService.completeOrder({
        orderId: req.params.id,
        performedBy: performedBy(req),
        note: value.note,
      });
      res.status(200).json({
        success: true,
        message: ORDER_MESSAGES.ORDER_COMPLETED,
        data: { order },
      });
    },

    // POST /api/v1/admin/orders/:id/return — ADMIN/STAFF.
    returnOrder: async (req, res) => {
      const { value } = validateTransitionInput(req.body);
      const order = await adminOrderService.returnOrder({
        orderId: req.params.id,
        performedBy: performedBy(req),
        note: value.note,
      });
      res.status(200).json({
        success: true,
        message: ORDER_MESSAGES.ORDER_RETURNED,
        data: { order },
      });
    },

    // POST /api/v1/admin/orders/:id/cancel — ADMIN/STAFF.
    cancelOrder: async (req, res) => {
      const { value } = validateTransitionInput(req.body);
      const order = await adminOrderService.cancelOrder({
        orderId: req.params.id,
        performedBy: performedBy(req),
        note: value.note,
      });
      res.status(200).json({
        success: true,
        message: ORDER_MESSAGES.ORDER_CANCELLED,
        data: { order },
      });
    },

    // POST /api/v1/admin/orders/:id/reject — ADMIN/STAFF.
    rejectOrder: async (req, res) => {
      const { value } = validateTransitionInput(req.body);
      const order = await adminOrderService.rejectOrder({
        orderId: req.params.id,
        performedBy: performedBy(req),
        note: value.note,
      });
      res.status(200).json({
        success: true,
        message: ORDER_MESSAGES.ORDER_REJECTED,
        data: { order },
      });
    },
  };
}

module.exports = { createAdminOrderController };
