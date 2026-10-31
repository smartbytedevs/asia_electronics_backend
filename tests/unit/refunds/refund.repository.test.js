'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createRefundRepository } = require('../../../src/modules/refunds/refund.repository');

/**
 * Exercises the REAL repository against a mock model, asserting the exact
 * MongoDB filters/options that reach the database. This is what guarantees:
 *  - every list read carries the soft-delete guard (`deleted: { $ne: true }`)
 *    and maps OPT-IN filters to the persisted field names,
 *  - `findOne`/`findMany`/`count` are method-bound so `this.buildQuery` is
 *    resolvable (regression: they used to be arrow functions that crashed with
 *    "this.buildQuery is not a function"),
 *  - `conditionalTransition` is the ATOMIC CONFLICT POINT guarded on the
 *    current status plus the soft-delete guard.
 */

const REFUND_ID = '507f1f77bcf86cd799439501';
const RETURN_ID = '507f1f77bcf86cd799439502';
const ORDER_ID = '507f1f77bcf86cd799439503';
const CUSTOMER_ID = '507f1f77bcf86cd799439504';

function mockModel() {
  const calls = [];
  const model = {
    calls,
    findOne: (filter, projection, options) => {
      calls.push({ kind: 'findOne', filter, options });
      return { lean: () => ({ _id: REFUND_ID, refundNumber: 'RFD-20260808-000001', status: 'PENDING' }) };
    },
    find: (filter, projection, options) => {
      calls.push({ kind: 'find', filter, options });
      return { lean: () => [{ _id: REFUND_ID }] };
    },
    countDocuments: async (filter) => {
      calls.push({ kind: 'countDocuments', filter });
      return 3;
    },
    findOneAndUpdate: (filter, update, options) => {
      calls.push({ kind: 'findOneAndUpdate', filter, update, options });
      return { lean: () => ({ _id: REFUND_ID, status: 'PROCESSED' }) };
    },
    create: async (docs, options) => {
      calls.push({ kind: 'create', docs, options });
      return docs;
    },
  };
  return model;
}

test('findMany always applies the soft-delete guard and maps OPT-IN filters', async () => {
  const model = mockModel();
  const repo = createRefundRepository(model);
  await repo.findMany({
    status: 'PENDING',
    returnId: RETURN_ID,
    orderId: ORDER_ID,
    customerId: CUSTOMER_ID,
    refundNumber: 'RFD-20260808-000001',
    dateFrom: '2026-08-01',
    dateTo: '2026-08-08',
  });
  assert.deepEqual(model.calls[0].filter, {
    deleted: { $ne: true },
    status: 'PENDING',
    return: RETURN_ID,
    order: ORDER_ID,
    customer: CUSTOMER_ID,
    refundNumber: 'RFD-20260808-000001',
    createdAt: { $gte: '2026-08-01', $lte: '2026-08-08' },
  });
});

test('an empty findMany filter still carries the soft-delete guard only', async () => {
  const model = mockModel();
  const repo = createRefundRepository(model);
  await repo.findMany({});
  assert.deepEqual(model.calls[0].filter, { deleted: { $ne: true } });
});

test('findOne/count route through buildQuery (method-bound, no this crash)', async () => {
  const model = mockModel();
  const repo = createRefundRepository(model);
  const session = { id: 'session-test' };

  await repo.findOne({ refundNumber: 'RFD-20260808-000001' }, { session });
  assert.deepEqual(model.calls[0].filter, {
    deleted: { $ne: true },
    refundNumber: 'RFD-20260808-000001',
  });
  assert.equal(model.calls[0].options.session, session);
  assert.equal(typeof model.calls[0].options.lean, 'undefined', 'lean applied by the repository');

  await repo.count({ status: 'VOIDED' });
  assert.deepEqual(model.calls[1].filter, { deleted: { $ne: true }, status: 'VOIDED' });
  assert.equal(model.calls[1].kind, 'countDocuments');
});

test('conditionalTransition is the atomic conflict point guarded on status + soft-delete', async () => {
  const model = mockModel();
  const repo = createRefundRepository(model);
  const session = { id: 'session-test' };
  const update = { $set: { status: 'PROCESSED' } };

  const result = await repo.conditionalTransition(REFUND_ID, 'PENDING', update, { session });

  assert.deepEqual(model.calls[0].filter, {
    _id: REFUND_ID,
    status: 'PENDING',
    deleted: { $ne: true },
  });
  assert.deepEqual(model.calls[0].update, update);
  assert.equal(model.calls[0].options.new, true);
  assert.equal(model.calls[0].options.runValidators, true);
  assert.equal(model.calls[0].options.session, session);
  assert.equal(result.status, 'PROCESSED');
});

test('create wraps the doc in an array and forwards options', async () => {
  const model = mockModel();
  const repo = createRefundRepository(model);
  const session = { id: 'session-test' };
  const data = { refundNumber: 'RFD-20260808-000002' };

  const created = await repo.create(data, { session });

  assert.deepEqual(model.calls[0].docs, [data]);
  assert.equal(model.calls[0].options.session, session);
  assert.equal(created, data, 'returns the first created document');
});
