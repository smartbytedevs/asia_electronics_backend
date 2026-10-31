'use strict';

const {
  validateAddItemInput,
  validateUpdateItemInput,
} = require('./cart.validation');
const { CART_MESSAGES } = require('./cart.constants');

/**
 * Thin cart controller (Phase 07): validate input, delegate to the service,
 * serialize the response envelope. No MongoDB access and no business rules
 * here. The customer id ALWAYS comes from the resolved `req.user.id` — never
 * from the request body (the validator rejects `customerId`/`userId`/money).
 */
function createCartController({ cartService }) {
  if (!cartService || typeof cartService.getCart !== 'function') {
    throw new Error('createCartController requires a cartService');
  }

  const customerId = (req) => req.user.id;

  return {
    // GET /api/v1/cart — CUSTOMER (own).
    getCart: async (req, res) => {
      const cart = await cartService.getCart(customerId(req));
      res.status(200).json({
        success: true,
        message: CART_MESSAGES.CART_FETCHED,
        data: { cart },
      });
    },

    // POST /api/v1/cart/items — CUSTOMER (own).
    addItem: async (req, res) => {
      const { value } = validateAddItemInput(req.body);
      const cart = await cartService.addItem({
        customerId: customerId(req),
        ...value,
      });
      res.status(200).json({
        success: true,
        message: CART_MESSAGES.ITEM_ADDED,
        data: { cart },
      });
    },

    // PATCH /api/v1/cart/items/:id — CUSTOMER (own).
    updateItem: async (req, res) => {
      const { value } = validateUpdateItemInput(req.body);
      const cart = await cartService.updateItem({
        customerId: customerId(req),
        itemId: req.params.id,
        ...value,
      });
      res.status(200).json({
        success: true,
        message: CART_MESSAGES.ITEM_UPDATED,
        data: { cart },
      });
    },

    // DELETE /api/v1/cart/items/:id — CUSTOMER (own).
    removeItem: async (req, res) => {
      const cart = await cartService.removeItem({
        customerId: customerId(req),
        itemId: req.params.id,
      });
      res.status(200).json({
        success: true,
        message: CART_MESSAGES.ITEM_REMOVED,
        data: { cart },
      });
    },

    // DELETE /api/v1/cart — CUSTOMER (own).
    clearCart: async (req, res) => {
      const cart = await cartService.clearCart(customerId(req));
      res.status(200).json({
        success: true,
        message: CART_MESSAGES.CART_CLEARED,
        data: { cart },
      });
    },
  };
}

module.exports = { createCartController };
