'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ReservationService } = require('../../../src/modules/inventory/reservation.service');
const { ERROR_CODES } = require('../../../src/constants');
const {
  MOVEMENT_TYPES,
  RESERVATION_STATUSES,
  STOCK_LOCATIONS,
} = require('../../../src/modules/inventory/inventory.constants');
const {
  createMemoryVariantRepository,
  createMemoryInventoryRepository,
  createMemoryMovementRepository,
  createMemoryReservationRepository,
  noopTransaction,
} = require('../../helpers/inventory-stubs');

const VARIANT_ID = '507f1f77bcf86cd799439031';
const PRODUCT_ID = '507f1f77bcf86cd799439032';
const INVENTORY_ID = '507f1f77bcf86cd799439001';
const ADMIN_ID = 'usr-admin-1';

function variantDoc(overrides = {}) {
  return { _id: VARIANT_ID, isActive: true, ...overrides };
}

function makeService(overrides = {}) {
  const variantRepository = createMemoryVariantRepository([variantDoc()]);
  const inventoryRepository = createMemoryInventoryRepository();
  const movementRepository = createMemoryMovementRepository();
  const reservationRepository = createMemoryReservationRepository();
  const service = new ReservationService({
    reservationRepository,
    inventoryRepository,
    movementRepository,
    variantRepository,
    runTransaction: noopTransaction,
    ...overrides,
  });
  return { service, variantRepository, inventoryRepository, movementRepository, reservationRepository };
}

