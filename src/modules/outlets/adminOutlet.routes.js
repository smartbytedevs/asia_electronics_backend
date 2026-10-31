'use strict';

const { Router } = require('express');
const { ROLES } = require('../../constants');
const Outlet = require('./outlet.model');
const { createOutletRepository } = require('./outlet.repository');
const { OutletService } = require('./outlet.service');
const { createOutletController } = require('./outlet.controller');
const authenticate = require('../../middlewares/authenticate');
const resolveCurrentUser = require('../../middlewares/resolveCurrentUser');
const authorizeRoles = require('../../middlewares/authorizeRoles');
const { defaultUserService } = require('../users/user.routes');

/**
 * Default outlet service bound to the central config. Only DB operations
 * happen at request time — module load is connection-free.
 */
const defaultOutletService = new OutletService({
  repository: createOutletRepository(Outlet),
});

/**
 * Admin outlet router, mounted at /api/v1/admin/outlets.
 *
 * Outlet management is ADMIN-only. Every route composes:
 *   authenticate → resolveCurrentUser → authorizeRoles(ADMIN) → controller
 * STAFF and CUSTOMER get 403; JWT role claims / body / query / header role
 * spoofing never elevates. Deactivation is always soft (`isActive: false`),
 * never deletion — historical inventory references stay intact.
 *
 * `outletService`, `userService`, and `verifier` are injectable for tests;
 * production uses the defaults.
 */
function createAdminOutletRouter({
  outletService = defaultOutletService,
  userService = defaultUserService,
  verifier,
} = {}) {
  const router = Router();
  const controller = createOutletController({ outletService });

  const admin = [
    authenticate(verifier),
    resolveCurrentUser({ userService }),
    authorizeRoles(ROLES.ADMIN),
  ];

  router.post('/', admin, controller.createOutlet);
  router.get('/', admin, controller.listOutletsAdmin);
  router.get('/:id', admin, controller.getOutletByIdAdmin);
  router.patch('/:id', admin, controller.updateOutlet);

  return router;
}

const defaultAdminRouter = createAdminOutletRouter();

module.exports = { createAdminOutletRouter, defaultAdminRouter };
