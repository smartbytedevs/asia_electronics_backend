'use strict';

const { Router } = require('express');
const { ROLES } = require('../../constants');
const Inventory = require('./inventory.model');
const InventoryMovement = require('./inventoryMovement.model');
const Reservation = require('./reservation.model');
const { createInventoryRepository } = require('./inventory.repository');
const { createInventoryMovementRepository } = require('./inventoryMovement.repository');
const { createReservationRepository } = require('./reservation.repository');
const { InventoryService } = require('./inventory.service');
const { ReservationService } = require('./reservation.service');
const { createInventoryController } = require('./inventory.controller');
const { createVariantRepository } = require('../products/variants/productVariant.repository');
const ProductVariant = require('../products/variants/productVariant.model');
const { createProductRepository } = require('../products/product.repository');
const Product = require('../products/product.model');
const { createOutletRepository } = require('../outlets/outlet.repository');
const Outlet = require('../outlets/outlet.model');
const authenticate = require('../../middlewares/authenticate');
const resolveCurrentUser = require('../../middlewares/resolveCurrentUser');
const authorizeRoles = require('../../middlewares/authorizeRoles');
const { defaultUserService } = require('../users/user.routes');

/**
 * Default inventory services bound to the central config. Only DB operations
 * happen at request time — module load is connection-free.
 *
 * Dependencies:
 * - inventoryRepository  — atomic conditional stock updates + reads
 * - movementRepository   — immutable InventoryMovement ledger writes/reads
 * - reservationRepository— Reservation persistence + atomic status transitions
 * - variantRepository    — ACTIVE ProductVariant reference checks
 * - runTransaction       — MongoDB transaction helper (default: withTransaction)
 */
const defaultInventoryRepository = createInventoryRepository(Inventory);
const defaultMovementRepository = createInventoryMovementRepository(InventoryMovement);
const defaultVariantRepository = createVariantRepository(ProductVariant);

const defaultInventoryService = new InventoryService({
  inventoryRepository: defaultInventoryRepository,
  movementRepository: defaultMovementRepository,
  variantRepository: defaultVariantRepository,
  outletRepository: createOutletRepository(Outlet),
  productRepository: createProductRepository(Product),
});

const defaultReservationService = new ReservationService({
  reservationRepository: createReservationRepository(Reservation),
  inventoryRepository: defaultInventoryRepository,
  movementRepository: defaultMovementRepository,
  variantRepository: defaultVariantRepository,
});

/**
 * Inventory router, mounted at /api/v1/inventory.
 *
 * ALL endpoints are ADMIN-only — stock control is a sensitive administrative
 * capability (see docs/rbac-matrix.md). Every route composes:
 *   authenticate → resolveCurrentUser → authorizeRoles(ADMIN) → controller
 * STAFF and CUSTOMER get 403; JWT role claims / body / query / header role
 * spoofing never elevates.
 *
 * There is NO generic inventory PATCH and NO movement/inventory/reservation
 * deletion — mutations are explicit business commands and corrections are new
 * movements.
 *
 * `inventoryService`, `reservationService`, `userService`, and `verifier` are
 * injectable for tests; production uses the defaults.
 */
function createInventoryRouter({
  inventoryService = defaultInventoryService,
  reservationService = defaultReservationService,
  userService = defaultUserService,
  verifier,
} = {}) {
  const router = Router();
  const controller = createInventoryController({ inventoryService, reservationService });

  const admin = [
    authenticate(verifier),
    resolveCurrentUser({ userService }),
    authorizeRoles(ROLES.ADMIN),
  ];

  // Reads — low-stock and reservations must be declared before /:productVariantId.
  router.get('/', admin, controller.listInventory);
  router.get('/low-stock', admin, controller.getLowStock);
  router.get('/reservations', admin, controller.listReservations);
  router.get('/reservations/:id', admin, controller.getReservation);
  router.get('/:productVariantId/movements', admin, controller.getInventoryMovements);
  router.get('/:productVariantId', admin, controller.getInventory);

  // Stock mutations.
  router.post('/initialize', admin, controller.initializeInventory);
  router.post('/stock-in', admin, controller.addStock);
  router.post('/stock-out', admin, controller.removeStock);
  router.post('/transfer', admin, controller.transferStock);
  router.post('/adjust', admin, controller.adjustStock);

  // Reservations.
  router.post('/reservations', admin, controller.createReservation);
  router.post('/reservations/:id/release', admin, controller.releaseReservation);
  router.post('/reservations/:id/consume', admin, controller.consumeReservation);
  router.post('/reservations/:id/expire', admin, controller.expireReservation);

  return router;
}

const defaultRouter = createInventoryRouter();

module.exports = { createInventoryRouter, defaultRouter };
