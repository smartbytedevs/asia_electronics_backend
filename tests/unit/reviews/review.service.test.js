'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ReviewService } = require('../../../src/modules/reviews/review.service');
const { ERROR_CODES } = require('../../../src/constants');
const {
  REVIEW_STATUSES,
  REVIEW_LIMITS,
} = require('../../../src/modules/reviews/review.constants');
const { createMemoryReviewRepository } = require('../../helpers/review-stubs');

const S = REVIEW_STATUSES;

const CUSTOMER = '507f1f77bcf86cd799439711';
const ADMIN = '507f1f77bcf86cd799439712';
const OTHER_ADMIN = '507f1f77bcf86cd799439713';
const PRODUCT_ID = '507f1f77bcf86cd799439714';
const INACTIVE_PRODUCT_ID = '507f1f77bcf86cd799439715';
const UNKNOWN_ID = '507f1f77bcf86cd799439716';
const REVIEW_ID = '507f1f77bcf86cd799439717';

function makeProduct(overrides = {}) {
  return {
    _id: PRODUCT_ID,
    name: 'Premium Abaya',
    slug: 'premium-abaya',
    isActive: true,
    ...overrides,
  };
}

function makeReview(overrides = {}) {
  return {
    _id: REVIEW_ID,
    productId: PRODUCT_ID,
    customerId: CUSTOMER,
    customerDisplayName: 'Amina Rahman',
    rating: 5,
    comment: 'Excellent',
    status: S.PENDING,
    statusHistory: [{ status: S.PENDING, at: new Date(), by: CUSTOMER, note: null }],
    approvedBy: null,
    approvedAt: null,
    rejectedBy: null,
    rejectedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createCapturingNotificationService() {
  const calls = [];
  return {
    calls,
    async notifyAdmin({ userId, eventType, data }) {
      calls.push({ userId, eventType, data });
      return null;
    },
  };
}

function createHarness({ products = [makeProduct()], reviews = [] } = {}) {
  const reviewRepo = createMemoryReviewRepository(reviews);
  const productRepository = {
    findById: async (id) =>
      products.find((p) => String(p._id) === String(id)) || null,
  };
  const notificationService = createCapturingNotificationService();
  const service = new ReviewService({
    reviewRepository: reviewRepo,
    productRepository,
    notificationService,
  });
  return { service, reviewRepo, productRepository, notificationService };
}

test('createReview persists the review as PENDING with the authenticated identity', async () => {
  const { service, reviewRepo } = createHarness();
  const review = await service.createReview({
    customerId: CUSTOMER,
    productId: PRODUCT_ID,
    customerDisplayName: 'Amina Rahman',
    value: { rating: 4, comment: 'Nice' },
  });

  assert.equal(review.status, S.PENDING);
  assert.equal(review.rating, 4);
  assert.equal(review.comment, 'Nice');
  assert.equal(review.customerId, undefined, 'customer id never leaks in customer view');
  assert.equal(reviewRepo.docs.length, 1);
  assert.equal(reviewRepo.docs[0].customerId, CUSTOMER);
  assert.equal(reviewRepo.docs[0].productId, PRODUCT_ID);
  assert.equal(reviewRepo.docs[0].status, S.PENDING);
  assert.equal(reviewRepo.docs[0].statusHistory[0].status, S.PENDING);
  assert.equal(reviewRepo.docs[0].statusHistory[0].by, CUSTOMER);
});

test('createReview raises an ADMIN_REVIEW_SUBMITTED notification with product/customer/rating', async () => {
  const { service, notificationService } = createHarness();
  const review = await service.createReview({
    customerId: CUSTOMER,
    productId: PRODUCT_ID,
    customerDisplayName: 'Amina Rahman',
    value: { rating: 5, comment: 'Excellent <b>fit</b>' },
  });

  const calls = notificationService.calls.filter(
    (call) => call.eventType === 'ADMIN_REVIEW_SUBMITTED'
  );
  assert.equal(calls.length, 1, 'exactly one admin notification per submitted review');
  const call = calls[0];
  assert.equal(call.userId, CUSTOMER);
  assert.equal(call.data.entityRef, review.id, 'entityRef correlates without being text');
  assert.equal(call.data.customerName, 'Amina Rahman');
  assert.equal(call.data.productName, 'Premium Abaya');
  assert.equal(call.data.rating, 5);
  assert.equal(call.data.comment, 'Excellent <b>fit</b>');
  assert.equal(call.data.customerId, undefined, 'raw customer id never leaves the service');
  assert.equal(call.data.productId, undefined, 'raw product id never leaves the service');

  const { notificationTemplates } = require('../../../src/modules/notifications/templates');
  const rendered = notificationTemplates['ADMIN_REVIEW_SUBMITTED'].render({ data: call.data });
  assert.match(rendered.title, /New review: Premium Abaya/);
  assert.match(rendered.message, /Amina Rahman rated Premium Abaya 5\/5/);
  assert.ok(!rendered.message.includes(review.id), 'no Mongo id in the notification text');
  assert.ok(!rendered.message.includes(PRODUCT_ID));
  assert.ok(!rendered.message.includes(CUSTOMER));
});

test('createReview rejects unknown or inactive products with PRODUCT_NOT_FOUND', async () => {
  const { service } = createHarness({
    products: [makeProduct({ _id: INACTIVE_PRODUCT_ID, isActive: false })],
  });

  for (const productId of [UNKNOWN_ID, INACTIVE_PRODUCT_ID]) {
    await assert.rejects(
      () =>
        service.createReview({
          customerId: CUSTOMER,
          productId,
          customerDisplayName: null,
          value: { rating: 5 },
        }),
      (err) => err.statusCode === 404 && err.code === ERROR_CODES.PRODUCT_NOT_FOUND
    );
  }
});

test('createReview normalizes and caps the customer display name snapshot', async () => {
  const { service, reviewRepo } = createHarness();
  await service.createReview({
    customerId: CUSTOMER,
    productId: PRODUCT_ID,
    customerDisplayName: `  ${'A'.repeat(REVIEW_LIMITS.DISPLAY_NAME_MAX + 10)}  `,
    value: { rating: 5 },
  });
  assert.equal(reviewRepo.docs[0].customerDisplayName.length, REVIEW_LIMITS.DISPLAY_NAME_MAX);
});

test('listProductReviews returns only APPROVED reviews with a rating summary', async () => {
  const { service } = createHarness({
    reviews: [
      makeReview({ _id: '507f1f77bcf86cd799439718', status: S.PENDING, rating: 1 }),
      makeReview({ _id: '507f1f77bcf86cd799439719', status: S.REJECTED, rating: 2 }),
      makeReview({ _id: '507f1f77bcf86cd799439720', status: S.APPROVED, rating: 5 }),
      makeReview({ _id: '507f1f77bcf86cd799439721', status: S.APPROVED, rating: 4 }),
    ],
  });

  const result = await service.listProductReviews({ productId: PRODUCT_ID, page: 1, limit: 20 });

  assert.equal(result.reviews.length, 2, 'only APPROVED reviews are returned');
  assert.ok(result.reviews.every((r) => r.status === undefined));
  assert.equal(result.summary.totalReviews, 2);
  assert.equal(result.summary.averageRating, 4.5);
  assert.deepEqual(result.summary.ratingBreakdown, { 5: 1, 4: 1 });
  assert.equal(result.pagination.total, 2);
});

test('listProductReviews returns an empty summary when nothing is approved', async () => {
  const { service } = createHarness({
    reviews: [makeReview({ status: S.PENDING })],
  });
  const result = await service.listProductReviews({ productId: PRODUCT_ID });
  assert.equal(result.reviews.length, 0);
  assert.equal(result.summary.totalReviews, 0);
  assert.equal(result.summary.averageRating, null);
});

test('listProductReviews rejects an inactive product', async () => {
  const { service } = createHarness({
    products: [makeProduct({ _id: INACTIVE_PRODUCT_ID, isActive: false })],
    reviews: [makeReview({ productId: INACTIVE_PRODUCT_ID, status: S.APPROVED })],
  });
  await assert.rejects(
    () => service.listProductReviews({ productId: INACTIVE_PRODUCT_ID }),
    (err) => err.code === ERROR_CODES.PRODUCT_NOT_FOUND
  );
});

test('approveReview moves PENDING → APPROVED and records the acting admin', async () => {
  const { service, reviewRepo } = createHarness({
    reviews: [makeReview({ status: S.PENDING })],
  });
  const review = await service.approveReview({ reviewId: REVIEW_ID, performedBy: ADMIN, note: 'ok' });

  assert.equal(review.status, S.APPROVED);
  assert.equal(review.approvedBy, ADMIN);
  assert.equal(review.rejectedBy, null);
  assert.equal(reviewRepo.docs[0].statusHistory.length, 2);
  assert.equal(reviewRepo.docs[0].statusHistory[1].status, S.APPROVED);
  assert.equal(reviewRepo.docs[0].statusHistory[1].by, ADMIN);
});

test('rejectReview moves PENDING → REJECTED and records the acting admin', async () => {
  const { service, reviewRepo } = createHarness({
    reviews: [makeReview({ status: S.PENDING })],
  });
  const review = await service.rejectReview({ reviewId: REVIEW_ID, performedBy: ADMIN });

  assert.equal(review.status, S.REJECTED);
  assert.equal(review.rejectedBy, ADMIN);
  assert.equal(reviewRepo.docs[0].statusHistory[1].status, S.REJECTED);
});

test('approve/reject are idempotent on their target state', async () => {
  const { service } = createHarness({
    reviews: [makeReview({ status: S.APPROVED, approvedBy: ADMIN })],
  });
  const approved = await service.approveReview({ reviewId: REVIEW_ID, performedBy: OTHER_ADMIN });
  assert.equal(approved.status, S.APPROVED);
  assert.equal(approved.approvedBy, ADMIN, 'no second transition on an approved review');
});

test('moderation reversal is forbidden: REJECTED cannot be approved, APPROVED cannot be rejected', async () => {
  const { service } = createHarness({
    reviews: [
      makeReview({ _id: '507f1f77bcf86cd799439722', status: S.REJECTED }),
      makeReview({ _id: '507f1f77bcf86cd799439723', status: S.APPROVED }),
    ],
  });
  await assert.rejects(
    () => service.approveReview({ reviewId: '507f1f77bcf86cd799439722', performedBy: ADMIN }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.REVIEW_INVALID_STATE
  );
  await assert.rejects(
    () => service.rejectReview({ reviewId: '507f1f77bcf86cd799439723', performedBy: ADMIN }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.REVIEW_INVALID_STATE
  );
});

test('approve/reject of an unknown review → 404 REVIEW_NOT_FOUND', async () => {
  const { service } = createHarness();
  await assert.rejects(
    () => service.approveReview({ reviewId: UNKNOWN_ID, performedBy: ADMIN }),
    (err) => err.statusCode === 404 && err.code === ERROR_CODES.REVIEW_NOT_FOUND
  );
  await assert.rejects(
    () => service.rejectReview({ reviewId: UNKNOWN_ID, performedBy: ADMIN }),
    (err) => err.statusCode === 404 && err.code === ERROR_CODES.REVIEW_NOT_FOUND
  );
});

test('getReview returns the admin view; unknown → 404', async () => {
  const { service } = createHarness({ reviews: [makeReview({ status: S.PENDING })] });
  const review = await service.getReview(REVIEW_ID);
  assert.equal(review.id, REVIEW_ID);
  assert.equal(review.customerId, CUSTOMER);

  await assert.rejects(
    () => service.getReview(UNKNOWN_ID),
    (err) => err.code === ERROR_CODES.REVIEW_NOT_FOUND
  );
});

test('listReviews supports status filtering for moderation', async () => {
  const { service } = createHarness({
    reviews: [
      makeReview({ _id: '507f1f77bcf86cd799439724', status: S.PENDING }),
      makeReview({ _id: '507f1f77bcf86cd799439725', status: S.APPROVED }),
      makeReview({ _id: '507f1f77bcf86cd799439726', status: S.REJECTED }),
    ],
  });

  const pending = await service.listReviews({ status: S.PENDING });
  assert.equal(pending.reviews.length, 1);
  assert.equal(pending.reviews[0].status, S.PENDING);
  assert.equal(pending.reviews[0].customerId, CUSTOMER);

  const all = await service.listReviews({});
  assert.equal(all.reviews.length, 3);
  assert.equal(all.pagination.total, 3);
});
