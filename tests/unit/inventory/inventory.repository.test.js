'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createInventoryRepository,
  availableOnlineExpr,
} = require('../../../src/modules/inventory/inventory.repository');

/**
 * Exercises the REAL repository (not the memory stub) against a mock model,
 * asserting the exact MongoDB filters/updates that reach the database. This
 * is what guarantees:
 *  - every stock mutation is an ATOMIC CONDITIONAL update (the invariant is
 *    part of the filter, never a read-then-write),
 *  - the ONLINE/OFFLINE locations are mapped to onlineQuantity/offlineQuantity
 *    so a location string can never name an arbitrary `$inc` field.
 */

const VARIANT_ID = '507f1f77bcf86cd799439031';

const CENTRAL_POOL_FILTER = { outletId: null };

function mockModel() {
  const calls = [];
  const model = {
    calls,
    findOneAndUpdate: async (filter, update, options) => {
      calls.push({ filter, update, options });
      return { _id: 'inv-1' };
    },
    findOne: async (filter) => {
      calls.push({ kind: 'findOne', filter });
      return null;
    },
    find: async (filter, projection, options) => {
      calls.push({ kind: 'find', filter, options });
      return [];
    },
  };
  return model;
}

test('availableOnlineExpr guards on the DERIVED online - reserved quantity', () => {
  assert.deepEqual(availableOnlineExpr(5), {
    $expr: { $gte: [{ $subtract: ['$onlineQuantity', '$reservedQuantity'] }, 5] },
  });
});

test('addToLocation maps ONLINE/OFFLINE to onlineQuantity/offlineQuantity', async () => {
  const model = mockModel();
  const repo = createInventoryRepository(model);
  await repo.addToLocation(VARIANT_ID, 'ONLINE', 5);
  await repo.addToLocation(VARIANT_ID, 'OFFLINE', 3);
  assert.deepEqual(model.calls[0].update, { $inc: { onlineQuantity: 5 } });
  assert.deepEqual(model.calls[1].update, { $inc: { offlineQuantity: 3 } });
  assert.deepEqual(model.calls[0].filter, { productVariantId: VARIANT_ID, ...CENTRAL_POOL_FILTER });
});

test('removeFromLocation ONLINE carries the $expr availability guard, OFFLINE a physical guard', async () => {
  const model = mockModel();
  const repo = createInventoryRepository(model);
  await repo.removeFromLocation(VARIANT_ID, 'ONLINE', 2);
  await repo.removeFromLocation(VARIANT_ID, 'OFFLINE', 2);
  assert.deepEqual(model.calls[0].filter, { productVariantId: VARIANT_ID, ...CENTRAL_POOL_FILTER, ...availableOnlineExpr(2) });
  assert.deepEqual(model.calls[0].update, { $inc: { onlineQuantity: -2 } });
  assert.deepEqual(model.calls[1].filter, { productVariantId: VARIANT_ID, ...CENTRAL_POOL_FILTER, offlineQuantity: { $gte: 2 } });
  assert.deepEqual(model.calls[1].update, { $inc: { offlineQuantity: -2 } });
});

test('transferBetweenLocations maps both fields and guards the source', async () => {
  const model = mockModel();
  const repo = createInventoryRepository(model);
  await repo.transferBetweenLocations(VARIANT_ID, 'ONLINE', 'OFFLINE', 4);
  assert.deepEqual(model.calls[0].update, { $inc: { onlineQuantity: -4, offlineQuantity: 4 } });
  assert.deepEqual(model.calls[0].filter, { productVariantId: VARIANT_ID, ...CENTRAL_POOL_FILTER, ...availableOnlineExpr(4) });
});

test('adjustLocation maps the signed delta to the right field and guards decreases', async () => {
  const model = mockModel();
  const repo = createInventoryRepository(model);
  await repo.adjustLocation(VARIANT_ID, 'ONLINE', 5);
  await repo.adjustLocation(VARIANT_ID, 'OFFLINE', -2);
  assert.deepEqual(model.calls[0].update, { $inc: { onlineQuantity: 5 } });
  assert.deepEqual(model.calls[0].filter, { productVariantId: VARIANT_ID, ...CENTRAL_POOL_FILTER }, 'increase is unconditional');
  assert.deepEqual(model.calls[1].update, { $inc: { offlineQuantity: -2 } });
  assert.deepEqual(model.calls[1].filter, { productVariantId: VARIANT_ID, ...CENTRAL_POOL_FILTER, offlineQuantity: { $gte: 2 } });
});

test('reservation mutations are atomic conditional updates on reservedQuantity', async () => {
  const model = mockModel();
  const repo = createInventoryRepository(model);
  await repo.reserveOnline(VARIANT_ID, 3);
  await repo.releaseReserved(VARIANT_ID, 2);
  await repo.consumeReserved(VARIANT_ID, 1);

  assert.deepEqual(model.calls[0].filter, { productVariantId: VARIANT_ID, ...CENTRAL_POOL_FILTER, ...availableOnlineExpr(3) });
  assert.deepEqual(model.calls[0].update, { $inc: { reservedQuantity: 3 } });

  assert.deepEqual(model.calls[1].filter, { productVariantId: VARIANT_ID, ...CENTRAL_POOL_FILTER, reservedQuantity: { $gte: 2 } });
  assert.deepEqual(model.calls[1].update, { $inc: { reservedQuantity: -2 } });

  assert.deepEqual(model.calls[2].filter, { productVariantId: VARIANT_ID, ...CENTRAL_POOL_FILTER, reservedQuantity: { $gte: 1 } });
  assert.deepEqual(model.calls[2].update, { $inc: { reservedQuantity: -1, onlineQuantity: -1 } });
});

test('every mutation passes the session option through to MongoDB', async () => {
  const model = mockModel();
  const repo = createInventoryRepository(model);
  const session = { id: 'session-test' };
  await repo.addToLocation(VARIANT_ID, 'ONLINE', 5, { session });
  await repo.reserveOnline(VARIANT_ID, 1, { session });
  for (const call of model.calls) {
    assert.equal(call.options.session, session, 'transaction session forwarded');
    assert.equal(call.options.new, true);
    assert.equal(call.options.runValidators, true);
  }
});

test('findBySubject matches the FULL subject — productId + productVariantId + outletId', async () => {
  const model = mockModel();
  const repo = createInventoryRepository(model);
  await repo.findBySubject({ productId: 'prod-a', productVariantId: VARIANT_ID, outletId: null });
  await repo.findBySubject({ productId: 'prod-b', productVariantId: null, outletId: 'outlet-1' });
  assert.deepEqual(model.calls[0].filter, {
    productId: 'prod-a',
    productVariantId: VARIANT_ID,
    outletId: null,
  }, 'variant subject matches productId + productVariantId + outletId');
  assert.deepEqual(model.calls[1].filter, {
    productId: 'prod-b',
    productVariantId: null,
    outletId: 'outlet-1',
  }, 'simple-product subject matches productId + productVariantId null + outletId');
});

test('findLowStock computes availability with $expr, scoped to the central pool', async () => {
  const model = mockModel();
  const repo = createInventoryRepository(model);
  await repo.findLowStock({ sort: { createdAt: -1 } });
  assert.equal(model.calls[0].kind, 'find');
  assert.deepEqual(model.calls[0].filter, {
    outletId: null,
    $expr: {
      $lte: [{ $subtract: ['$onlineQuantity', '$reservedQuantity'] }, '$lowStockThreshold'],
    },
  });
});
