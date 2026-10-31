'use strict';

const { Router } = require('express');
const { ROLES } = require('../../constants');
const Category = require('./category.model');
const { createCategoryRepository } = require('./category.repository');
const { CategoryService } = require('./category.service');
const { createCategoryController } = require('./category.controller');
const authenticate = require('../../middlewares/authenticate');
const resolveCurrentUser = require('../../middlewares/resolveCurrentUser');
const authorizeRoles = require('../../middlewares/authorizeRoles');
const { defaultUserService } = require('../users/user.routes');

/**
 * Default category service bound to the central config. Only DB operations
 * happen at request time — module load is connection-free.
 */
const defaultCategoryService = new CategoryService({
  repository: createCategoryRepository(Category),
});

/**
 * Category router, mounted at /api/v1/categories.
 *
 * Public reads (storefront catalog): ACTIVE categories only — no auth.
 * Administrative mutations: authenticate → resolveCurrentUser →
 * authorizeRoles(ADMIN) → controller. STAFF and CUSTOMER cannot mutate
 * categories (see docs/rbac-matrix.md).
 *
 * `categoryService`, `userService`, and `verifier` are injectable for tests;
 * production uses the defaults.
 */
function createCategoryRouter({
  categoryService = defaultCategoryService,
  userService = defaultUserService,
  verifier,
} = {}) {
  const router = Router();
  const controller = createCategoryController({ categoryService });

  // Public catalog reads (must be declared before /:id).
  router.get('/', controller.listCategories);
  router.get('/slug/:slug', controller.getCategoryBySlug);
  router.get('/:id', controller.getCategoryById);

  // Administrative mutations — ADMIN only.
  router.post(
    '/',
    authenticate(verifier),
    resolveCurrentUser({ userService }),
    authorizeRoles(ROLES.ADMIN),
    controller.createCategory
  );
  router.patch(
    '/:id',
    authenticate(verifier),
    resolveCurrentUser({ userService }),
    authorizeRoles(ROLES.ADMIN),
    controller.updateCategory
  );

  return router;
}

const defaultRouter = createCategoryRouter();

module.exports = { createCategoryRouter, defaultRouter };
