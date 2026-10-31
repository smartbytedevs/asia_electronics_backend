'use strict';

const {
  validateInitializeInput,
  validateStockInInput,
  validateStockOutInput,
  validateTransferInput,
  validateAdjustInput,
  validateReservationInput,
} = require('./inventory.validation');
const { INVENTORY_MESSAGES } = require('./inventory.constants');

/**
 * Thin inventory controller (Phase 06): validate input, delegate to the
 * service, serialize the response envelope. No MongoDB access and no business
 * rules here. The acting user (`performedBy`) always comes from the resolved
 * `req.user.id` — never from the request body.
 */
function createInventoryController({ inventoryService, reservationService }) {
  if (!inventoryService || typeof inventoryService.listInventory !== 'function') {
    throw new Error('createInventoryController requires an inventoryService');
  }
  if (
    !reservationService ||
    typeof reservationService.createReservation !== 'function'
  ) {
    throw new Error('createInventoryController requires a reservationService');
  }

  const actor = (req) => req.user.id;

  return {
    // GET /api/v1/inventory — ADMIN.
    listInventory: async (req, res) => {
      const data = await inventoryService.listInventory({
        page: req.query.page,
        limit: req.query.limit,
      });
      res.status(200).json({
        success: true,
        message: INVENTORY_MESSAGES.LIST_FETCHED,
        data,
      });
    },

    // GET /api/v1/inventory/low-stock — ADMIN.
    getLowStock: async (req, res) => {
      const inventory = await inventoryService.getLowStock();
      res.status(200).json({
        success: true,
        message: INVENTORY_MESSAGES.LOW_STOCK_FETCHED,
        data: { inventory },
      });
    },

    // GET /api/v1/inventory/:productVariantId — ADMIN.
    getInventory: async (req, res) => {
      const inventory = await inventoryService.getInventory(req.params.productVariantId);
      res.status(200).json({
        success: true,
        message: INVENTORY_MESSAGES.INVENTORY_FETCHED,
        data: { inventory },
      });
    },

    // GET /api/v1/inventory/:productVariantId/movements — ADMIN.
    getInventoryMovements: async (req, res) => {
      const data = await inventoryService.getInventoryMovements(
        req.params.productVariantId,
        { page: req.query.page, limit: req.query.limit }
      );
      res.status(200).json({
        success: true,
        message: INVENTORY_MESSAGES.MOVEMENTS_FETCHED,
        data,
      });
    },

    // POST /api/v1/inventory/initialize — ADMIN.
    initializeInventory: async (req, res) => {
      const { value } = validateInitializeInput(req.body);
      const inventory = await inventoryService.initializeInventory({
        ...value,
        performedBy: actor(req),
      });
      res.status(201).json({
        success: true,
        message: INVENTORY_MESSAGES.INVENTORY_INITIALIZED,
        data: { inventory },
      });
    },

    // POST /api/v1/inventory/stock-in — ADMIN.
    addStock: async (req, res) => {
      const { value } = validateStockInInput(req.body);
      const inventory = await inventoryService.addStock({
        ...value,
        performedBy: actor(req),
      });
      res.status(200).json({
        success: true,
        message: INVENTORY_MESSAGES.STOCK_IN,
        data: { inventory },
      });
    },

    // POST /api/v1/inventory/stock-out — ADMIN.
    removeStock: async (req, res) => {
      const { value } = validateStockOutInput(req.body);
      const inventory = await inventoryService.removeStock({
        ...value,
        performedBy: actor(req),
      });
      res.status(200).json({
        success: true,
        message: INVENTORY_MESSAGES.STOCK_OUT,
        data: { inventory },
      });
    },

    // POST /api/v1/inventory/transfer — ADMIN.
    transferStock: async (req, res) => {
      const { value } = validateTransferInput(req.body);
      const inventory = await inventoryService.transferStock({
        ...value,
        performedBy: actor(req),
      });
      res.status(200).json({
        success: true,
        message: INVENTORY_MESSAGES.TRANSFER_COMPLETED,
        data: { inventory },
      });
    },

    // POST /api/v1/inventory/adjust — ADMIN.
    adjustStock: async (req, res) => {
      const { value } = validateAdjustInput(req.body);
      const inventory = await inventoryService.adjustStock({
        ...value,
        performedBy: actor(req),
      });
      res.status(200).json({
        success: true,
        message: INVENTORY_MESSAGES.STOCK_ADJUSTED,
        data: { inventory },
      });
    },

    // POST /api/v1/inventory/reservations — ADMIN.
    createReservation: async (req, res) => {
      const { value } = validateReservationInput(req.body);
      const reservation = await reservationService.createReservation({
        ...value,
        performedBy: actor(req),
      });
      res.status(201).json({
        success: true,
        message: INVENTORY_MESSAGES.RESERVATION_CREATED,
        data: { reservation },
      });
    },

    // POST /api/v1/inventory/reservations/:id/release — ADMIN.
    releaseReservation: async (req, res) => {
      const outcome = await reservationService.releaseReservation({
        reservationId: req.params.id,
        performedBy: actor(req),
      });
      res.status(200).json({
        success: true,
        message: INVENTORY_MESSAGES.RESERVATION_RELEASED,
        data: outcome,
      });
    },

    // POST /api/v1/inventory/reservations/:id/consume — ADMIN.
    consumeReservation: async (req, res) => {
      const outcome = await reservationService.consumeReservation({
        reservationId: req.params.id,
        performedBy: actor(req),
      });
      res.status(200).json({
        success: true,
        message: INVENTORY_MESSAGES.RESERVATION_CONSUMED,
        data: outcome,
      });
    },

    // POST /api/v1/inventory/reservations/:id/expire — ADMIN.
    expireReservation: async (req, res) => {
      const reservation = await reservationService.expireReservation({
        reservationId: req.params.id,
        performedBy: actor(req),
      });
      res.status(200).json({
        success: true,
        message: INVENTORY_MESSAGES.RESERVATION_EXPIRED,
        data: { reservation },
      });
    },

    // GET /api/v1/inventory/reservations/:id — ADMIN.
    getReservation: async (req, res) => {
      const reservation = await reservationService.getReservation(req.params.id);
      res.status(200).json({
        success: true,
        message: INVENTORY_MESSAGES.RESERVATION_FETCHED,
        data: { reservation },
      });
    },

    // GET /api/v1/inventory/reservations — ADMIN.
    listReservations: async (req, res) => {
      const data = await reservationService.listReservations({
        productId: req.query.productId,
        productVariantId: req.query.productVariantId,
        status: req.query.status,
        page: req.query.page,
        limit: req.query.limit,
      });
      res.status(200).json({
        success: true,
        message: INVENTORY_MESSAGES.RESERVATIONS_FETCHED,
        data,
      });
    },
  };
}

module.exports = { createInventoryController };
