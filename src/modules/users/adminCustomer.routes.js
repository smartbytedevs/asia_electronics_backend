'use strict';

const { Router } = require('express');
const { ROLES } = require('../../constants');
const { createAdminCustomerController } = require('./adminCustomer.controller');
const { defaultUserService } = require('./user.routes');
const authenticate = require('../../middlewares/authenticate');
const resolveCurrentUser = require('../../middlewares/resolveCurrentUser');
const authorizeRoles = require('../../middlewares/authorizeRoles');

/**
 * Admin customer router, mounted at /api/v1/admin/customers.
 *
 * ADMIN-only read surface (list + detail). STAFF/CUSTOMER → 403; anonymous →
 * 401. There are no customer mutation endpoints in this phase — the surface
 * only reads the existing User collection.
 */
function createAdminCustomerRouter({
  userService = defaultUserService,
  verifier,
} = {}) {
  const router = Router();
  const controller = createAdminCustomerController({ userService });

  const admin = [
    authenticate(verifier),
    resolveCurrentUser({ userService }),
    authorizeRoles(ROLES.ADMIN),
  ];

  router.get('/', admin, controller.listCustomers);
  router.get('/:id', admin, controller.getCustomer);

  return router;
}

const defaultAdminRouter = createAdminCustomerRouter();

module.exports = { createAdminCustomerRouter, defaultAdminRouter };
