'use strict';

const { Router } = require('express');
const config = require('../../config');
const User = require('./user.model');
const { createUserRepository } = require('./user.repository');
const { UserService } = require('./user.service');
const { createUserController } = require('./user.controller');
const authenticate = require('../../middlewares/authenticate');
const resolveCurrentUser = require('../../middlewares/resolveCurrentUser');

/**
 * Default application user service, bound to the central config. Only DB
 * operations happen at request time — module load is connection-free.
 */
const defaultUserService = new UserService({
  repository: createUserRepository(User),
  autoProvisionCustomers: config.users.autoProvisionCustomers,
});

/**
 * Creates the user router. `userService` and `verifier` are injectable for
 * tests; production uses the defaults. Mounted at /api/v1. Only the minimal
 * /me capability exists in this phase — no public user-management or admin
 * provisioning endpoints.
 */
function createUserRouter({
  userService = defaultUserService,
  verifier,
} = {}) {
  const router = Router();
  const controller = createUserController({ userService });

  router.get(
    '/me',
    authenticate(verifier),
    resolveCurrentUser({ userService }),
    controller.getMe
  );

  return router;
}

const defaultRouter = createUserRouter();

module.exports = { createUserRouter, defaultRouter, defaultUserService };
