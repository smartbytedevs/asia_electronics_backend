'use strict';

/**
 * Cart constants (Phase 07, ADR-0015).
 *
 * The cart is a SERVER-SIDE per-customer draft that stores ONLY variant
 * references + quantities. It NEVER stores prices, discounts, effective
 * prices, or delivery fees — all money is derived server-side from the live
 * catalog at read time and recomputed authoritatively at checkout.
 */

const CART_LIMITS = Object.freeze({
  ITEMS_MAX: 100,
  QUANTITY_MAX: 1_000_000_000,
  SELECTED_SIZE_MAX: 50,
});

/**
 * Whitelist of every client-writable cart-item field. Shared by the validator
 * and the service to reject unknown/immutable/operator keys (`$set`, `_id`,
 * `customerId`, `userId`, `price`, `discount`, ...). Prevents mass-assignment,
 * operator injection, and client-controlled money. `customerId` is ALWAYS
 * derived from `req.user`, never accepted from the request body.
 */
const CART_ITEM_INPUT_FIELDS = Object.freeze([
  'productId',
  'productVariantId',
  'quantity',
  'selectedSize',
]);

const CART_MESSAGES = Object.freeze({
  CART_FETCHED: 'Cart retrieved successfully',
  ITEM_ADDED: 'Cart item added successfully',
  ITEM_UPDATED: 'Cart item updated successfully',
  ITEM_REMOVED: 'Cart item removed successfully',
  CART_CLEARED: 'Cart cleared successfully',
  CART_NOT_FOUND: 'Cart not found',
  CART_EMPTY: 'Cart is empty',
  INVALID_CART_ITEM: 'Invalid cart item',
  CART_ITEM_LIMIT: 'Cart item limit reached',
});

module.exports = {
  CART_LIMITS,
  CART_ITEM_INPUT_FIELDS,
  CART_MESSAGES,
};
