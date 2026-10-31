'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { toRefundOutput } = require('../../../src/modules/refunds/refund.serializer');

const REFUND_ID = '507f1f77bcf86cd799439001';
const RETURN_ID = '507f1f77bcf86cd799439002';
const ORDER_ID = '507f1f77bcf86cd799439003';
const CUSTOMER = '507f1f77bcf86cd799439004';
const STAFF = '507f1f77bcf86cd799439005';

function makeRefund(overrides = {}) {
  return {
    _id: REFUND_ID,
    refundNumber: 'RFD-20260808-000001',
    return: RETURN_ID,
    order: ORDER_ID,
    customer: CUSTOMER,
    paymentMethod: 'COD',
    paymentId: null,
    amount: 95000,
    status: 'PENDING',
    note: '',
    processedBy: null,
    processedAt: null,
    voidedBy: null,
    voidedAt: null,
    statusHistory: [
      { status: 'PENDING', at: new Date('2026-08-02T10:00:00Z'), by: STAFF, note: 'Auto-created' },
    ],
    createdAt: new Date('2026-08-02T10:00:00Z'),
    updatedAt: new Date('2026-08-02T10:00:00Z'),
    ...overrides,
  };
}

test('bare ObjectId refs are serialized as bare { id } refs', () => {
  const out = toRefundOutput(makeRefund());
  assert.equal(out.id, REFUND_ID);
  assert.equal(out.refundNumber, 'RFD-20260808-000001');
  assert.deepEqual(out.return, { id: RETURN_ID, returnNumber: null, status: null });
  assert.deepEqual(out.order, { id: ORDER_ID, orderNumber: null });
  assert.deepEqual(out.customer, { id: CUSTOMER });
  assert.equal(out.paymentMethod, 'COD');
  assert.equal(out.paymentId, null);
  assert.equal(out.amount, 95000);
  assert.equal(out.status, 'PENDING');
});

test('populated refs enrich the envelope with identity fields', () => {
  const out = toRefundOutput(
    makeRefund({
      return: { _id: RETURN_ID, returnNumber: 'RET-20260808-000001', status: 'COMPLETED' },
      order: { _id: ORDER_ID, orderNumber: 'TAQ-20260701-000001' },
      customer: { _id: CUSTOMER, name: 'Ahmed', email: 'ahmed@example.com' },
    })
  );
  assert.deepEqual(out.return, {
    id: RETURN_ID,
    returnNumber: 'RET-20260808-000001',
    status: 'COMPLETED',
  });
  assert.deepEqual(out.order, { id: ORDER_ID, orderNumber: 'TAQ-20260701-000001' });
  assert.deepEqual(out.customer, { id: CUSTOMER, name: 'Ahmed', email: 'ahmed@example.com' });
});

test('process/void actors and timestamps are reflected', () => {
  const out = toRefundOutput(
    makeRefund({
      status: 'PROCESSED',
      processedBy: STAFF,
      processedAt: new Date('2026-08-03T10:00:00Z'),
      statusHistory: [
        { status: 'PENDING', at: new Date('2026-08-02T10:00:00Z'), by: STAFF, note: 'Auto-created' },
        { status: 'PROCESSED', at: new Date('2026-08-03T10:00:00Z'), by: STAFF, note: 'paid' },
      ],
    })
  );
  assert.equal(out.status, 'PROCESSED');
  assert.deepEqual(out.processedBy, { id: STAFF });
  assert.equal(out.processedAt, '2026-08-03T10:00:00.000Z');
  assert.equal(out.statusHistory.length, 2);
});

test('null refund returns null', () => {
  assert.equal(toRefundOutput(null), null);
});
