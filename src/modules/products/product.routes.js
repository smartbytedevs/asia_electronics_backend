'use strict';

const { Router } = require('express');
const { ROLES } = require('../../constants');
const Product = require('./product.model');
const ProductVariant = require('./variants/productVariant.model');
const Category = require('../categories/category.model');
const Inventory = require('../inventory/inventory.model');
const { createProductRepository } = require('./product.repository');
const { createVariantRepository } = require('./variants/productVariant.repository');
const { createVariantService } = require('./variants/productVariant.service');
const { ProductService } = require('./product.service');
const { createProductController } = require('./product.controller');
const { createCategoryRepository } = require('../categories/category.repository');
const { createInventoryRepository } = require('../inventory/inventory.repository');
const authenticate = require('../../middlewares/authenticate');
const resolveCurrentUser = require('../../middlewares/resolveCurrentUser');
const authorizeRoles = require('../../middlewares/authorizeRoles');
const publicCache = require('../../middlewares/publicCache');
const { defaultUserService } = require('../users/user.routes');

/**
 * Default product service bound to the central config. Only DB operations
 * happen at request time — module load is connection-free.
 *
 * Dependencies:
 * - productRepository      — Product persistence
 * - variantRepository      — ProductVariant persistence (writes inside transactions)
 * - variantService         — variant rules (SKU, attributes, size consistency)
 * - categoryRepository     — ACTIVE category reference checks
 * - runTransaction         — MongoDB transaction helper (default: withTransaction)
 */
const defaultProductService = new ProductService({
  repository: createProductRepository(Product),
  variantRepository: createVariantRepository(ProductVariant),
  variantService: createVariantService({
    repository: createVariantRepository(ProductVariant),
    productRepository: createProductRepository(Product),
  }),
  categoryRepository: createCategoryRepository(Category),
  inventoryRepository: createInventoryRepository(Inventory),
});

/**
 * Product router, mounted at /api/v1/products.
 *
 * Public reads (storefront catalog): ACTIVE products only — no auth.
 *   GET /                 → paginated card list (filters/sort allowlisted)
 *   GET /slug/:slug       → full product by slug
 *   GET /:id              → full product by id
 *
 * Administrative mutations:
 *   POST /  → authenticate → resolveCurrentUser → authorizeRoles(ADMIN, STAFF)
 *             (STAFF may create; purchase-price stays ADMIN-only in responses)
 *   PATCH /:id → authorizeRoles(ADMIN) only (STAFF/CUSTOMER → 403)
 *
 * No DELETE — deactivation is `PATCH { isActive: false }` (see
 * docs/rbac-matrix.md and docs/business-rules.md).
 *
 * `productService`, `userService`, and `verifier` are injectable for tests;
 * production uses the defaults.
 */
function createProductRouter({
  productService = defaultProductService,
  userService = defaultUserService,
  verifier,
} = {}) {
  const router = Router();
  const controller = createProductController({ productService });

  // Public catalog reads (must be declared before /:id). These responses are
  // identical for every visitor, so they may be served from the Vercel edge
  // cache. Availability is intentionally NOT cached — stock must stay fresh.
  router.get('/', publicCache({ sMaxAge: 60 }), controller.listProducts);
  router.get(
    '/slug/:slug',
    publicCache({ sMaxAge: 60 }),
    controller.getProductBySlug
  );
  router.get('/:id/availability', controller.getProductAvailability);
  router.get('/:id', publicCache({ sMaxAge: 60 }), controller.getProductById);

  // Product + initial variants creation — STAFF and ADMIN.
  router.post(
    '/',
    authenticate(verifier),
    resolveCurrentUser({ userService }),
    authorizeRoles(ROLES.ADMIN, ROLES.STAFF),
    controller.createProduct
  );

  // Product update (incl. variant replacement, deactivation) — ADMIN only.
  router.patch(
    '/:id',
    authenticate(verifier),
    resolveCurrentUser({ userService }),
    authorizeRoles(ROLES.ADMIN),
    controller.updateProduct
  );

  return router;
}

const defaultRouter = createProductRouter();

module.exports = { createProductRouter, defaultRouter };
