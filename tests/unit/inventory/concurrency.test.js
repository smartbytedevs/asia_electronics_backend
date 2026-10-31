'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ReservationService } = require('../../../src/modules/inventory/reservation.service');
const { ERROR_CODES } = require('../../../src/constants');
const {
  MOVEMENT_TYPES,
  RESERVATION_STATUSES,
} = require('../../../src/modules/inventory/inventory.constants');
const {
  createMemoryVariantRepository,
  createMemoryInventoryRepository,
  createMemoryMovementRepository,
  createMemoryReservationRepository,
  noopTransaction,
  availableOnline,
} = require('../../helpers/inventory-stubs');

/**
 * Concurrency tests for the inventory/reservation atomicity guarantees.
 *
 * LIMITATION (documented in docs/inventory-state-machine.md, report Section
 * 86): there is no live MongoDB or MongoMemoryServer in this test
 * environment, so these tests CANNOT observe real snapshot-isolation races.
 * What they DO prove is that, when every mutation is expressed as an ATOMIC
 * CONDITIONAL update (the repository stubs apply exactly the same
 * `$expr`-based conditions as the production `findOneAndUpdate` filters),
 * concurrent service calls cannot oversell stock or double-apply a state
 * transition, and the final document state always satisfies the inventory
 * invariants. The single-threaded JavaScript runtime serializes each
 * conditional check+mutate, modelling one commit at a time.
 */

const VARIANT_ID = '507f1f77bcf86cd799439031';
const INVENTORY_ID = '507f1f77bcf86cd799439001';
const ADMIN_ID = 'usr-admin-1';

