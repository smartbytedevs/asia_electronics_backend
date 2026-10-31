'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateInitializeInput,
  validateStockInInput,
  validateStockOutInput,
  validateTransferInput,
  validateAdjustInput,
  validateReservationInput,
} = require('../../../src/modules/inventory/inventory.validation');
const { ERROR_CODES } = require('../../../src/constants');

const PRODUCT_ID = '507f1f77bcf86cd799439010';
const VARIANT_ID = '507f1f77bcf86cd799439031';

function expectError(fn, code) {
  return assert.throws(fn, (err) => {
    assert.equal(err.statusCode, 400, 'HTTP 400');
    assert.equal(err.code, code, `error code ${code}`);
    return true;
  });
}

test('INITIALIZE accepts a minimal valid body', () => {
  const { value } = validateInitializeInput({ productVariantId: VARIANT_ID });
  assert.equal(value.productVariantId, VARIANT_ID);
  assert.equal(value.onlineQuantity, undefined);
  assert.equal(value.offlineQuantity, undefined);
  assert.equal(value.lowStockThreshold, undefined);
});

test('INITIALIZE accepts a Simple Product subject (productId with productVariantId: null)', () => {
  const { value } = validateInitializeInput({
    productId: PRODUCT_ID,
    productVariantId: null,
    onlineQuantity: 50,
  });
  assert.equal(value.productId, PRODUCT_ID);
  assert.equal(value.productVariantId, null);
  assert.equal(value.onlineQuantity, 50);
});

test('INITIALIZE accepts a ProductVariant subject (productId + productVariantId)', () => {
  const { value } = validateInitializeInput({
    productId: PRODUCT_ID,
    productVariantId: VARIANT_ID,
    onlineQuantity: 50,
  });
  assert.equal(value.productId, PRODUCT_ID);
  assert.equal(value.productVariantId, VARIANT_ID);
  assert.equal(value.onlineQuantity, 50);
});

test('INITIALIZE accepts explicit quantities', () => {
  const { value } = validateInitializeInput({
    productVariantId: VARIANT_ID,
    onlineQuantity: 20,
    offlineQuantity: 5,
    lowStockThreshold: 2,
  });
  assert.equal(value.onlineQuantity, 20);
  assert.equal(value.offlineQuantity, 5);
  assert.equal(value.lowStockThreshold, 2);
});

test('INITIALIZE rejects a non-null malformed productVariantId but allows null', () => {
  expectError(
    () => validateInitializeInput({ productId: PRODUCT_ID, productVariantId: 'not-an-object-id' }),
    ERROR_CODES.INVALID_INVENTORY_OPERATION
  );
  const { value } = validateInitializeInput({
    productId: PRODUCT_ID,
    productVariantId: null,
  });
  assert.equal(value.productVariantId, null);
});

test('INITIALIZE rejects negative and fractional quantities', () => {
  expectError(
    () => validateInitializeInput({ productVariantId: VARIANT_ID, onlineQuantity: -1 }),
    ERROR_CODES.INVALID_STOCK_QUANTITY
  );
  expectError(
    () => validateInitializeInput({ productVariantId: VARIANT_ID, offlineQuantity: 2.5 }),
    ERROR_CODES.INVALID_STOCK_QUANTITY
  );
});

test('rejects unknown fields on every command', () => {
  expectError(
    () => validateInitializeInput({ productVariantId: VARIANT_ID, role: 'ADMIN' }),
    ERROR_CODES.INVALID_INVENTORY_OPERATION
  );
  expectError(
    () => validateStockInInput({ productVariantId: VARIANT_ID, location: 'ONLINE', quantity: 5, performedBy: 'hack' }),
    ERROR_CODES.INVALID_INVENTORY_OPERATION
  );
  expectError(
    () => validateStockInInput({ productVariantId: VARIANT_ID, location: 'ONLINE', quantity: 5, _id: 'x' }),
    ERROR_CODES.INVALID_INVENTORY_OPERATION
  );
});

test('rejects MongoDB update operators at the top level', () => {
  expectError(
    () => validateStockInInput({ productVariantId: VARIANT_ID, $set: { quantity: 99 } }),
    ERROR_CODES.INVALID_INVENTORY_OPERATION
  );
  expectError(
    () => validateReservationInput({ productVariantId: VARIANT_ID, quantity: 1, referenceType: 'ORDER', referenceId: 'x', $inc: { quantity: 1 } }),
    ERROR_CODES.INVALID_INVENTORY_OPERATION
  );
});

