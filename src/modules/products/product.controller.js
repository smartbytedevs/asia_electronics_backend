'use strict';

const { PRODUCT_LIST_FILTERS, PRODUCT_MESSAGES } = require('./product.constants');

/**
 * Thin product controller: delegate to the service (which owns all validation
 * and business rules), serialize the response envelope. No MongoDB access, no
 * slug generation, no duplicate detection here.
 *
 * The controller passes the caller's application role (`req.user.role`, set by
 * resolveCurrentUser) to the service so purchase-price information is only ever
 * included in ADMIN responses (PURCHASE_ACL).
 */
function createProductController({ productService } = {}) {
  if (!productService || typeof productService.listProducts !== 'function') {
    throw new Error('createProductController requires a productService');
  }

  return {
    // GET /api/v1/products — public catalog list (ACTIVE only, allowlisted query).
    listProducts: async (req, res) => {
      const filters = {};
      for (const key of PRODUCT_LIST_FILTERS) {
        if (req.query[key] !== undefined) {
          filters[key] = req.query[key];
        }
      }
      const result = await productService.listProducts({
        page: req.query.page,
        limit: req.query.limit,
        filters,
        sort: req.query.sort,
      });
      res.status(200).json({
        success: true,
        message: PRODUCT_MESSAGES.LIST_FETCHED,
        data: result,
      });
    },

    // GET /api/v1/products/:id — public, ACTIVE only, full detail.
    getProductById: async (req, res) => {
      const product = await productService.getPublicProductById(req.params.id);
      res.status(200).json({
        success: true,
        message: PRODUCT_MESSAGES.PRODUCT_FETCHED,
        data: { product },
      });
    },

    // GET /api/v1/products/slug/:slug — public, ACTIVE only, full detail.
    getProductBySlug: async (req, res) => {
      const product = await productService.getPublicProductBySlug(req.params.slug);
      res.status(200).json({
        success: true,
        message: PRODUCT_MESSAGES.PRODUCT_FETCHED,
        data: { product },
      });
    },

    // GET /api/v1/products/:id/availability — public, ACTIVE only.
    // Storefront-safe per-variant availability (no auth, no admin inventory
    // data, no reservation/ledger/cost details).
    getProductAvailability: async (req, res) => {
      const availability = await productService.getProductAvailability(req.params.id);
      res.status(200).json({
        success: true,
        message: PRODUCT_MESSAGES.AVAILABILITY_FETCHED,
        data: availability,
      });
    },

    // POST /api/v1/products — STAFF + ADMIN. Atomic product + initial variants.
    createProduct: async (req, res) => {
      const product = await productService.createProduct(req.body, {
        role: req.user ? req.user.role : null,
      });
      res.status(201).json({
        success: true,
        message: PRODUCT_MESSAGES.PRODUCT_CREATED,
        data: { product },
      });
    },

    // PATCH /api/v1/products/:id — ADMIN only.
    updateProduct: async (req, res) => {
      const product = await productService.updateProduct(req.params.id, req.body, {
        role: req.user ? req.user.role : null,
      });
      res.status(200).json({
        success: true,
        message: PRODUCT_MESSAGES.PRODUCT_UPDATED,
        data: { product },
      });
    },
  };
}

module.exports = { createProductController };
