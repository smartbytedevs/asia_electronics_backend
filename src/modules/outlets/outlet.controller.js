'use strict';

const { validateOutletInput } = require('./outlet.validation');
const { OUTLET_MESSAGES } = require('./outlet.constants');

/**
 * Thin outlet controller (Phase 14): validate input, delegate to the service,
 * serialize the response envelope. No MongoDB access and no business rules
 * here.
 */
function createOutletController({ outletService } = {}) {
  if (!outletService || typeof outletService.listOutlets !== 'function') {
    throw new Error('createOutletController requires an outletService');
  }

  return {
    // GET /api/v1/outlets — public, ACTIVE only.
    listOutlets: async (req, res) => {
      const outlets = await outletService.listOutlets();
      res.status(200).json({
        success: true,
        message: OUTLET_MESSAGES.LIST_FETCHED,
        data: { outlets },
      });
    },

    // GET /api/v1/admin/outlets — ADMIN, all outlets (incl. inactive).
    listOutletsAdmin: async (req, res) => {
      const outlets = await outletService.listOutletsAdmin();
      res.status(200).json({
        success: true,
        message: OUTLET_MESSAGES.LIST_FETCHED,
        data: { outlets },
      });
    },

    // GET /api/v1/outlets/:id — public, ACTIVE only.
    getOutletById: async (req, res) => {
      const outlet = await outletService.getOutletById(req.params.id);
      res.status(200).json({
        success: true,
        message: OUTLET_MESSAGES.OUTLET_FETCHED,
        data: { outlet },
      });
    },

    // GET /api/v1/admin/outlets/:id — ADMIN, any outlet.
    getOutletByIdAdmin: async (req, res) => {
      const outlet = await outletService.getOutletByIdAdmin(req.params.id);
      res.status(200).json({
        success: true,
        message: OUTLET_MESSAGES.OUTLET_FETCHED,
        data: { outlet },
      });
    },

    // GET /api/v1/outlets/code/:code — public, ACTIVE only.
    getOutletByCode: async (req, res) => {
      const outlet = await outletService.getOutletByCode(req.params.code);
      res.status(200).json({
        success: true,
        message: OUTLET_MESSAGES.OUTLET_FETCHED,
        data: { outlet },
      });
    },

    // POST /api/v1/outlets — ADMIN only.
    createOutlet: async (req, res) => {
      const { value } = validateOutletInput(req.body);
      const outlet = await outletService.createOutlet(value);
      res.status(201).json({
        success: true,
        message: OUTLET_MESSAGES.OUTLET_CREATED,
        data: { outlet },
      });
    },

    // PATCH /api/v1/outlets/:id — ADMIN only.
    updateOutlet: async (req, res) => {
      const { value } = validateOutletInput(req.body, { partial: true });
      const outlet = await outletService.updateOutlet(req.params.id, value);
      res.status(200).json({
        success: true,
        message: OUTLET_MESSAGES.OUTLET_UPDATED,
        data: { outlet },
      });
    },
  };
}

module.exports = { createOutletController };
