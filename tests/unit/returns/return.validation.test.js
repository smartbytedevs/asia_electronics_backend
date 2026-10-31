'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateCreateInput,
  validateIdempotencyKey,
  validateReviewInput,
  validateReturnListQuery,
  assertObjectId,
} = require('../../../src/modules/returns/return.validation');
const { ERROR_CODES } = require('../../../src/constants');

const ORDER_ITEM_ID = '507f1f77bcf86cd799439011';

function validRequest(overrides = {}) {
  return {
    reason: 'Wrong size',
    items: [{ orderItemId: ORDER_ITEM_ID, quantity: 1 }],
    notes: 'happy with exchange later',
    ...overrides,
  };
}

function code(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    return err.code;
  }
}

test('a valid return request validates and normalizes', () => {
  const { value } = validateCreateInput(validRequest());
  assert.equal(value.reason, 'Wrong size');
  assert.equal(value.notes, 'happy with exchange later');
  assert.deepEqual(value.items, [{ orderItemId: ORDER_ITEM_ID, quantity: 1 }]);
});

test('unknown keys are rejected (no status/actor/money mass-assignment)', () => {
  for (const bad of [
    { status: 'APPROVED' },
    { customerId: ORDER_ITEM_ID },
    { refundId: ORDER_ITEM_ID },
    { amount: 9999 },
  ]) {
    assert.equal(
      code(() => validateCreateInput(validRequest(bad))),
      ERROR_CODES.INVALID_RETURN,
      `key "${Object.keys(bad)[0]}" must be rejected`
    );
  }
});

test('MongoDB operators are rejected at every level', () => {
  assert.equal(code(() => validateCreateInput({ $set: {} })), ERROR_CODES.INVALID_RETURN);
  assert.equal(
    code(() => validateCreateInput(validRequest({ items: [{ orderItemId: ORDER_ITEM_ID, quantity: 1, $inc: { quantity: 1 } }] }))),
    ERROR_CODES.INVALID_RETURN
  );
});

test('reason is required and bounded', () => {
  assert.equal(code(() => validateCreateInput(validRequest({ reason: '' }))), ERROR_CODES.INVALID_RETURN);
  assert.equal(code(() => validateCreateInput(validRequest({ reason: undefined }))), ERROR_CODES.INVALID_RETURN);
});

test('items must be a non-empty array without duplicates', () => {
  assert.equal(code(() => validateCreateInput(validRequest({ items: [] }))), ERROR_CODES.INVALID_RETURN);
  assert.equal(
    code(() =>
      validateCreateInput(
        validRequest({
          items: [
            { orderItemId: ORDER_ITEM_ID, quantity: 1 },
            { orderItemId: ORDER_ITEM_ID, quantity: 2 },
          ],
        })
      )
    ),
    ERROR_CODES.RETURN_ITEM_DUPLICATE
  );
});

test('quantity must be a positive integer', () => {
  for (const bad of [0, -1, 1.5, '1', null]) {
    assert.equal(
      code(() => validateCreateInput(validRequest({ items: [{ orderItemId: ORDER_ITEM_ID, quantity: bad }] }))),
      ERROR_CODES.INVALID_RETURN,
      `quantity ${bad} must be rejected`
    );
  }
});

test('orderItemId must be a valid ObjectId', () => {
  assert.equal(
    code(() => validateCreateInput(validRequest({ items: [{ orderItemId: 'not-an-id', quantity: 1 }] }))),
    ERROR_CODES.INVALID_RETURN
  );
});

test('Idempotency-Key is required and bounded', () => {
  assert.equal(code(() => validateIdempotencyKey(undefined)), ERROR_CODES.INVALID_RETURN);
  assert.equal(code(() => validateIdempotencyKey('   ')), ERROR_CODES.INVALID_RETURN);
  assert.equal(validateIdempotencyKey(' key-1 '), 'key-1');
});

test('review input accepts only an optional note', () => {
  assert.deepEqual(validateReviewInput({}).value, { note: null });
  assert.equal(validateReviewInput({ note: '  ok  ' }).value.note, 'ok');
  assert.equal(code(() => validateReviewInput({ status: 'APPROVED' })), ERROR_CODES.INVALID_RETURN);
  assert.equal(code(() => validateReviewInput({ $set: {} })), ERROR_CODES.INVALID_RETURN);
});

test('list query validates status, ids and date ranges', () => {
  assert.equal(
    code(() => validateReturnListQuery({ status: 'NOPE' })),
    ERROR_CODES.INVALID_RETURN_STATUS
  );
  assert.equal(code(() => validateReturnListQuery({ customerId: 'nope' })), ERROR_CODES.INVALID_RETURN);
  const ok = validateReturnListQuery({ status: 'PENDING', dateFrom: '2026-08-01', dateTo: '2026-08-08' });
  assert.equal(ok.filter.status, 'PENDING');
  assert.equal(code(() => validateReturnListQuery({ dateFrom: '2026-08-08', dateTo: '2026-08-01' })), ERROR_CODES.INVALID_RETURN);
});

test('assertObjectId rejects malformed ids', () => {
  assert.throws(() => assertObjectId('abc', 'x'), (err) => err.code === ERROR_CODES.INVALID_RETURN);
  assert.equal(assertObjectId(ORDER_ITEM_ID, 'x'), ORDER_ITEM_ID);
});