function seedInventory(inventoryRepository, overrides = {}) {
  const doc = {
    _id: INVENTORY_ID,
    productVariantId: VARIANT_ID,
    onlineQuantity: 10,
    offlineQuantity: 0,
    reservedQuantity: 0,
    lowStockThreshold: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  inventoryRepository.docs.push(doc);
  return doc;
}

function expectApiError(promise, statusCode, code) {
  return assert.rejects(promise, (err) => {
    assert.equal(err.statusCode, statusCode, `HTTP ${statusCode}`);
    assert.equal(err.code, code, `code ${code}`);
    return true;
  });
}

const futureExpiry = () => new Date(Date.now() + 60_000);
const pastExpiry = () => new Date(Date.now() - 60_000);

test('createReservation reserves ONLINE availability atomically and writes the RESERVATION movement', async () => {
  const { service, inventoryRepository, movementRepository, reservationRepository } = makeService();
  seedInventory(inventoryRepository, { onlineQuantity: 10 });

  const result = await service.createReservation({
    productVariantId: VARIANT_ID,
    quantity: 3,
    referenceType: 'ORDER',
    referenceId: 'order-1',
    expiresAt: futureExpiry(),
    performedBy: ADMIN_ID,
  });

  assert.equal(result.status, RESERVATION_STATUSES.ACTIVE);
  assert.equal(result.quantity, 3);
  assert.equal(result.referenceId, 'order-1');
  assert.equal(result.createdBy, ADMIN_ID);

  const inventory = inventoryRepository.docs[0];
  assert.equal(inventory.reservedQuantity, 3);
  assert.equal(inventory.onlineQuantity, 10);

  const movement = movementRepository.docs.find((m) => m.type === MOVEMENT_TYPES.RESERVATION);
  assert.ok(movement, 'RESERVATION movement recorded');
  assert.equal(movement.quantity, 3);
  assert.equal(movement.fromLocation, STOCK_LOCATIONS.ONLINE);
  assert.equal(movement.referenceId, 'order-1');
  assert.equal(movement.performedBy, ADMIN_ID);

  assert.equal(reservationRepository.docs.length, 1);
});

test('createReservation above available stock fails with INSUFFICIENT_AVAILABLE_STOCK and no side effects', async () => {
  const { service, inventoryRepository, movementRepository, reservationRepository } = makeService();
  seedInventory(inventoryRepository, { onlineQuantity: 2 });

  await expectApiError(
    service.createReservation({
      productVariantId: VARIANT_ID,
      quantity: 3,
      referenceType: 'ORDER',
      referenceId: 'order-1',
      performedBy: ADMIN_ID,
    }),
    409,
    ERROR_CODES.INSUFFICIENT_AVAILABLE_STOCK
  );

  assert.equal(inventoryRepository.docs[0].reservedQuantity, 0);
  assert.equal(movementRepository.docs.length, 0);
  assert.equal(reservationRepository.docs.length, 0);
});

test('an active reservation for the same reference is a RESERVATION_CONFLICT and stock is untouched', async () => {
  const { service, inventoryRepository } = makeService();
  seedInventory(inventoryRepository, { onlineQuantity: 10 });
  await service.createReservation({
    productVariantId: VARIANT_ID,
    quantity: 2,
    referenceType: 'ORDER',
    referenceId: 'order-1',
    performedBy: ADMIN_ID,
  });

  await expectApiError(
    service.createReservation({
      productVariantId: VARIANT_ID,
      quantity: 2,
      referenceType: 'ORDER',
      referenceId: 'order-1',
      performedBy: ADMIN_ID,
    }),
    409,
    ERROR_CODES.RESERVATION_CONFLICT
  );
  assert.equal(inventoryRepository.docs[0].reservedQuantity, 2);
});

test('a released reference can be reserved again', async () => {
  const { service, inventoryRepository, reservationRepository } = makeService();
  seedInventory(inventoryRepository, { onlineQuantity: 10 });
  const first = await service.createReservation({
    productVariantId: VARIANT_ID,
    quantity: 2,
    referenceType: 'ORDER',
    referenceId: 'order-1',
    performedBy: ADMIN_ID,
  });
  await service.releaseReservation({ reservationId: first.id, performedBy: ADMIN_ID });

  const second = await service.createReservation({
    productVariantId: VARIANT_ID,
    quantity: 2,
    referenceType: 'ORDER',
    referenceId: 'order-1',
    performedBy: ADMIN_ID,
  });
  assert.equal(second.status, RESERVATION_STATUSES.ACTIVE);
  assert.equal(reservationRepository.docs.length, 2);
  assert.equal(inventoryRepository.docs[0].reservedQuantity, 2);
});

test('createReservation rejects unknown and inactive variants', async () => {
  const { service, inventoryRepository } = makeService();
  seedInventory(inventoryRepository);
  await expectApiError(
    service.createReservation({
      productVariantId: '507f1f77bcf86cd799439999',
      quantity: 1,
      referenceType: 'ORDER',
      referenceId: 'order-x',
      performedBy: ADMIN_ID,
    }),
    404,
    ERROR_CODES.VARIANT_NOT_FOUND
  );
  const { service: serviceInactive } = makeService({
    variantRepository: createMemoryVariantRepository([variantDoc({ isActive: false })]),
  });
  await expectApiError(
    serviceInactive.createReservation({
      productVariantId: VARIANT_ID,
      quantity: 1,
      referenceType: 'ORDER',
      referenceId: 'order-x',
      performedBy: ADMIN_ID,
    }),
    400,
    ERROR_CODES.INVALID_INVENTORY_OPERATION
  );
});

test('releaseReservation returns stock to availability and records RESERVATION_RELEASE', async () => {
  const { service, inventoryRepository, movementRepository } = makeService();
  seedInventory(inventoryRepository, { onlineQuantity: 10 });
  const reservation = await service.createReservation({
    productVariantId: VARIANT_ID,
    quantity: 3,
    referenceType: 'ORDER',
    referenceId: 'order-1',
    performedBy: ADMIN_ID,
  });

  const outcome = await service.releaseReservation({ reservationId: reservation.id, performedBy: ADMIN_ID });

  assert.equal(outcome.reservation.status, RESERVATION_STATUSES.RELEASED);
  assert.equal(outcome.inventory.reservedQuantity, 0);
  assert.equal(outcome.inventory.availableOnlineQuantity, 10);

  const movement = movementRepository.docs.find((m) => m.type === MOVEMENT_TYPES.RESERVATION_RELEASE);
  assert.ok(movement, 'RESERVATION_RELEASE movement recorded');
  assert.equal(movement.toLocation, STOCK_LOCATIONS.ONLINE);
  assert.equal(movement.quantity, 3);
});

test('consumeReservation physically moves reserved stock out of ONLINE', async () => {
  const { service, inventoryRepository, movementRepository } = makeService();
  seedInventory(inventoryRepository, { onlineQuantity: 10 });
  const reservation = await service.createReservation({
    productVariantId: VARIANT_ID,
    quantity: 3,
    referenceType: 'ORDER',
    referenceId: 'order-1',
    performedBy: ADMIN_ID,
  });

  const outcome = await service.consumeReservation({ reservationId: reservation.id, performedBy: ADMIN_ID });

  assert.equal(outcome.reservation.status, RESERVATION_STATUSES.CONSUMED);
  assert.equal(outcome.inventory.reservedQuantity, 0);
  assert.equal(outcome.inventory.onlineQuantity, 7);

  const movement = movementRepository.docs.find((m) => m.type === MOVEMENT_TYPES.RESERVATION_CONSUME);
  assert.ok(movement, 'RESERVATION_CONSUME movement recorded');
  assert.equal(movement.fromLocation, STOCK_LOCATIONS.ONLINE);
  assert.equal(movement.quantity, 3);
});

test('double release is an idempotent no-op: no movement, stock unchanged', async () => {
  const { service, inventoryRepository, movementRepository } = makeService();
  seedInventory(inventoryRepository, { onlineQuantity: 10 });
  const reservation = await service.createReservation({
    productVariantId: VARIANT_ID,
    quantity: 3,
    referenceType: 'ORDER',
    referenceId: 'order-1',
    performedBy: ADMIN_ID,
  });
  await service.releaseReservation({ reservationId: reservation.id, performedBy: ADMIN_ID });
  const movementCount = movementRepository.docs.length;

  const second = await service.releaseReservation({ reservationId: reservation.id, performedBy: ADMIN_ID });

  assert.equal(second.reservation.status, RESERVATION_STATUSES.RELEASED);
  assert.equal(second.inventory, null);
  assert.equal(movementRepository.docs.length, movementCount, 'no extra movement on retry');
  assert.equal(inventoryRepository.docs[0].reservedQuantity, 0);
});

test('double consume is an idempotent no-op: no movement, stock unchanged', async () => {
  const { service, inventoryRepository, movementRepository } = makeService();
  seedInventory(inventoryRepository, { onlineQuantity: 10 });
  const reservation = await service.createReservation({
    productVariantId: VARIANT_ID,
    quantity: 3,
    referenceType: 'ORDER',
    referenceId: 'order-1',
    performedBy: ADMIN_ID,
  });
  await service.consumeReservation({ reservationId: reservation.id, performedBy: ADMIN_ID });
  const movementCount = movementRepository.docs.length;

  const second = await service.consumeReservation({ reservationId: reservation.id, performedBy: ADMIN_ID });

  assert.equal(second.reservation.status, RESERVATION_STATUSES.CONSUMED);
  assert.equal(second.inventory, null);
  assert.equal(movementRepository.docs.length, movementCount, 'no extra movement on retry');
  assert.equal(inventoryRepository.docs[0].onlineQuantity, 7);
  assert.equal(inventoryRepository.docs[0].reservedQuantity, 0);
});

test('release of a consumed reservation is RESERVATION_NOT_ACTIVE', async () => {
  const { service, inventoryRepository, movementRepository } = makeService();
  seedInventory(inventoryRepository, { onlineQuantity: 10 });
  const reservation = await service.createReservation({
    productVariantId: VARIANT_ID,
    quantity: 3,
    referenceType: 'ORDER',
    referenceId: 'order-1',
    performedBy: ADMIN_ID,
  });
  await service.consumeReservation({ reservationId: reservation.id, performedBy: ADMIN_ID });
  const movementCount = movementRepository.docs.length;

  await expectApiError(
    service.releaseReservation({ reservationId: reservation.id, performedBy: ADMIN_ID }),
    409,
    ERROR_CODES.RESERVATION_NOT_ACTIVE
  );
  assert.equal(movementRepository.docs.length, movementCount, 'wrong transition writes no movement');
});

test('consume of a released reservation is RESERVATION_NOT_ACTIVE', async () => {
  const { service, inventoryRepository, movementRepository } = makeService();
  seedInventory(inventoryRepository, { onlineQuantity: 10 });
  const reservation = await service.createReservation({
    productVariantId: VARIANT_ID,
    quantity: 3,
    referenceType: 'ORDER',
    referenceId: 'order-1',
    performedBy: ADMIN_ID,
  });
  await service.releaseReservation({ reservationId: reservation.id, performedBy: ADMIN_ID });
  const movementCount = movementRepository.docs.length;

  await expectApiError(
    service.consumeReservation({ reservationId: reservation.id, performedBy: ADMIN_ID }),
    409,
    ERROR_CODES.RESERVATION_NOT_ACTIVE
  );
  assert.equal(movementRepository.docs.length, movementCount);
});

test('release/consume/expire of an already-expired reservation is RESERVATION_EXPIRED', async () => {
  const { service, inventoryRepository, reservationRepository } = makeService();
  seedInventory(inventoryRepository, { onlineQuantity: 10 });
  const reservation = await service.createReservation({
    productVariantId: VARIANT_ID,
    quantity: 3,
    referenceType: 'ORDER',
    referenceId: 'order-1',
    expiresAt: pastExpiry(),
    performedBy: ADMIN_ID,
  });
  await service.expireReservation({ reservationId: reservation.id, performedBy: ADMIN_ID });

  await expectApiError(
    service.releaseReservation({ reservationId: reservation.id, performedBy: ADMIN_ID }),
    409,
    ERROR_CODES.RESERVATION_EXPIRED
  );
  await expectApiError(
    service.consumeReservation({ reservationId: reservation.id, performedBy: ADMIN_ID }),
    409,
    ERROR_CODES.RESERVATION_EXPIRED
  );
  const expired = await service.expireReservation({ reservationId: reservation.id, performedBy: ADMIN_ID });
  assert.equal(expired.status, RESERVATION_STATUSES.EXPIRED);
  assert.equal(reservationRepository.docs[0].status, RESERVATION_STATUSES.EXPIRED);
});

test('expireReservation releases stock and records a RESERVATION_RELEASE movement with reason "expired"', async () => {
  const { service, inventoryRepository, movementRepository } = makeService();
  seedInventory(inventoryRepository, { onlineQuantity: 10 });
  const reservation = await service.createReservation({
    productVariantId: VARIANT_ID,
    quantity: 3,
    referenceType: 'ORDER',
    referenceId: 'order-1',
    expiresAt: futureExpiry(),
    performedBy: ADMIN_ID,
  });

  const result = await service.expireReservation({ reservationId: reservation.id, performedBy: ADMIN_ID });

  assert.equal(result.status, RESERVATION_STATUSES.EXPIRED);
  assert.equal(result.resolvedBy, ADMIN_ID);
  assert.ok(result.resolvedAt, 'resolvedAt is stamped');
  assert.equal(inventoryRepository.docs[0].reservedQuantity, 0);

  const movement = movementRepository.docs.find(
    (m) => m.type === MOVEMENT_TYPES.RESERVATION_RELEASE && m.reason === 'expired'
  );
  assert.ok(movement, 'expiry release movement recorded');
  assert.equal(movement.quantity, 3);
});

test('expireReservation on a terminal reservation is a no-op', async () => {
  const { service, inventoryRepository, movementRepository } = makeService();
  seedInventory(inventoryRepository, { onlineQuantity: 10 });
  const reservation = await service.createReservation({
    productVariantId: VARIANT_ID,
    quantity: 3,
    referenceType: 'ORDER',
    referenceId: 'order-1',
    performedBy: ADMIN_ID,
  });
  await service.releaseReservation({ reservationId: reservation.id, performedBy: ADMIN_ID });
  const movementCount = movementRepository.docs.length;

  const result = await service.expireReservation({ reservationId: reservation.id, performedBy: ADMIN_ID });
  assert.equal(result.status, RESERVATION_STATUSES.RELEASED);
  assert.equal(movementRepository.docs.length, movementCount, 'no new movement');
});

test('expireReservation for a missing reservation returns 404', async () => {
  const { service } = makeService();
  await expectApiError(
    service.expireReservation({ reservationId: '507f1f77bcf86cd799439999', performedBy: ADMIN_ID }),
    404,
    ERROR_CODES.RESERVATION_NOT_FOUND
  );
});

test('releasing an ACTIVE reservation past expiresAt auto-expires it, then surfaces RESERVATION_EXPIRED', async () => {
  const { service, inventoryRepository, movementRepository, reservationRepository } = makeService();
  seedInventory(inventoryRepository, { onlineQuantity: 10 });
  const reservation = await service.createReservation({
    productVariantId: VARIANT_ID,
    quantity: 3,
    referenceType: 'ORDER',
    referenceId: 'order-1',
    expiresAt: pastExpiry(),
    performedBy: ADMIN_ID,
  });

  await expectApiError(
    service.releaseReservation({ reservationId: reservation.id, performedBy: ADMIN_ID }),
    409,
    ERROR_CODES.RESERVATION_EXPIRED
  );

  assert.equal(reservationRepository.docs[0].status, RESERVATION_STATUSES.EXPIRED);
  assert.equal(inventoryRepository.docs[0].reservedQuantity, 0, 'stock released by auto-expiry');
  assert.ok(
    movementRepository.docs.some((m) => m.reason === 'expired'),
    'expiry release movement written'
  );
});

test('getReservation returns the serialized reservation and 404 when missing', async () => {
  const { service, inventoryRepository } = makeService();
  seedInventory(inventoryRepository, { onlineQuantity: 10 });
  await expectApiError(
    service.getReservation('507f1f77bcf86cd799439999'),
    404,
    ERROR_CODES.RESERVATION_NOT_FOUND
  );
  const reservation = await service.createReservation({
    productVariantId: VARIANT_ID,
    quantity: 2,
    referenceType: 'ORDER',
    referenceId: 'order-1',
    performedBy: ADMIN_ID,
  });
  const fetched = await service.getReservation(reservation.id);
  assert.equal(fetched.id, reservation.id);
  assert.equal(fetched.quantity, 2);
});

test('listReservations filters by status and paginates', async () => {
  const { service, inventoryRepository } = makeService();
  seedInventory(inventoryRepository, { onlineQuantity: 50 });
  const first = await service.createReservation({
    productVariantId: VARIANT_ID,
    quantity: 2,
    referenceType: 'ORDER',
    referenceId: 'order-1',
    performedBy: ADMIN_ID,
  });
  await service.createReservation({
    productVariantId: VARIANT_ID,
    quantity: 3,
    referenceType: 'ORDER',
    referenceId: 'order-2',
    performedBy: ADMIN_ID,
  });
  await service.releaseReservation({ reservationId: first.id, performedBy: ADMIN_ID });

  const active = await service.listReservations({ status: RESERVATION_STATUSES.ACTIVE });
  assert.equal(active.pagination.total, 1);
  assert.equal(active.reservations[0].referenceId, 'order-2');

  const all = await service.listReservations({ page: 1, limit: 1 });
  assert.equal(all.pagination.total, 2);
  assert.equal(all.reservations.length, 1);

  await assert.rejects(
    () => service.listReservations({ status: 'HELD' }),
    (err) => err.statusCode === 400
  );
});

/**
 * C1: Simple Products (Strategy A). The reservation subject is the PRODUCT
 * (`productId`, `productVariantId: null`) and stock lives on the product-level
 * Inventory record. No variant is invented or required.
 */
test('simple product: create + release reserve product-level ONLINE stock', async () => {
  const { service, inventoryRepository, movementRepository } = makeService();
  seedInventory(inventoryRepository, {
    productId: PRODUCT_ID,
    productVariantId: null,
    onlineQuantity: 10,
  });

  const reservation = await service.createReservation({
    productId: PRODUCT_ID,
    productVariantId: null,
    quantity: 4,
    referenceType: 'ORDER',
    referenceId: 'order-simple-1',
    performedBy: ADMIN_ID,
  });

  assert.equal(reservation.productId, PRODUCT_ID);
  assert.equal(reservation.productVariantId, null);
  assert.equal(reservation.status, RESERVATION_STATUSES.ACTIVE);
  assert.equal(inventoryRepository.docs[0].reservedQuantity, 4);

  const reserveMovement = movementRepository.docs.find(
    (m) => m.type === MOVEMENT_TYPES.RESERVATION
  );
  assert.ok(reserveMovement, 'RESERVATION movement recorded');
  assert.equal(reserveMovement.productId, PRODUCT_ID);
  assert.equal(reserveMovement.productVariantId, null);

  const outcome = await service.releaseReservation({
    reservationId: reservation.id,
    performedBy: ADMIN_ID,
  });

  assert.equal(outcome.reservation.status, RESERVATION_STATUSES.RELEASED);
  assert.equal(outcome.inventory.productId, PRODUCT_ID);
  assert.equal(outcome.inventory.productVariantId, null);
  assert.equal(outcome.inventory.reservedQuantity, 0);
  assert.equal(outcome.inventory.availableOnlineQuantity, 10);

  const releaseMovement = movementRepository.docs.find(
    (m) => m.type === MOVEMENT_TYPES.RESERVATION_RELEASE
  );
  assert.ok(releaseMovement, 'RESERVATION_RELEASE movement recorded');
  assert.equal(releaseMovement.productVariantId, null);
  assert.equal(releaseMovement.toLocation, STOCK_LOCATIONS.ONLINE);
});

test('simple product: consume physically removes product-level ONLINE stock', async () => {
  const { service, inventoryRepository, movementRepository } = makeService();
  seedInventory(inventoryRepository, {
    productId: PRODUCT_ID,
    productVariantId: null,
    onlineQuantity: 10,
  });

  const reservation = await service.createReservation({
    productId: PRODUCT_ID,
    quantity: 3,
    referenceType: 'ORDER',
    referenceId: 'order-simple-2',
    performedBy: ADMIN_ID,
  });
  const outcome = await service.consumeReservation({
    reservationId: reservation.id,
    performedBy: ADMIN_ID,
  });

  assert.equal(outcome.reservation.status, RESERVATION_STATUSES.CONSUMED);
  assert.equal(outcome.inventory.onlineQuantity, 7);
  assert.equal(outcome.inventory.reservedQuantity, 0);

  const movement = movementRepository.docs.find(
    (m) => m.type === MOVEMENT_TYPES.RESERVATION_CONSUME
  );
  assert.ok(movement, 'RESERVATION_CONSUME movement recorded');
  assert.equal(movement.productId, PRODUCT_ID);
  assert.equal(movement.productVariantId, null);
  assert.equal(movement.fromLocation, STOCK_LOCATIONS.ONLINE);
});

test('simple product: expire releases product-level stock with reason "expired"', async () => {
  const { service, inventoryRepository, movementRepository } = makeService();
  seedInventory(inventoryRepository, {
    productId: PRODUCT_ID,
    productVariantId: null,
    onlineQuantity: 10,
  });

  const reservation = await service.createReservation({
    productId: PRODUCT_ID,
    quantity: 2,
    referenceType: 'ORDER',
    referenceId: 'order-simple-3',
    expiresAt: futureExpiry(),
    performedBy: ADMIN_ID,
  });
  const result = await service.expireReservation({
    reservationId: reservation.id,
    performedBy: ADMIN_ID,
  });

  assert.equal(result.status, RESERVATION_STATUSES.EXPIRED);
  assert.equal(result.productVariantId, null);
  assert.equal(inventoryRepository.docs[0].reservedQuantity, 0);

  const movement = movementRepository.docs.find(
    (m) => m.type === MOVEMENT_TYPES.RESERVATION_RELEASE && m.reason === 'expired'
  );
  assert.ok(movement, 'expiry release movement recorded');
  assert.equal(movement.productId, PRODUCT_ID);
  assert.equal(movement.productVariantId, null);
});

test('simple product: reserving above available product-level stock has no side effects', async () => {
  const { service, inventoryRepository, movementRepository, reservationRepository } = makeService();
  seedInventory(inventoryRepository, {
    productId: PRODUCT_ID,
    productVariantId: null,
    onlineQuantity: 2,
  });

  await expectApiError(
    service.createReservation({
      productId: PRODUCT_ID,
      quantity: 3,
      referenceType: 'ORDER',
      referenceId: 'order-simple-4',
      performedBy: ADMIN_ID,
    }),
    409,
    ERROR_CODES.INSUFFICIENT_AVAILABLE_STOCK
  );

  assert.equal(inventoryRepository.docs[0].reservedQuantity, 0);
  assert.equal(movementRepository.docs.length, 0);
  assert.equal(reservationRepository.docs.length, 0);
});
