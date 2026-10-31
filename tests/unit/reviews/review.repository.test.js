'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createReviewRepository } = require('../../../src/modules/reviews/review.repository');

/**
 * Exercises the REAL repository against a mock model, asserting the exact
 * MongoDB filters/options that reach the database:
 *  - `conditionalTransition` is the ATOMIC CONFLICT POINT guarded on the
 *    current status,
 *  - `aggregateApprovedRatings` matches on the product id + APPROVED status and
 *    maps `_id` → `rating`.
 */

const REVIEW_ID = '507f1f77bcf86cd799439601';
const PRODUCT_ID = '507f1f77bcf86cd799439602';

function mockModel() {
  const calls = [];
  const model = {
    calls,
    findOneAndUpdate: (filter, update, options) => {
      calls.push({ kind: 'findOneAndUpdate', filter, update, options });
      return { _id: REVIEW_ID, status: 'APPROVED' };
    },
    aggregate: async (pipeline) => {
      calls.push({ kind: 'aggregate', pipeline });
      return [
        { _id: 5, count: 3 },
        { _id: 4, count: 1 },
      ];
    },
  };
  return model;
}

test('conditionalTransition is the atomic conflict point guarded on status', async () => {
  const model = mockModel();
  const repo = createReviewRepository(model);
  const session = { id: 'session-test' };
  const update = { $set: { status: 'APPROVED' } };

  const result = await repo.conditionalTransition(REVIEW_ID, 'PENDING', update, { session });

  assert.deepEqual(model.calls[0].filter, { _id: REVIEW_ID, status: 'PENDING' });
  assert.deepEqual(model.calls[0].update, update);
  assert.equal(model.calls[0].options.new, true);
  assert.equal(model.calls[0].options.runValidators, true);
  assert.equal(model.calls[0].options.session, session);
  assert.equal(result.status, 'APPROVED');
});

test('aggregateApprovedRatings matches approved reviews of the product only', async () => {
  const model = mockModel();
  const repo = createReviewRepository(model);

  const rows = await repo.aggregateApprovedRatings(PRODUCT_ID);

  assert.equal(model.calls[0].kind, 'aggregate');
  const [match, group] = model.calls[0].pipeline;
  assert.equal(String(match.$match.productId), PRODUCT_ID, 'productId cast to ObjectId');
  assert.equal(match.$match.status, 'APPROVED');
  assert.equal(group.$group._id, '$rating');
  assert.deepEqual(rows, [
    { rating: 5, count: 3 },
    { rating: 4, count: 1 },
  ]);
});
