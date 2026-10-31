'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  serializePublicReview,
  serializeCustomerReview,
  serializeAdminReview,
} = require('../../../src/modules/reviews/review.serializer');

const REVIEW_ID = '507f1f77bcf86cd799439001';
const PRODUCT_ID = '507f1f77bcf86cd799439002';
const CUSTOMER = '507f1f77bcf86cd799439003';
const ADMIN = '507f1f77bcf86cd799439004';

function makeReview(overrides = {}) {
  return {
    _id: REVIEW_ID,
    productId: PRODUCT_ID,
    customerId: CUSTOMER,
    customerDisplayName: 'Amina Rahman',
    rating: 5,
    comment: 'Great quality',
    status: 'APPROVED',
    statusHistory: [
      { status: 'PENDING', at: new Date('2026-08-01T10:00:00Z'), by: CUSTOMER, note: null },
      { status: 'APPROVED', at: new Date('2026-08-02T10:00:00Z'), by: ADMIN, note: 'ok' },
    ],
    approvedBy: ADMIN,
    approvedAt: new Date('2026-08-02T10:00:00Z'),
    rejectedBy: null,
    rejectedAt: null,
    createdAt: new Date('2026-08-01T10:00:00Z'),
    updatedAt: new Date('2026-08-02T10:00:00Z'),
    ...overrides,
  };
}

test('public view exposes only storefront-safe fields', () => {
  const out = serializePublicReview(makeReview());
  assert.equal(out.id, REVIEW_ID);
  assert.equal(out.productId, PRODUCT_ID);
  assert.equal(out.customerDisplayName, 'Amina Rahman');
  assert.equal(out.rating, 5);
  assert.equal(out.comment, 'Great quality');
  assert.equal(out.createdAt, '2026-08-01T10:00:00.000Z');
  assert.equal(out.status, undefined, 'public view must not expose moderation status');
  assert.equal(out.customerId, undefined, 'customer identity must never leak publicly');
  assert.equal(out.approvedBy, undefined);
});

test('customer view adds the moderation status', () => {
  const out = serializeCustomerReview(makeReview());
  assert.equal(out.status, 'APPROVED');
  assert.equal(out.updatedAt, '2026-08-02T10:00:00.000Z');
  assert.equal(out.customerId, undefined);
  assert.equal(out.approvedBy, undefined);
});

test('admin view adds customer and reviewer identities', () => {
  const out = serializeAdminReview(makeReview());
  assert.equal(out.customerId, CUSTOMER);
  assert.equal(out.status, 'APPROVED');
  assert.equal(out.approvedBy, ADMIN);
  assert.equal(out.approvedAt, '2026-08-02T10:00:00.000Z');
  assert.equal(out.rejectedBy, null);
  assert.equal(out.rejectedAt, null);
  assert.equal(out.statusHistory.length, 2);
  assert.equal(out.statusHistory[0].status, 'PENDING');
  assert.equal(out.statusHistory[0].by, CUSTOMER);
});

test('optional fields normalize to null', () => {
  const out = serializePublicReview(
    makeReview({ comment: null, customerDisplayName: null, createdAt: null })
  );
  assert.equal(out.comment, null);
  assert.equal(out.customerDisplayName, null);
  assert.equal(out.createdAt, null);
});
