'use strict';

const { validateStockTransferInput } = require('./stockTransfer.validation');
const { STOCK_TRANSFER_MESSAGES } = require('./stockTransfer.constants');

/**
 * Thin stock-transfer controller (Phase 14): validate input, delegate to the
 * service, serialize the response envelope. No MongoDB access and no business
 * rules here. The acting user (`createdBy`) always comes from the resolved
 * `req.user.id` — never from the request body.
 */
function createStockTransferController({ stockTransferService } = {}) {
  if (!stockTransferService || typeof stockTransferService.createTransfer !== 'function') {
    throw new Error('createStockTransferController requires a stockTransferService');
  }

  const actor = (req) => req.user.id;

  return {
    // POST /api/v1/admin/stock-transfers — ADMIN.
    createTransfer: async (req, res) => {
      const { value } = validateStockTransferInput(req.body);
      const transfer = await stockTransferService.createTransfer({
        ...value,
        performedBy: actor(req),
      });
      res.status(201).json({
        success: true,
        message: STOCK_TRANSFER_MESSAGES.TRANSFER_COMPLETED,
        data: { transfer },
      });
    },

    // GET /api/v1/admin/stock-transfers — ADMIN.
    listTransfers: async (req, res) => {
      const data = await stockTransferService.listTransfers({
        page: req.query.page,
        limit: req.query.limit,
      });
      res.status(200).json({
        success: true,
        message: STOCK_TRANSFER_MESSAGES.LIST_FETCHED,
        data,
      });
    },

    // GET /api/v1/admin/stock-transfers/:id — ADMIN.
    getTransfer: async (req, res) => {
      const transfer = await stockTransferService.getTransfer(req.params.id);
      res.status(200).json({
        success: true,
        message: STOCK_TRANSFER_MESSAGES.TRANSFER_FETCHED,
        data: { transfer },
      });
    },
  };
}

module.exports = { createStockTransferController };
