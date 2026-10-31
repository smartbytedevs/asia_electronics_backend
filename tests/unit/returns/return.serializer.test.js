'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  serializeReturn,
  serializeCustomerReturn,
  serializeAdminReturn,
} = require('../../../src/modules/returns/return.serializer');

const RETURN_ID = '507f1f77bcf86cd799439001';
const CUSTOMER = '507f1f77bcf86cd799439002';
const ORDER_ID = '507f1f77bcf86cd799439003';
const STAFF = '507f1f77bcf86cd799439004';

function makeReturn(overrides = {}) {
  return {
    _id: RETURN_ID,
    returnNumber: 'RET-20260808-000001',
    customerId: CUSTOMER,
    orderId: ORDER_ID,
    status: 'APPROVED',
    statusHistory: [
      { status: 'PENDING', at: new Date('2026-08-01T10:00:00Z'), by: CUSTOMER, note: null },
      { status: 'APPROVED', at: new Date('2026-08-02T10:00:00Z'), by: STAFF, note: 'ok' },
    ],
    items: [
      {
        _id: '507f1f77bcf86cd799439005',
        orderItemId: '507f1f77bcf86cd799439006',
        productId: '507f1f77bcf86cd799439007',
        productVariantId: '507f1f77bcf86cd799439008',
        productName: 'Thobe',
        sku: 'THB-L',
        quantity: 1,
        unitPriceMinorUnits: 100000,
        discountMinorUnits: 5000,
      },
    ],
    reason: 'Wrong size',
    notes: 'exchange preferred',
    refundId: null,
    approvedBy: STAFF,
    approvedAt: new Date('2026-08-02T10:00:00Z'),
    rejectedBy: null,
    rejectedAt: null,
    cancelledBy: null,
    cancelledAt: null,
    completedBy: null,
    completedAt: null,
    createdAt: new Date('2026-08-01T10:00:00Z'),
    updatedAt: new Date('2026-08-02T10:00:00Z'),
    ...overrides,
  };
}

test('customer view is safe and readable, without actor identities', () => {
  const out = serializeCustomerReturn(makeReturn());
  assert.equal(out.id, RETURN_ID);
  assert.equal(out.returnNumber, 'RET-20260808-000001');
  assert.equal(out.status, 'APPROVED');
  assert.equal(out.orderId, ORDER_ID);
  assert.equal(out.items[0].sku, 'THB-L');
  assert.equal(out.items[0].unitPriceMinorUnits, 100000);
  assert.equal(out.customerId, undefined, 'customer must not leak identity in customer view');
  assert.equal(out.approvedBy, undefined);
});

test('admin view adds customer and reviewer identities', () => {
  const out = serializeAdminReturn(makeReturn());
  assert.equal(out.customerId, CUSTOMER);
  assert.equal(out.approvedBy, STAFF);
  assert.equal(out.rejectedBy, null);
  assert.equal(out.cancelledBy, null);
  assert.equal(out.completedBy, null);
});

test('serializeReturn honors the admin flag explicitly', () => {
  const admin = serializeReturn(makeReturn(), { admin: true });
  assert.equal(admin.customerId, CUSTOMER);
  const customer = serializeReturn(makeReturn(), { admin: false });
  assert.equal(customer.customerId, undefined);
});

test('status history is exposed with actor and timestamps', () => {
  const out = serializeAdminReturn(makeReturn());
  assert.equal(out.statusHistory.length, 2);
  assert.equal(out.statusHistory[1].by, STAFF);
  assert.equal(out.statusHistory[1].note, 'ok');
  assert.equal(out.statusHistory[0].at, '2026-08-01T10:00:00.000Z');
});
