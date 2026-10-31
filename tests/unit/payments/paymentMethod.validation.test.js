'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  validatePaymentMethodCreate,
  validatePaymentMethodUpdate,
} = require('../../../src/modules/payments/paymentMethod.validation');
const { ERROR_CODES } = require('../../../src/constants');
const { PAYMENT_METHOD_TYPES } = require('../../../src/modules/payments/payment.constants');

function createBody(overrides = {}) {
  return {
    code: 'bank_transfer',
    displayName: 'Bank Transfer',
    type: PAYMENT_METHOD_TYPES.MANUAL,
    metadata: {
      accountName: 'Taqwa Trading',
      accountNumber: '0123456789',
      bankName: 'DBBL',
      branch: 'GEC',
      routingNumber: '090263020',
      instructions: 'Use your order number as the reference.',
    },
    ...overrides,
  };
}

test('a valid create body is normalized (code uppercased)', () => {
  const { value } = validatePaymentMethodCreate(createBody());
  assert.equal(value.code, 'BANK_TRANSFER');
  assert.equal(value.displayName, 'Bank Transfer');
  assert.equal(value.type, PAYMENT_METHOD_TYPES.MANUAL);
  assert.equal(value.metadata.accountNumber, '0123456789');
  assert.equal(value.isActive, true);
  assert.equal(value.sortOrder, 0);
});

test('create rejects invalid codes', () => {
  for (const bad of ['', 'a b', 'low-er', 'x'.repeat(51), 'has$']) {
    assert.throws(
      () => validatePaymentMethodCreate(createBody({ code: bad })),
      (err) => err.code === ERROR_CODES.INVALID_PAYMENT_METHOD,
      `code "${bad}" must be rejected`
    );
  }
});

test('create rejects missing displayName, invalid type, malformed metadata, non-boolean isActive', () => {
  assert.throws(() => validatePaymentMethodCreate(createBody({ displayName: '' })), (err) => err.code === ERROR_CODES.INVALID_PAYMENT_METHOD);
  assert.throws(() => validatePaymentMethodCreate(createBody({ type: 'GATEWAY' })), (err) => err.code === ERROR_CODES.INVALID_PAYMENT_METHOD);
  assert.throws(() => validatePaymentMethodCreate(createBody({ metadata: 'x' })), (err) => err.code === ERROR_CODES.INVALID_PAYMENT_METHOD);
  assert.throws(() => validatePaymentMethodCreate(createBody({ metadata: { secret: 'x' } })), (err) => err.code === ERROR_CODES.INVALID_PAYMENT_METHOD);
  assert.throws(() => validatePaymentMethodCreate(createBody({ isActive: 'yes' })), (err) => err.code === ERROR_CODES.INVALID_PAYMENT_METHOD);
  assert.throws(() => validatePaymentMethodCreate(createBody({ sortOrder: -1 })), (err) => err.code === ERROR_CODES.INVALID_PAYMENT_METHOD);
});

test('create accepts a CARD type with no manual metadata', () => {
  const { value } = validatePaymentMethodCreate({
    code: 'card',
    displayName: 'Credit Card',
    type: PAYMENT_METHOD_TYPES.CARD,
  });
  assert.equal(value.type, PAYMENT_METHOD_TYPES.CARD);
  assert.deepEqual(value.metadata, {});
});

test('create rejects manual metadata on a CARD type', () => {
  assert.throws(
    () => validatePaymentMethodCreate(createBody({ type: PAYMENT_METHOD_TYPES.CARD })),
    (err) => err.code === ERROR_CODES.INVALID_PAYMENT_METHOD
  );
  assert.throws(
    () => validatePaymentMethodCreate({ code: 'card', displayName: 'Card', type: PAYMENT_METHOD_TYPES.CARD, metadata: { bankName: 'DBBL' } }),
    (err) => err.code === ERROR_CODES.INVALID_PAYMENT_METHOD
  );
});

test('update validates metadata against the type being set', () => {
  assert.throws(
    () =>
      validatePaymentMethodUpdate({
        type: PAYMENT_METHOD_TYPES.CARD,
        metadata: { accountName: 'Taqwa Trading' },
      }),
    (err) => err.code === ERROR_CODES.INVALID_PAYMENT_METHOD
  );
  const { value } = validatePaymentMethodUpdate({
    type: PAYMENT_METHOD_TYPES.CARD,
    metadata: {},
  });
  assert.equal(value.type, PAYMENT_METHOD_TYPES.CARD);
  assert.deepEqual(value.metadata, {});
});

test('create rejects unknown keys and operator injection', () => {
  assert.throws(() => validatePaymentMethodCreate(createBody({ role: 'ADMIN' })), (err) => err.code === ERROR_CODES.INVALID_PAYMENT_METHOD);
  assert.throws(() => validatePaymentMethodCreate(createBody({ $set: {} })), (err) => err.code === ERROR_CODES.INVALID_PAYMENT_METHOD);
  assert.throws(() => validatePaymentMethodCreate(createBody({ metadata: { $set: {} } })), (err) => err.code === ERROR_CODES.INVALID_PAYMENT_METHOD);
});

test('update requires at least one mutable field and rejects code changes', () => {
  assert.throws(() => validatePaymentMethodUpdate({}), (err) => err.code === ERROR_CODES.INVALID_PAYMENT_METHOD);
  assert.throws(() => validatePaymentMethodUpdate({ code: 'NEW' }), (err) => err.code === ERROR_CODES.INVALID_PAYMENT_METHOD);
  const { value } = validatePaymentMethodUpdate({ isActive: false, displayName: 'Renamed', sortOrder: 5 });
  assert.equal(value.isActive, false);
  assert.equal(value.displayName, 'Renamed');
  assert.equal(value.sortOrder, 5);
});