test('STOCK_IN/STOCK_OUT require a valid location and positive integer quantity', () => {
  expectError(
    () => validateStockInInput({ productVariantId: VARIANT_ID, location: 'WAREHOUSE', quantity: 5 }),
    ERROR_CODES.INVALID_INVENTORY_OPERATION
  );
  expectError(
    () => validateStockInInput({ productVariantId: VARIANT_ID, location: 'ONLINE', quantity: 0 }),
    ERROR_CODES.INVALID_STOCK_QUANTITY
  );
  expectError(
    () => validateStockOutInput({ productVariantId: VARIANT_ID, location: 'ONLINE', quantity: '10' }),
    ERROR_CODES.INVALID_STOCK_QUANTITY
  );
});

test('TRANSFER accepts both directions and trims a reason', () => {
  const onlineToOffline = validateTransferInput({
    productVariantId: VARIANT_ID,
    fromLocation: 'ONLINE',
    toLocation: 'OFFLINE',
    quantity: 3,
    reason: '  rebalance  ',
  });
  assert.equal(onlineToOffline.value.fromLocation, 'ONLINE');
  assert.equal(onlineToOffline.value.toLocation, 'OFFLINE');
  assert.equal(onlineToOffline.value.reason, 'rebalance');

  const offlineToOnline = validateTransferInput({
    productVariantId: VARIANT_ID,
    fromLocation: 'OFFLINE',
    toLocation: 'ONLINE',
    quantity: 4,
  });
  assert.equal(offlineToOnline.value.reason, null);
});

test('TRANSFER rejects equal source and destination', () => {
  expectError(
    () => validateTransferInput({
      productVariantId: VARIANT_ID,
      fromLocation: 'ONLINE',
      toLocation: 'ONLINE',
      quantity: 3,
    }),
    ERROR_CODES.INVALID_STOCK_TRANSFER
  );
});

test('ADJUST accepts a signed non-zero integer quantity', () => {
  assert.equal(validateAdjustInput({ productVariantId: VARIANT_ID, location: 'ONLINE', quantity: 5 }).value.quantity, 5);
  assert.equal(validateAdjustInput({ productVariantId: VARIANT_ID, location: 'OFFLINE', quantity: -2 }).value.quantity, -2);
  expectError(
    () => validateAdjustInput({ productVariantId: VARIANT_ID, location: 'ONLINE', quantity: 0 }),
    ERROR_CODES.INVALID_STOCK_QUANTITY
  );
});

test('RESERVE validates reference fields and future-only expiresAt', () => {
  expectError(
    () => validateReservationInput({ productVariantId: VARIANT_ID, quantity: 1 }),
    ERROR_CODES.INVALID_INVENTORY_OPERATION
  );
  expectError(
    () => validateReservationInput({ productVariantId: VARIANT_ID, quantity: 1, referenceType: 'ORDER', referenceId: ' ' }),
    ERROR_CODES.INVALID_INVENTORY_OPERATION
  );
  const future = new Date(Date.now() + 60_000);
  const { value } = validateReservationInput({
    productVariantId: VARIANT_ID,
    quantity: 1,
    referenceType: 'ORDER',
    referenceId: 'order-1',
    expiresAt: future.toISOString(),
  });
  assert.equal(value.referenceType, 'ORDER');
  assert.equal(value.referenceId, 'order-1');
  assert.equal(value.expiresAt.getTime(), future.getTime());

  expectError(
    () => validateReservationInput({
      productVariantId: VARIANT_ID,
      quantity: 1,
      referenceType: 'ORDER',
      referenceId: 'order-1',
      expiresAt: new Date(Date.now() - 1000),
    }),
    ERROR_CODES.RESERVATION_EXPIRED
  );
});

test('RESERVE rejects metadata with $ operators', () => {
  expectError(
    () => validateReservationInput({
      productVariantId: VARIANT_ID,
      quantity: 1,
      referenceType: 'ORDER',
      referenceId: 'order-1',
      metadata: { $where: 'sleep(1000)' },
    }),
    ERROR_CODES.INVALID_INVENTORY_OPERATION
  );
});
