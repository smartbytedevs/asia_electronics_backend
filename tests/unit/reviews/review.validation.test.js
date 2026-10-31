'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateCreateInput,
  validateReviewInput,
  validateReviewListQuery,
  assertObjectId,
} = require('../../../src/modules/reviews/review.validation');
const { ERROR_CODES } = require('../../../src/constants');

const PRODUCT_ID = '507f1f77bcf86cd799439911';

function captureError(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return null;
}

function assertInvalidReview(fn, messagePart) {
  const err = captureError(fn);
  assert.ok(err, 'expected an error to be thrown');
  assert.equal(err.statusCode, 400);
  assert.equal(err.code, ERROR_CODES.INVALID_REVIEW);
  if (messagePart) {
    assert.ok(
      String(err.message).includes(messagePart),
      `message "${err.message}" should include "${messagePart}"`
    );
  }
}

test('valid create input: integer rating 1-5 with optional comment', () => {
  const { value } = validateCreateInput({ rating: 5, comment: '  Excellent abaya  ' });
  assert.equal(value.rating, 5);
  assert.equal(value.comment, 'Excellent abaya');
});

test('create input without comment normalizes to null', () => {
  assert.equal(validateCreateInput({ rating: 3 }).value.comment, null);
  assert.equal(validateCreateInput({ rating: 3, comment: '' }).value.comment, null);
  assert.equal(validateCreateInput({ rating: 3, comment: null }).value.comment, null);
});

test('status/actor/identity fields are rejected (cannot force APPROVED)', () => {
  assertInvalidReview(() => validateCreateInput({ rating: 5, status: 'APPROVED' }), 'unknown field(s)');
  assertInvalidReview(() => validateCreateInput({ rating: 5, customerId: PRODUCT_ID }), 'unknown field(s)');
  assertInvalidReview(() => validateCreateInput({ rating: 5, approvedBy: 'admin' }), 'unknown field(s)');
  assertInvalidReview(() => validateCreateInput({ rating: 5, $set: { status: 'APPROVED' } }), 'MongoDB update operators');
});

test('invalid rating rejected', () => {
  assertInvalidReview(() => validateCreateInput({ rating: 0 }));
  assertInvalidReview(() => validateCreateInput({ rating: 6 }));
  assertInvalidReview(() => validateCreateInput({ rating: 3.5 }));
  assertInvalidReview(() => validateCreateInput({ rating: '5' }));
  assertInvalidReview(() => validateCreateInput({}));
});

test('invalid comment rejected', () => {
  assertInvalidReview(() => validateCreateInput({ rating: 5, comment: 42 }));
  assertInvalidReview(() => validateCreateInput({ rating: 5, comment: 'x'.repeat(2001) }));
});

test('non-object body rejected', () => {
  assertInvalidReview(() => validateCreateInput(null));
  assertInvalidReview(() => validateCreateInput([]));
  assertInvalidReview(() => validateCreateInput('rating'));
});

test('moderation body accepts only an optional note', () => {
  assert.equal(validateReviewInput({}).value.note, null);
  assert.equal(validateReviewInput({ note: '  solid quality  ' }).value.note, 'solid quality');
  assertInvalidReview(() => validateReviewInput({ status: 'APPROVED' }), 'unknown field(s)');
  assertInvalidReview(() => validateReviewInput({ note: 'x'.repeat(501) }));
});

test('admin list query: status allowlist + productId', () => {
  assert.equal(validateReviewListQuery({ status: 'PENDING' }).filter.status, 'PENDING');
  assert.equal(validateReviewListQuery({ productId: PRODUCT_ID }).filter.productId, PRODUCT_ID);
  assert.deepEqual(validateReviewListQuery({}).filter, {});
  assert.deepEqual(validateReviewListQuery({ status: '' }).filter, {});

  const err = captureError(() => validateReviewListQuery({ status: 'PAID' }));
  assert.ok(err);
  assert.equal(err.statusCode, 400);
  assert.equal(err.code, ERROR_CODES.INVALID_REVIEW_STATUS);

  assertInvalidReview(() => validateReviewListQuery({ productId: 'nope' }));
});

test('assertObjectId validates 24-char hex ObjectIds', () => {
  assert.equal(assertObjectId(PRODUCT_ID, 'productId'), PRODUCT_ID);
  assertInvalidReview(() => assertObjectId('short', 'productId'));
});