function makeService(seed = {}) {
  const inventoryRepository = createMemoryInventoryRepository([
    {
      _id: INVENTORY_ID,
      productVariantId: VARIANT_ID,
      onlineQuantity: seed.onlineQuantity ?? 0,
      offlineQuantity: 0,
      reservedQuantity: seed.reservedQuantity ?? 0,
      lowStockThreshold: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);
  const movementRepository = createMemoryMovementRepository();
  const reservationRepository = createMemoryReservationRepository();
  const service = new ReservationService({
    reservationRepository,
    inventoryRepository,
    movementRepository,
    variantRepository: createMemoryVariantRepository([{ _id: VARIANT_ID, isActive: true }]),
    runTransaction: noopTransaction,
  });
  return { service, inventoryRepository, movementRepository, reservationRepository };
}

test('concurrent reservations over a shared pool can never oversell available stock', async () => {
  const { service, inventoryRepository } = makeService({ onlineQuantity: 5 });

  const calls = Array.from({ length: 10 }, (_, i) =>
    service.createReservation({
      productVariantId: VARIANT_ID,
      quantity: 1,
      referenceType: 'ORDER',
      referenceId: `order-${i}`,
      performedBy: ADMIN_ID,
    })
  );

  const results = await Promise.allSettled(calls);

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 5, 'exactly 5 of 10 reservations succeed');
  assert.equal(rejected.length, 5, 'the remaining 5 are rejected');
  for (const result of rejected) {
    assert.equal(result.reason.statusCode, 409);
    assert.equal(result.reason.code, ERROR_CODES.INSUFFICIENT_AVAILABLE_STOCK);
  }

  const inventory = inventoryRepository.docs[0];
  assert.equal(inventory.reservedQuantity, 5);
  assert.equal(availableOnline(inventory), 0, 'availability never goes negative');
  assert.ok(inventory.onlineQuantity >= inventory.reservedQuantity, 'reserved never exceeds online');
});

test('concurrent release+consume of one reservation applies exactly one transition, never double-mutates', async () => {
  const { service, inventoryRepository, movementRepository, reservationRepository } = makeService({
    onlineQuantity: 10,
  });
  const reservation = await service.createReservation({
    productVariantId: VARIANT_ID,
    quantity: 3,
    referenceType: 'ORDER',
    referenceId: 'order-1',
    performedBy: ADMIN_ID,
  });

  const [release, consume] = await Promise.allSettled([
    service.releaseReservation({ reservationId: reservation.id, performedBy: ADMIN_ID }),
    service.consumeReservation({ reservationId: reservation.id, performedBy: ADMIN_ID }),
  ]);

  const winners = [release, consume].filter((r) => r.status === 'fulfilled');
  assert.equal(winners.length, 1, 'exactly one of release/consume wins the race');

  const final = reservationRepository.docs[0];
  const inventory = inventoryRepository.docs[0];
  assert.ok(
    final.status === RESERVATION_STATUSES.RELEASED || final.status === RESERVATION_STATUSES.CONSUMED,
    'reservation settles in a terminal state'
  );
  assert.equal(inventory.reservedQuantity, 0, 'reserved quantity is fully resolved');
  const resolutionMovements = movementRepository.docs.filter((m) =>
    [MOVEMENT_TYPES.RESERVATION_RELEASE, MOVEMENT_TYPES.RESERVATION_CONSUME].includes(m.type)
  );
  assert.equal(resolutionMovements.length, 1, 'exactly one resolution movement is written');

  if (final.status === RESERVATION_STATUSES.RELEASED) {
    assert.equal(inventory.onlineQuantity, 10, 'release leaves physical stock untouched');
  } else {
    assert.equal(inventory.onlineQuantity, 7, 'consume physically removes the reserved quantity');
  }
});

test('concurrent double release is safe: one wins, the loser cannot double-release', async () => {
  const { service, inventoryRepository, movementRepository, reservationRepository } = makeService({
    onlineQuantity: 10,
  });
  const reservation = await service.createReservation({
    productVariantId: VARIANT_ID,
    quantity: 3,
    referenceType: 'ORDER',
    referenceId: 'order-1',
    performedBy: ADMIN_ID,
  });

  const [first, second] = await Promise.allSettled([
    service.releaseReservation({ reservationId: reservation.id, performedBy: ADMIN_ID }),
    service.releaseReservation({ reservationId: reservation.id, performedBy: ADMIN_ID }),
  ]);

  assert.equal(first.status, 'fulfilled', 'first release wins');
  assert.equal(first.value.reservation.status, RESERVATION_STATUSES.RELEASED);
  assert.equal(second.status, 'rejected', 'loser of a concurrent race is rejected safely');
  assert.equal(second.reason.statusCode, 409);

  assert.equal(reservationRepository.docs[0].status, RESERVATION_STATUSES.RELEASED);
  assert.equal(inventoryRepository.docs[0].reservedQuantity, 0);
  const releaseMovements = movementRepository.docs.filter(
    (m) => m.type === MOVEMENT_TYPES.RESERVATION_RELEASE
  );
  assert.equal(releaseMovements.length, 1, 'stock returned to availability exactly once');
});

test('a burst of stock-out operations can never drive availability negative', async () => {
  const { InventoryService } = require('../../../src/modules/inventory/inventory.service');
  const inventoryRepository = createMemoryInventoryRepository([
    {
      _id: INVENTORY_ID,
      productVariantId: VARIANT_ID,
      onlineQuantity: 5,
      offlineQuantity: 0,
      reservedQuantity: 0,
      lowStockThreshold: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);
  const movementRepository = createMemoryMovementRepository();
  const service = new InventoryService({
    inventoryRepository,
    movementRepository,
    variantRepository: createMemoryVariantRepository([{ _id: VARIANT_ID, isActive: true }]),
    runTransaction: noopTransaction,
  });

  const calls = Array.from({ length: 8 }, () =>
    service.removeStock({
      productVariantId: VARIANT_ID,
      location: 'ONLINE',
      quantity: 1,
      performedBy: ADMIN_ID,
    })
  );

  const results = await Promise.allSettled(calls);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 5);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 3);

  const inventory = inventoryRepository.docs[0];
  assert.equal(inventory.onlineQuantity, 0);
  assert.ok(inventory.onlineQuantity >= 0, 'stock never goes negative');
});
