'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const { validateDispatchInput } = require('./courier.validation');
const { normalizePathaoWebhook } = require('./pathao/pathao.webhook');
const { COURIER_MESSAGES } = require('./courier.constants');

/**
 * Thin courier controller (Phase 09): validate input, delegate to the service,
 * serialize the response envelope. The acting id ALWAYS comes from
 * `req.user.id` — never from the request body.
 */
function createCourierController({ courierService }) {
  if (
    !courierService ||
    typeof courierService.dispatchForOrder !== 'function' ||
    typeof courierService.handleProviderStatusUpdate !== 'function'
  ) {
    throw new Error('createCourierController requires a courierService');
  }

  const performedBy = (req) => req.user.id;

  return {
    // POST /admin/orders/:orderId/courier/dispatch — ADMIN/STAFF.
    dispatchOrder: async (req, res) => {
      const { value } = validateDispatchInput(req.body);
      const outcome = await courierService.dispatchForOrder({
        orderId: req.params.orderId,
        performedBy: performedBy(req),
        note: value.note,
      });
      res.status(201).json({
        success: true,
        message: COURIER_MESSAGES.DISPATCHED,
        data: outcome,
      });
    },

    // POST /admin/shipments/:shipmentId/retry — ADMIN/STAFF.
    retryDispatch: async (req, res) => {
      const { value } = validateDispatchInput(req.body);
      const outcome = await courierService.retryDispatch({
        shipmentId: req.params.shipmentId,
        performedBy: performedBy(req),
        note: value.note,
      });
      res.status(200).json({
        success: true,
        message: COURIER_MESSAGES.REDISPATCHED,
        data: outcome,
      });
    },

    // POST /admin/shipments/:shipmentId/cancel — ADMIN/STAFF.
    cancelShipment: async (req, res) => {
      const outcome = await courierService.cancelShipment({
        shipmentId: req.params.shipmentId,
        performedBy: performedBy(req),
      });
      res.status(200).json({
        success: true,
        message: COURIER_MESSAGES.CANCELLED,
        data: outcome,
      });
    },

    // GET /admin/shipments — ADMIN/STAFF.
    listShipments: async (req, res) => {
      const data = await courierService.listShipments({
        status: req.query.status,
        orderId: req.query.orderId,
        page: req.query.page,
        limit: req.query.limit,
      });
      res.status(200).json({
        success: true,
        message: COURIER_MESSAGES.LISTED,
        data,
      });
    },

    // GET /admin/shipments/:shipmentId — ADMIN/STAFF.
    getShipment: async (req, res) => {
      const data = await courierService.getShipment({ shipmentId: req.params.shipmentId });
      res.status(200).json({
        success: true,
        message: COURIER_MESSAGES.FETCHED,
        data,
      });
    },

    // GET /orders/:orderId/tracking — CUSTOMER (own order only).
    getTracking: async (req, res) => {
      const data = await courierService.getCustomerTracking({
        customerId: performedBy(req),
        orderId: req.params.orderId,
      });
      res.status(200).json({
        success: true,
        message: COURIER_MESSAGES.TRACKING_FETCHED,
        data,
      });
    },

    // POST /webhooks/pathao — public (signature-verified), Pathao calls this.
    webhook: async (req, res) => {
      if (!courierService.isValidWebhookSignature(req.get('X-Pathao-Signature'))) {
        throw new ApiError(
          401,
          'Invalid webhook signature',
          ERROR_CODES.COURIER_WEBHOOK_INVALID_SIGNATURE
        );
      }
      const event = normalizePathaoWebhook(req.body);
      await courierService.handleProviderStatusUpdate(event);
      res.status(200).json({ success: true, message: COURIER_MESSAGES.WEBHOOK_ACCEPTED });
    },
  };
}

module.exports = { createCourierController };
