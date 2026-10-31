'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Refund = require('../../../src/modules/refunds/refund.model');
const { REFUND_STATUSES } = require('../../../src/modules/refunds/refund.constants');

const RETURN_ID = '507f1f77bcf86cd799439601';
const ORDER_ID = '507f1f77bcf86cd799439602';
const CUSTOMER = '507f1f77bcf86cd799439603';

function validRefundData(overrides = {}) {
  return {
    refundNumber: 'RFD-20260808-000001',
    return: RETURN_ID,
    order: ORDER_ID,
    customer: CUSTOMER,
    paymentMethod: 'COD',
    amount: 95000,
    status: REFUND_STATUSES.PENDING,
    statusHistory: [
      { status: REFUND_STATUSES.PENDING, at: new Date(), by: CUSTOMER, note: 'Auto-created' },
    ],
    ...overrides,
  };
}

test('accepts the server-generated number format RFD-YYYYMMDD-XXXXXX', async () => {
  const refund = new Refund(validRefundData());
  await refund.validate();
  assert.equal(refund.refundNumber, 'RFD-20260808-000001');
});

test('rejects the legacy short format RFD-XXXXXX (model/generator mismatch regression)', async () => {
  const refund = new Refund(validRefundData({ refundNumber: 'RFD-000001' }));
  await assert.rejects(refund.validate(), (err) => {
    assert.ok(err.errors && err.errors.refundNumber, 'refundNumber validation error');
    assert.ok(
      ['regexp', 'match'].includes(err.errors.refundNumber.kind),
      `kind was ${err.errors.refundNumber.kind}`
    );
    return true;
  });
});

test('rejects malformed numbers (non-digits / wrong width)', async () => {
  for (const bad of ['RFD-2026-000001', 'RFD-abcdefgh-000001', 'RFD-20260808-00000', 'XXD-20260808-000001']) {
    const refund = new Refund(validRefundData({ refundNumber: bad }));
    await assert.rejects(refund.validate(), (err) => {
      assert.ok(err.errors && err.errors.refundNumber, `refundNumber must reject "${bad}"`);
      return true;
    });
  }
});

test('requires the return link (1:1 with a Return) and a server-derived amount', async () => {
  await assert.rejects(new Refund(validRefundData({ return: undefined })).validate(), (err) => {
    assert.ok(err.errors && err.errors.return, 'return is required');
    return true;
  });
  await assert.rejects(new Refund(validRefundData({ amount: undefined })).validate(), (err) => {
    assert.ok(err.errors && err.errors.amount, 'amount is required');
    return true;
  });
});

test('money is non-negative INTEGER minor units (fractional paisa rejected)', async () => {
  for (const bad of [-1, 1.5, 0.01]) {
    const refund = new Refund(validRefundData({ amount: bad }));
    await assert.rejects(refund.validate(), (err) => {
      assert.ok(err.errors && err.errors.amount, `amount must reject ${bad}`);
      return true;
    });
  }
  const cast = new Refund(validRefundData({ amount: '100' }));
  await cast.validate();
  assert.equal(cast.amount, 100, 'numeric strings cast to integer minor units');
});

test('status defaults to PENDING and only known statuses are accepted', async () => {
  const refund = new Refund(validRefundData());
  await refund.validate();
  assert.equal(refund.status, REFUND_STATUSES.PENDING);
  const bad = new Refund(validRefundData({ status: 'PAID' }));
  await assert.rejects(bad.validate(), (err) => {
    assert.ok(err.errors && err.errors.status, 'unknown status rejected');
    return true;
  });
});

test('refundNumber is unique and indexed (number-generation race guard)', () => {
  const indexes = Refund.schema.indexes();
  const refundNumberIndex = indexes.find(
    ([fields]) => Object.keys(fields).join() === 'refundNumber'
  );
  assert.ok(refundNumberIndex, 'refundNumber index exists');
  assert.equal(refundNumberIndex[1].unique, true);
});

test('list-filter indexes target the PERSISTED field names (order/customer, not orderId/customerId)', () => {
  const indexFields = Refund.schema.indexes().map(([fields]) => Object.keys(fields).join());
  assert.ok(indexFields.includes('order,createdAt'), 'index on order + createdAt supports listRefunds(orderId)');
  assert.ok(indexFields.includes('customer,createdAt'), 'index on customer + createdAt supports listRefunds(customerId)');
  assert.ok(!indexFields.includes('orderId,createdAt'), 'no phantom orderId index');
  assert.ok(!indexFields.includes('customerId,createdAt'), 'no phantom customerId index');
});
