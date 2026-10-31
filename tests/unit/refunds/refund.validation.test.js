'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateRefundListQuery,
  validateReviewInput,
  assertObjectId,
} = require('../../../src/modules/refunds/refund.validation');
const { ERROR_CODES } = require('../../../src/constants');

const ID = '507f1f77bcf86cd799439061';

function code(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    return err.code;
  }
}

test('a valid refund list query passes through the allowed filters', () => {
  const { filter, dateFrom, dateTo } = validateRefundListQuery({
    status: 'PROCESSED',
    orderId: ID,
    returnId: ID,
    customerId: ID,
    refundNumber: 'RFD-20260808-000001',
    dateFrom: '2026-08-01',
    dateTo: '2026-08-08',
    page: '2',
  });
  assert.equal(filter.status, 'PROCESSED');
  assert.equal(filter.orderId, ID);
  assert.equal(filter.returnId, ID);
  assert.equal(filter.customerId, ID);
  assert.equal(filter.refundNumber, 'RFD-20260808-000001');
  assert.ok(dateFrom instanceof Date);
  assert.ok(dateTo instanceof Date);
});

test('an empty query returns an empty filter (returns everything)', () => {
  const { filter } = validateRefundListQuery({});
  assert.deepEqual(filter, {});
});

test('invalid status is rejected with the refund status code', () => {
  assert.equal(code(() => validateRefundListQuery({ status: 'NOPE' })), ERROR_CODES.INVALID_REFUND_STATUS);
});

test('malformed ids and dates are rejected', () => {
  assert.equal(code(() => validateRefundListQuery({ orderId: 'nope' })), ERROR_CODES.INVALID_REFUND);
  assert.equal(code(() => validateRefundListQuery({ dateFrom: 'not-a-date' })), ERROR_CODES.INVALID_REFUND);
  assert.equal(
    code(() => validateRefundListQuery({ dateFrom: '2026-08-08', dateTo: '2026-08-01' })),
    ERROR_CODES.INVALID_REFUND
  );
});

test('review input accepts only an optional note', () => {
  assert.deepEqual(validateReviewInput({}).value, {});
  assert.equal(validateReviewInput({ note: '  ok  ' }).value.note, 'ok');
  assert.equal(code(() => validateReviewInput({ status: 'PROCESSED' })), ERROR_CODES.INVALID_REFUND);
  assert.equal(code(() => validateReviewInput({ $set: {} })), ERROR_CODES.INVALID_REFUND);
});

test('assertObjectId rejects malformed ids', () => {
  assert.throws(() => assertObjectId('abc', 'x'), (err) => err.code === ERROR_CODES.INVALID_REFUND);
  assert.equal(assertObjectId(ID, 'x'), ID);
});
