'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateStockTransferInput,
} = require('../../../src/modules/stockTransfers/stockTransfer.validation');
const { ERROR_CODES } = require('../../../src/constants');

const SOURCE = '507f1f77bcf86cd799439041';
const DEST = '507f1f77bcf86cd799439042';
const VARIANT = '507f1f77bcf86cd799439031';

function validBody(overrides = {}) {
  return {
    sourceOutletId: SOURCE,
    destinationOutletId: DEST,
    productVariantId: VARIANT,
    quantity: 5,
    ...overrides,
  };
}

function expectInvalid(promise, code = ERROR_CODES.INVALID_STOCK_TRANSFER) {
  return assert.rejects(promise, (err) => {
    assert.equal(err.statusCode, 400);
    assert.equal(err.code, code);
    return true;
  });
}

test('accepts a valid transfer body and normalizes reason', () => {
  const { value } = validateStockTransferInput(validBody({ reason: '  replenish  ' }));
  assert.equal(value.sourceOutletId, SOURCE);
  assert.equal(value.destinationOutletId, DEST);
  assert.equal(value.productVariantId, VARIANT);
  assert.equal(value.quantity, 5);
  assert.equal(value.reason, 'replenish');
});

test('rejects a client-supplied createdBy', () => {
  return expectInvalid(Promise.resolve().then(() => validateStockTransferInput(validBody({ createdBy: 'usr-admin-1' }))));
});

test('rejects a client-supplied status and completedAt', () => {
  return expectInvalid(Promise.resolve().then(() => validateStockTransferInput(validBody({ status: 'COMPLETED' }))));
});

test('rejects a client-supplied role and Mongo operators', () => {
  return expectInvalid(Promise.resolve().then(() => validateStockTransferInput(validBody({ role: 'ADMIN' }))));
});

test('rejects Mongo update operators such as $set', () => {
  return expectInvalid(Promise.resolve().then(() => validateStockTransferInput({ $set: validBody() })));
});

test('rejects unknown/immutable fields', () => {
  return expectInvalid(Promise.resolve().then(() => validateStockTransferInput(validBody({ _id: 'x', completedAt: 'y' }))));
});

test('rejects same source and destination outlet', () => {
  return expectInvalid(Promise.resolve().then(() => validateStockTransferInput(validBody({ destinationOutletId: SOURCE }))));
});

test('rejects missing ids', () => {
  for (const body of [
    { destinationOutletId: DEST, productVariantId: VARIANT, quantity: 5 },
    { sourceOutletId: SOURCE, productVariantId: VARIANT, quantity: 5 },
    { sourceOutletId: SOURCE, destinationOutletId: DEST, quantity: 5 },
  ]) {
    expectInvalid(Promise.resolve().then(() => validateStockTransferInput(body)));
  }
});

test('rejects malformed ids', () => {
  return expectInvalid(Promise.resolve().then(() => validateStockTransferInput(validBody({ sourceOutletId: 'not-an-id' }))));
});

test('rejects invalid quantities', () => {
  for (const quantity of [0, -1, 1.5, '5', null]) {
    expectInvalid(Promise.resolve().then(() => validateStockTransferInput(validBody({ quantity }))));
  }
});

test('rejects a non-object body', () => {
  for (const body of [null, 'x', [], 42]) {
    expectInvalid(Promise.resolve().then(() => validateStockTransferInput(body)));
  }
});
