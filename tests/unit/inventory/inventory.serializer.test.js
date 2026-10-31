'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  availableOnlineQuantity,
  totalPhysicalQuantity,
  isLowStock,
  isOutOfStock,
  serializeInventory,
  serializeUninitializedProduct,
  serializeInventoryMovement,
  serializeReservation,
} = require('../../../src/modules/inventory/inventory.serializer');

const INVENTORY_ID = '507f1f77bcf86cd799439001';
const PRODUCT_ID = '507f1f77bcf86cd799439010';
const VARIANT_ID = '507f1f77bcf86cd799439031';
const USER_ID = 'usr-admin-1';

function inventoryDoc(overrides = {}) {
  return {
    _id: INVENTORY_ID,
    productId: PRODUCT_ID,
    productVariantId: VARIANT_ID,
    onlineQuantity: 20,
    offlineQuantity: 5,
    reservedQuantity: 3,
    lowStockThreshold: 2,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

test('derives availableOnlineQuantity as online minus reserved', () => {
  assert.equal(availableOnlineQuantity(inventoryDoc()), 17);
  assert.equal(availableOnlineQuantity(inventoryDoc({ onlineQuantity: 10, reservedQuantity: 10 })), 0);
});

test('derives totalPhysicalQuantity as online plus offline', () => {
  assert.equal(totalPhysicalQuantity(inventoryDoc()), 25);
});

test('flags low stock and out of stock from available (not physical) quantity', () => {
  assert.equal(isLowStock(inventoryDoc({ onlineQuantity: 3, reservedQuantity: 2, lowStockThreshold: 2 })), true);
  assert.equal(isLowStock(inventoryDoc({ onlineQuantity: 100, reservedQuantity: 0, lowStockThreshold: 2 })), false);
  assert.equal(isOutOfStock(inventoryDoc({ onlineQuantity: 3, reservedQuantity: 3 })), true);
  assert.equal(isOutOfStock(inventoryDoc({ onlineQuantity: 3, reservedQuantity: 2 })), false);
});

test('serializeInventory exposes only the public inventory fields', () => {
  const serialized = serializeInventory(inventoryDoc());
  assert.deepEqual(Object.keys(serialized).sort(), [
    'availableOnlineQuantity',
    'createdAt',
    'id',
    'isInitialized',
    'isLowStock',
    'isOutOfStock',
    'lowStockThreshold',
    'offlineQuantity',
    'onlineQuantity',
    'outletId',
    'productId',
    'productVariantId',
    'reservedQuantity',
    'totalPhysicalQuantity',
    'updatedAt',
  ]);
  assert.equal(serialized.id, INVENTORY_ID);
  assert.equal(serialized.productId, PRODUCT_ID);
  assert.equal(serialized.productVariantId, VARIANT_ID);
  assert.equal(serialized.isInitialized, true);
  assert.equal(serialized.onlineQuantity, 20);
  assert.equal(serialized.availableOnlineQuantity, 17);
  assert.equal(serialized.totalPhysicalQuantity, 25);
  assert.equal(serialized.isLowStock, false);
  assert.equal(serialized.isOutOfStock, false);
  assert.equal(serialized.createdAt, '2026-01-01T00:00:00.000Z');
  assert.equal(serialized._id, undefined);
  assert.equal(serialized.__v, undefined);
});

test('serializeUninitializedProduct is a zeroed Not-initialized row, never a record', () => {
  const serialized = serializeUninitializedProduct({
    _id: PRODUCT_ID,
    name: 'Simple Hijab',
    isActive: true,
  });
  assert.equal(serialized.id, null, 'no inventory record exists');
  assert.equal(serialized.productId, PRODUCT_ID);
  assert.equal(serialized.productVariantId, null);
  assert.equal(serialized.productName, 'Simple Hijab');
  assert.equal(serialized.isInitialized, false);
  assert.equal(serialized.onlineQuantity, 0);
  assert.equal(serialized.availableOnlineQuantity, 0);
  assert.equal(serialized.totalPhysicalQuantity, 0);
  assert.equal(serialized.isOutOfStock, true);
  assert.equal(serialized.createdAt, null);
  assert.equal(serialized.updatedAt, null);
});

test('serializeInventoryMovement exposes only ledger fields', () => {
  const movement = {
    _id: 'mv-1',
    inventoryId: INVENTORY_ID,
    productVariantId: VARIANT_ID,
    type: 'TRANSFER',
    quantity: 5,
    fromLocation: 'ONLINE',
    toLocation: 'OFFLINE',
    reason: 'rebalance',
    referenceType: null,
    referenceId: null,
    performedBy: USER_ID,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    metadata: { injected: true },
  };
  const serialized = serializeInventoryMovement(movement);
  assert.equal(serialized.type, 'TRANSFER');
  assert.equal(serialized.fromLocation, 'ONLINE');
  assert.equal(serialized.toLocation, 'OFFLINE');
  assert.equal(serialized.performedBy, USER_ID);
  assert.equal(serialized.metadata, undefined, 'metadata is internal and not serialized');
  assert.equal(serialized._id, undefined);
});

test('serializeReservation exposes only reservation fields', () => {
  const reservation = {
    _id: 'res-1',
    productVariantId: VARIANT_ID,
    quantity: 3,
    status: 'CONSUMED',
    expiresAt: null,
    referenceType: 'ORDER',
    referenceId: 'order-1',
    metadata: { internal: 'x' },
    createdBy: USER_ID,
    resolvedAt: new Date('2026-01-01T00:00:00.000Z'),
    resolvedBy: USER_ID,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
  const serialized = serializeReservation(reservation);
  assert.equal(serialized.status, 'CONSUMED');
  assert.equal(serialized.referenceId, 'order-1');
  assert.equal(serialized.resolvedBy, USER_ID);
  assert.equal(serialized._id, undefined);
  assert.equal(serialized.__v, undefined);
});

test('serializes a Simple Product subject with a nullable productVariantId', () => {
  const serialized = serializeInventory(
    inventoryDoc({ productId: PRODUCT_ID, productVariantId: null })
  );
  assert.equal(serialized.productId, PRODUCT_ID);
  assert.equal(serialized.productVariantId, null, 'simple products serialize a null variant id');
  assert.equal(serialized.outletId, null);
});

test('serializeInventory tolerates zero/undefined quantities (out-of-stock)', () => {
  const serialized = serializeInventory({
    _id: INVENTORY_ID,
    productVariantId: VARIANT_ID,
    onlineQuantity: 0,
    offlineQuantity: 0,
    reservedQuantity: 0,
    lowStockThreshold: 0,
    createdAt: null,
    updatedAt: null,
  });
  assert.equal(serialized.availableOnlineQuantity, 0);
  assert.equal(serialized.isLowStock, true);
  assert.equal(serialized.isOutOfStock, true);
  assert.equal(serialized.createdAt, null);
});
