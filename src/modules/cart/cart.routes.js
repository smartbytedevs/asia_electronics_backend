'use strict';

const { Router } = require('express');
const { ROLES } = require('../../constants');
const Cart = require('./cart.model');
const { createCartRepository } = require('./cart.repository');
const { CartService } = require('./cart.service');
const { createCartController } = require('./cart.controller');
const { createProductRepository } = require('../products/product.repository');
const Product = require('../products/product.model');
const { createVariantRepository } = require('../products/variants/productVariant.repository');
const ProductVariant = require('../products/variants/productVariant.model');
const { createInventoryRepository } = require('../inventory/inventory.repository');
const Inventory = require('../inventory/inventory.model');
const resolveStorefrontCustomer = require('../../middlewares/resolveStorefrontCustomer');
const authorizeRoles = require('../../middlewares/authorizeRoles');
const { defaultUserService } = require('../users/user.routes');

/**
 * Default cart service bound to the central config. Only DB operations happen
 * at request time — module load is connection-free.
 *
 * Dependencies:
 * - cartRepository      — Cart persistence (one cart per customer)
 * - productRepository   — live Product lookups for enrichment/validation
 * - variantRepository   — live ProductVariant lookups for enrichment/validation
 * - inventoryRepository — live availability for enrichment
 */
const defaultCartService = new CartService({
  cartRepository: createCartRepository(Cart),
  productRepository: createProductRepository(Product),
  variantRepository: createVariantRepository(ProductVariant),
  inventoryRepository: createInventoryRepository(Inventory),
});

/**
 * Cart router, mounted at /api/v1/cart.
 *
 * CUSTOMER-only and strictly customer-scoped: the service always operates on
 * the cart of `req.user.id`. No cart body may carry a customer id, user id,
 * prices, discounts, or fees (validator rejects them). The cart itself stores
 * only variant references + quantities.
 *
 * The customer gate accepts a verified Bearer token OR a guest identity
 * (`X-Guest-Id`), so guests keep a working backend cart without an account.
 *
 * `cartService`, `userService`, and `verifier` are injectable for tests;
 * production uses the defaults.
 */
function createCartRouter({
  cartService = defaultCartService,
  userService = defaultUserService,
  verifier,
} = {}) {
  const router = Router();
  const controller = createCartController({ cartService });

  const customer = [
    resolveStorefrontCustomer({ verifier, userService }),
    authorizeRoles(ROLES.CUSTOMER),
  ];

  router.get('/', customer, controller.getCart);
  router.post('/items', customer, controller.addItem);
  router.patch('/items/:id', customer, controller.updateItem);
  router.delete('/items/:id', customer, controller.removeItem);
  router.delete('/', customer, controller.clearCart);
  return router;
}

const defaultRouter = createCartRouter();

module.exports = { createCartRouter, defaultRouter, defaultCartService };
