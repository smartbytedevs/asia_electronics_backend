'use strict';

const { Router } = require('express');
const Outlet = require('./outlet.model');
const { createOutletRepository } = require('./outlet.repository');
const { OutletService } = require('./outlet.service');
const { createOutletController } = require('./outlet.controller');
const publicCache = require('../../middlewares/publicCache');

/**
 * Default outlet service bound to the central config. Only DB operations
 * happen at request time — module load is connection-free.
 */
const defaultOutletService = new OutletService({
  repository: createOutletRepository(Outlet),
});

/**
 * Public outlet router, mounted at /api/v1/outlets.
 *
 * Storefront reads only: ACTIVE outlets, no auth. Inactive outlets behave as
 * not-found for the storefront but remain stored so historical inventory
 * references stay intact. Administration lives in the ADMIN-only router at
 * /api/v1/admin/outlets (see adminOutlet.routes.js).
 *
 * `outletService` is injectable for tests; production uses the default.
 */
function createOutletRouter({ outletService = defaultOutletService } = {}) {
  const router = Router();
  const controller = createOutletController({ outletService });

  // Public catalog reads (must be declared before /:id). Outlets change
  // rarely, so they get a longer edge TTL with stale-while-revalidate.
  router.get(
    '/',
    publicCache({ sMaxAge: 300, staleWhileRevalidate: 600 }),
    controller.listOutlets
  );
  router.get(
    '/code/:code',
    publicCache({ sMaxAge: 300, staleWhileRevalidate: 600 }),
    controller.getOutletByCode
  );
  router.get(
    '/:id',
    publicCache({ sMaxAge: 300, staleWhileRevalidate: 600 }),
    controller.getOutletById
  );

  return router;
}

const defaultRouter = createOutletRouter();

module.exports = { createOutletRouter, defaultRouter };
