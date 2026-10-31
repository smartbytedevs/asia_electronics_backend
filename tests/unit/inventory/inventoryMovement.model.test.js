'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const InventoryMovement = require('../../../src/modules/inventory/inventoryMovement.model');
const { MOVEMENT_TYPE_VALUES } = require('../../../src/modules/inventory/inventory.constants');

const INVENTORY_ID = '507f1f77bcf86cd799439001';
const PRODUCT_ID = '507f1f77bcf86cd799439010';
const VARIANT_ID = '507f1f77bcf86cd799439031';
const USER_ID = '507f1f77bcf86cd799439090';

function validMovementData(overrides = {}) {
  return {
    inventoryId: INVENTORY_ID,
    productVariantId: VARIANT_ID,
    type: 'STOCK_IN',
    quantity: 10,
    fromLocation: null,
    toLocation: 'ONLINE',
    reason: 'restock',
    referenceType: null,
    referenceId: null,
    performedBy: USER_ID,
    metadata: {},
    ...overrides,
  };
}

test('creates a valid movement record', async () => {
  const movement = new InventoryMovement(validMovementData());
  await movement.validate();
  assert.equal(movement.type, 'STOCK_IN');
  assert.equal(movement.quantity, 10);
  assert.equal(movement.toLocation, 'ONLINE');
  assert.equal(String(movement.performedBy), USER_ID);
});

test('requires inventoryId, type, quantity, and performedBy (subject ids are optional)', async () => {
  const movement = new InventoryMovement({});
  await assert.rejects(movement.validate(), (err) => {
    assert.ok(err.errors.inventoryId, 'inventoryId validation error');
    assert.ok(err.errors.type, 'type validation error');
    assert.ok(err.errors.quantity, 'quantity validation error');
    assert.ok(err.errors.performedBy, 'performedBy validation error');
    assert.equal(err.errors.productVariantId, undefined, 'productVariantId is now optional');
    assert.equal(err.errors.productId, undefined, 'productId is now optional');
    return true;
  });
});

test('accepts a product-scoped movement (productId set, productVariantId null)', async () => {
  const movement = new InventoryMovement(
    validMovementData({ productVariantId: null, productId: PRODUCT_ID })
  );
  await movement.validate();
  assert.equal(String(movement.productId), PRODUCT_ID);
  assert.equal(movement.productVariantId, null);
});

test('accepts a variant-scoped movement with productId resolved', async () => {
  const movement = new InventoryMovement(
    validMovementData({ productId: PRODUCT_ID, productVariantId: VARIANT_ID })
  );
  await movement.validate();
  assert.equal(String(movement.productId), PRODUCT_ID);
  assert.equal(String(movement.productVariantId), VARIANT_ID);
});

test('restricts type to the movement enum', async () => {
  const movement = new InventoryMovement(validMovementData({ type: 'FABRICATE' }));
  await assert.rejects(movement.validate(), (err) => {
    assert.ok(err.errors.type, 'type enum validation error');
    return true;
  });
});

test('accepts every supported movement type', async () => {
  for (const type of MOVEMENT_TYPE_VALUES) {
    const movement = new InventoryMovement(validMovementData({ type }));
    await movement.validate();
  }
});

test('rejects zero or negative and non-integer quantities', async () => {
  const zero = new InventoryMovement(validMovementData({ quantity: 0 }));
  await assert.rejects(zero.validate(), (err) => {
    assert.ok(err.errors.quantity, 'zero quantity rejected');
    return true;
  });
  const negative = new InventoryMovement(validMovementData({ quantity: -1 }));
  await assert.rejects(negative.validate(), (err) => {
    assert.ok(err.errors.quantity, 'negative quantity rejected');
    return true;
  });
  const fractional = new InventoryMovement(validMovementData({ quantity: 2.5 }));
  await assert.rejects(fractional.validate(), (err) => {
    assert.ok(err.errors.quantity, 'fractional quantity rejected');
    return true;
  });
});

test('restricts locations to ONLINE or OFFLINE', async () => {
  const movement = new InventoryMovement(validMovementData({ fromLocation: 'WAREHOUSE' }));
  await assert.rejects(movement.validate(), (err) => {
    assert.ok(err.errors.fromLocation, 'fromLocation enum validation error');
    return true;
  });
});

test('declares the ledger indexes', () => {
  const indexes = InventoryMovement.schema.indexes();
  const productVariantIndex = indexes.find(([key]) => key.productVariantId === 1);
  const inventoryIndex = indexes.find(([key]) => key.inventoryId === 1);
  const typeIndex = indexes.find(([key]) => key.type === 1);
  assert.ok(productVariantIndex, 'productVariantId index exists');
  assert.ok(inventoryIndex, 'inventoryId index exists');
  assert.ok(typeIndex, 'type index exists');
});
