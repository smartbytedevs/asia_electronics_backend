'use strict';

const { Router } = require('express');
const { ROLES } = require('../../constants');
const { createAdminReturnController } = require('./adminReturn.controller');
const { defaultReturnService } = require('./return.routes');
const authenticate = require('../../middlewares/authenticate');
const resolveCurrentUser = require('../../middlewares/resolveCurrentUser');
const authorizeRoles = require('../../middlewares/authorizeRoles');
const { defaultUserService } = require('../users/user.routes');

/**
 * Admin/Staff return router, mounted at /api/v1/admin/returns.
 *
 * ADMIN+STAFF only. The acting id always comes from the authenticated user —
 * never from the request body. COMPLETE is the only transition with side
 * effects (stock restock + auto-created refund, in ONE transaction).
 */
function createAdminReturnRouter({
  returnService = defaultReturnService,
  userService = defaultUserService,
  verifier,
} = {}) {
  const router = Router();
  const controller = createAdminReturnController({ returnService });

  const staff = [
    authenticate(verifier),
    resolveCurrentUser({ userService }),
    authorizeRoles(ROLES.ADMIN, ROLES.STAFF),
  ];

  router.get('/', staff, controller.listReturns);
  router.get('/:id', staff, controller.getReturn);
  router.post('/:id/approve', staff, controller.approveReturn);
  router.post('/:id/reject', staff, controller.rejectReturn);
  router.post('/:id/complete', staff, controller.completeReturn);
  router.post('/:id/cancel', staff, controller.cancelReturn);

  return router;
}

const defaultAdminRouter = createAdminReturnRouter();

module.exports = { createAdminReturnRouter, defaultAdminRouter, defaultAdminReturnService: defaultReturnService };
