'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateAddItemInput,
  validateUpdateItemInput,
  assertObjectId,
} = require('../../../src/modules/cart/cart.validation');
const { ERROR_CODES } = require('../../../src/constants');
const { CART_LIMITS } = require('../../../src/modules/cart/cart.constants');

test('add-item input validates variant id and quantity', () => {
  const { value } = validateAddItemInput({
    productVariantId: '507f1f77bcf86cd799439011',
    quantity: 2,
  });
  assert.equal(value.productVariantId, '507f1f77bcf86cd799439011');
  assert.equal(value.quantity, 2);
});

test('quantity must be a positive integer within the limit', () => {
  for (const quantity of [0, -1, 1.5, '2', null, undefined]) {
    assert.throws(
      () => validateAddItemInput({ productVariantId: '507f1f77bcf86cd799439011', quantity }),
      (err) => err.code === ERROR_CODES.INVALID_CART_ITEM,
      `quantity=${quantity} must be rejected`
    );
  }
  assert.throws(
    () =>
      validateAddItemInput({
        productVariantId: '507f1f77bcf86cd799439011',
        quantity: CART_LIMITS.QUANTITY_MAX + 1,
      }),
    (err) => err.code === ERROR_CODES.INVALID_CART_ITEM
  );
});

test('accepts a product-only (simple product) line and requires at least one subject', () => {
  const { value } = validateAddItemInput({
    productId: '507f1f77bcf86cd799439011',
    quantity: 2,
  });
  assert.equal(value.productId, '507f1f77bcf86cd799439011');
  assert.equal(value.productVariantId, null);
  assert.equal(value.quantity, 2);

  for (const body of [
    { quantity: 1 },
    { productId: null, productVariantId: null, quantity: 1 },
    { productId: '', quantity: 1 },
  ]) {
    assert.throws(
      () => validateAddItemInput(body),
      (err) => err.code === ERROR_CODES.INVALID_CART_ITEM,
      `body=${JSON.stringify(body)} must be rejected`
    );
  }
});

test('unknown fields, client money, and operator injection are rejected', () => {
  for (const extra of [
    { quantity: 1, customerId: '507f1f77bcf86cd799439011' },
    { quantity: 1, priceMinorUnits: 5000 },
    { quantity: 1, discountMinorUnits: 100 },
    { quantity: 1, performedBy: 'x' },
    { quantity: 1, $inc: { quantity: 1 } },
  ]) {
    assert.throws(
      () => validateAddItemInput({ productVariantId: '507f1f77bcf86cd799439011', ...extra }),
      (err) => err.code === ERROR_CODES.INVALID_CART_ITEM,
      `extra=${JSON.stringify(Object.keys(extra))} must be rejected`
    );
  }
});

test('update-item input only allows quantity', () => {
  const { value } = validateUpdateItemInput({ quantity: 3 });
  assert.equal(value.quantity, 3);
  assert.throws(
    () => validateUpdateItemInput({ quantity: 1, productVariantId: '507f1f77bcf86cd799439011' }),
    (err) => err.code === ERROR_CODES.INVALID_CART_ITEM
  );
});

test('assertObjectId enforces the 24-hex shape', () => {
  assert.equal(assertObjectId('507f1f77bcf86cd799439011', 'id'), '507f1f77bcf86cd799439011');
  assert.throws(() => assertObjectId('nope', 'id'), (err) => err.code === ERROR_CODES.INVALID_CART_ITEM);
});

test('selectedSize is optional, trimmed, and capped at the max length', () => {
  const none = validateAddItemInput({
    productVariantId: '507f1f77bcf86cd799439011',
    quantity: 1,
  });
  assert.equal(none.value.selectedSize, null, 'omitted selectedSize is normalized to null');

  const explicit = validateAddItemInput({
    productVariantId: '507f1f77bcf86cd799439011',
    quantity: 1,
    selectedSize: null,
  });
  assert.equal(explicit.value.selectedSize, null);

  const sized = validateAddItemInput({
    productVariantId: '507f1f77bcf86cd799439011',
    quantity: 1,
    selectedSize: '  S  ',
  });
  assert.equal(sized.value.selectedSize, 'S', 'selectedSize is trimmed');
});

test('invalid selectedSize values are rejected', () => {
  for (const selectedSize of [42, true, {}, [], '']) {
    assert.throws(
      () =>
        validateAddItemInput({
          productVariantId: '507f1f77bcf86cd799439011',
          quantity: 1,
          selectedSize,
        }),
      (err) => err.code === ERROR_CODES.INVALID_CART_ITEM,
      `selectedSize=${JSON.stringify(selectedSize)} must be rejected`
    );
  }
  assert.throws(
    () =>
      validateAddItemInput({
        productVariantId: '507f1f77bcf86cd799439011',
        quantity: 1,
        selectedSize: 'x'.repeat(CART_LIMITS.SELECTED_SIZE_MAX + 1),
      }),
    (err) => err.code === ERROR_CODES.INVALID_CART_ITEM
  );
});
