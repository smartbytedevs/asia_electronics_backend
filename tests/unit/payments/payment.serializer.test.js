'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { serializePayment, serializeCustomerPayment, serializeAdminPayment } = require('../../../src/modules/payments/payment.serializer');
const {
  serializePaymentMethodForCustomer,
  serializePaymentMethodForAdmin,
} = require('../../../src/modules/payments/paymentMethod.serializer');
const { PAYMENT_STATUSES } = require('../../../src/modules/payments/payment.constants');

const CUSTOMER = '507f1f77bcf86cd799439111';
const STAFF = '507f1f77bcf86cd799439113';

function makePayment(overrides = {}) {
  return {
    _id: '507f1f77bcf86cd799439501',
    orderId: '507f1f77bcf86cd799439201',
    customerId: CUSTOMER,
    paymentMethodId: '507f1f77bcf86cd799439301',
    paymentMethodSnapshot: { code: 'BANK_TRANSFER', displayName: 'Bank Transfer', accountNumber: '0123' },
    transactionReference: 'REF-1',
    submittedAmountMinorUnits: 248000,
    expectedAmountMinorUnits: 248000,
    proof: { provider: 'cloudinary', publicId: 'payments/x', secureUrl: 'https://res/x', resourceType: 'image', format: 'png' },
    status: PAYMENT_STATUSES.VERIFIED,
    statusHistory: [
      { status: PAYMENT_STATUSES.SUBMITTED, at: new Date('2026-08-08T00:00:00Z'), by: CUSTOMER, note: null },
      { status: PAYMENT_STATUSES.VERIFIED, at: new Date('2026-08-08T01:00:00Z'), by: STAFF, note: 'ok' },
    ],
    notes: null,
    verifiedBy: STAFF,
    verifiedAt: new Date('2026-08-08T01:00:00Z'),
    rejectedBy: null,
    rejectedAt: null,
    createdAt: new Date('2026-08-08T00:00:00Z'),
    updatedAt: new Date('2026-08-08T01:00:00Z'),
    __v: 0,
    internalSecret: 'nope',
    ...overrides,
  };
}

test('customer serialization omits reviewer ids and internal fields', () => {
  const out = serializeCustomerPayment(makePayment());
  assert.equal(out.id, '507f1f77bcf86cd799439501');
  assert.equal(out.status, PAYMENT_STATUSES.VERIFIED);
  assert.equal(out.paymentMethod.code, 'BANK_TRANSFER');
  assert.equal(out.proof.publicId, 'payments/x');
  assert.equal('verifiedBy' in out, false);
  assert.equal('rejectedBy' in out, false);
  assert.equal('__v' in out, false);
  assert.equal('internalSecret' in out, false);
  assert.equal(out.statusHistory.length, 2);
  assert.equal(out.statusHistory[1].by, STAFF);
  assert.equal(out.statusHistory[1].note, 'ok');
});

test('admin serialization adds reviewer ids', () => {
  const out = serializeAdminPayment(makePayment());
  assert.equal(out.verifiedBy, STAFF);
  assert.equal(out.rejectedBy, null);
});

test('serializePayment is deterministic and null-safe on missing fields', () => {
  const out = serializePayment({ _id: '507f1f77bcf86cd799439502' });
  assert.equal(out.orderId, '');
  assert.equal(out.paymentMethod.code, undefined);
  assert.equal(out.paymentMethod.accountNumber, null);
  assert.equal(out.proof.publicId, undefined);
  assert.equal(out.statusHistory.length, 0);
  assert.equal(out.notes, null);
});

test('payment method customer serializer exposes public transfer metadata only', () => {
  const method = {
    _id: '507f1f77bcf86cd799439301',
    code: 'BANK_TRANSFER',
    displayName: 'Bank Transfer',
    type: 'MANUAL',
    metadata: { accountName: 'Taqwa', accountNumber: '0123', bankName: 'DBBL', branch: 'GEC', district: 'Chittagong', accountType: 'Current', routingNumber: '09', instructions: 'Ref' },
    isActive: true,
    sortOrder: 3,
    createdAt: new Date('2026-08-08T00:00:00Z'),
  };
  const out = serializePaymentMethodForCustomer(method);
  assert.equal(out.metadata.accountNumber, '0123');
  assert.equal(out.metadata.district, 'Chittagong');
  assert.equal(out.metadata.accountType, 'Current');
  assert.equal(out.metadata.instructions, 'Ref');
  assert.equal('isActive' in out, false);
  assert.equal('sortOrder' in out, false);
});

test('payment method admin serializer adds operational flags', () => {
  const method = {
    _id: '507f1f77bcf86cd799439301',
    code: 'BANK_TRANSFER',
    displayName: 'Bank Transfer',
    type: 'MANUAL',
    metadata: {},
    isActive: false,
    sortOrder: 3,
    createdAt: new Date('2026-08-08T00:00:00Z'),
    updatedAt: new Date('2026-08-08T00:00:00Z'),
  };
  const out = serializePaymentMethodForAdmin(method);
  assert.equal(out.isActive, false);
  assert.equal(out.sortOrder, 3);
  assert.ok(out.createdAt);
});
