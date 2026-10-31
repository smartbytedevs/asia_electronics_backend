'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createReturnRepository } = require('../../../src/modules/returns/return.repository');

/**
 * Exercises the REAL return repository against a mock model, asserting the
 * exact MongoDB filters/options that reach the database. `conditionalTransition`
 * is the ATOMIC CONFLICT POINT for the return state machine — an update applies
 * only while the document is still in `fromStatus`, so concurrent
 * approve/reject/complete/cancel calls cannot double-apply.
 */

const RETURN_ID = '507f1f77bcf86cd799439601';

function mockModel() {
  const calls = [];
  const model = {
    calls,
    findById: async (id, projection, options) => {
      calls.push({ kind: 'findById', id, options });
      return { _id: RETURN_ID, status: 'PENDING' };
    },
    findOne: async (filter, projection, options) => {
      calls.push({ kind: 'findOne', filter, options });
      return { _id: RETURN_ID };
    },
    find: async (filter, projection, options) => {
      calls.push({ kind: 'find', filter, options });
      return [{ _id: RETURN_ID }];
    },
    create: async (docs, options) => {
      calls.push({ kind: 'create', docs, options });
      return docs;
    },
    findByIdAndUpdate: async (id, update, options) => {
      calls.push({ kind: 'findByIdAndUpdate', id, update, options });
      return { _id: RETURN_ID, refundId: '507f1f77bcf86cd799439602' };
    },
    countDocuments: async (filter) => {
      calls.push({ kind: 'countDocuments', filter });
      return 1;
    },
    findOneAndUpdate: async (filter, update, options) => {
      calls.push({ kind: 'findOneAndUpdate', filter, update, options });
      return { _id: RETURN_ID, status: 'APPROVED' };
    },
  };
  return model;
}

test('conditionalTransition guards on _id + current status and returns the updated doc', async () => {
  const model = mockModel();
  const repo = createReturnRepository(model);
  const session = { id: 'session-test' };
  const update = { $set: { status: 'APPROVED' }, $push: { statusHistory: { status: 'APPROVED', at: new Date(), by: 'u1' } } };

  const result = await repo.conditionalTransition(RETURN_ID, 'PENDING', update, { session });

  assert.deepEqual(model.calls[0].filter, { _id: RETURN_ID, status: 'PENDING' });
  assert.equal(model.calls[0].update, update);
  assert.equal(model.calls[0].options.new, true);
  assert.equal(model.calls[0].options.runValidators, true);
  assert.equal(model.calls[0].options.session, session);
  assert.equal(result.status, 'APPROVED');
});

test('base CRUD methods forward filters and options unchanged', async () => {
  const model = mockModel();
  const repo = createReturnRepository(model);
  const session = { id: 'session-test' };

  await repo.findById(RETURN_ID, { session });
  assert.equal(model.calls[0].kind, 'findById');
  assert.equal(model.calls[0].id, RETURN_ID);
  assert.equal(model.calls[0].options.session, session);

  await repo.findMany({ status: 'PENDING' }, { sort: { createdAt: -1 } });
  assert.equal(model.calls[1].kind, 'find');
  assert.deepEqual(model.calls[1].filter, { status: 'PENDING' });
  assert.deepEqual(model.calls[1].options, { sort: { createdAt: -1 } });

  await repo.updateById(RETURN_ID, { $set: { refundId: '507f1f77bcf86cd799439602' } }, { session });
  assert.equal(model.calls[2].kind, 'findByIdAndUpdate');
  assert.equal(model.calls[2].options.new, true);
  assert.equal(model.calls[2].options.session, session);

  await repo.count({ status: 'COMPLETED' });
  assert.equal(model.calls[3].kind, 'countDocuments');
  assert.deepEqual(model.calls[3].filter, { status: 'COMPLETED' });
});

test('the repository exposes the return-specific surface', () => {
  const model = mockModel();
  const repo = createReturnRepository(model);
  for (const method of [
    'findById',
    'findOne',
    'findMany',
    'create',
    'updateById',
    'count',
    'conditionalTransition',
  ]) {
    assert.equal(typeof repo[method], 'function', `${method} should be a function`);
  }
});
