'use strict';

process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createReviewRouter } = require('../../src/modules/reviews/review.routes');
const { createAdminReviewRouter } = require('../../src/modules/reviews/adminReview.routes');
const { ReviewService } = require('../../src/modules/reviews/review.service');
const { createMemoryReviewRepository } = require('../../tests/helpers/review-stubs');
const { UserService } = require('../../src/modules/users/user.service');
const {
  ROLES,
  ACCOUNT_STATUSES,
  ERROR_CODES,
} = require('../../src/constants');
const { REVIEW_STATUSES } = require('../../src/modules/reviews/review.constants');
const notFound = require('../../src/middlewares/notFound');
const errorHandler = require('../../src/middlewares/errorHandler');
const { createJwtVerifier } = require('../../src/integrations/auth/jwtVerifier');
const { createKeyPair, signToken } = require('../../tests/helpers/jwt-fixtures');

const ISSUER = 'taqwa-frontend';
const AUDIENCE = 'taqwa-backend';
const ALGORITHMS = ['RS256'];

const PRODUCT_ID = '507f1f77bcf86cd799439201';
const INACTIVE_PRODUCT_ID = '507f1f77bcf86cd799439202';
const UNKNOWN_PRODUCT_ID = '507f1f77bcf86cd799439203';
const REVIEW_ID = '507f1f77bcf86cd799439204';

const CUSTOMER_ID = '507f1f77bcf86cd799439205';
const ADMIN_ID = '507f1f77bcf86cd799439206';

const S = REVIEW_STATUSES;

function productDoc(overrides = {}) {
  return {
    _id: PRODUCT_ID,
    name: 'Premium Abaya',
    slug: 'premium-abaya',
    isActive: true,
    ...overrides,
  };
}

function reviewDoc(overrides = {}) {
  return {
    _id: REVIEW_ID,
    productId: PRODUCT_ID,
    customerId: CUSTOMER_ID,
    customerDisplayName: 'Amina Rahman',
    rating: 5,
    comment: 'Beautiful quality',
    status: S.PENDING,
    statusHistory: [{ status: S.PENDING, at: new Date(), by: CUSTOMER_ID, note: null }],
    approvedBy: null,
    approvedAt: null,
    rejectedBy: null,
    rejectedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function userDoc(overrides = {}) {
  const authProviderId = overrides.authProviderId || 'auth-customer-1';
  const ids = {
    'auth-customer-1': CUSTOMER_ID,
    'auth-staff-1': '507f1f77bcf86cd799439207',
    'auth-admin-1': ADMIN_ID,
  };
  return {
    _id: ids[authProviderId] || authProviderId,
    authProviderId,
    email: 'amina@example.com',
    displayName: 'Amina Rahman',
    phone: '+8801712345678',
    role: ROLES.CUSTOMER,
    status: ACCOUNT_STATUSES.ACTIVE,
    ...overrides,
  };
}

function createStubUserRepository(users) {
  return {
    findByAuthProviderId: async (authProviderId) =>
      users.find((u) => u.authProviderId === authProviderId) || null,
    create: async (data) => {
      const created = { _id: `generated-${data.authProviderId}`, ...data };
      users.push(created);
      return created;
    },
  };
}

function seedUsers() {
  return [
    userDoc(),
    userDoc({
      authProviderId: 'auth-staff-1',
      email: 'staff@example.com',
      displayName: 'Staff Person',
      role: ROLES.STAFF,
    }),
    userDoc({
      authProviderId: 'auth-admin-1',
      email: 'admin@example.com',
      displayName: 'Admin Person',
      role: ROLES.ADMIN,
    }),
  ];
}

function buildApp({ users, products = [], reviews = [], verifier: appVerifier } = {}) {
  const effectiveVerifier = appVerifier || verifier;
  const userService = new UserService({
    repository: createStubUserRepository(users),
    autoProvisionCustomers: true,
  });
  const reviewRepo = createMemoryReviewRepository(reviews);
  const productRepository = {
    findById: async (id) =>
      products.find((p) => String(p._id) === String(id)) || null,
  };
  const reviewService = new ReviewService({
    reviewRepository: reviewRepo,
    productRepository,
  });

  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/products',
    createReviewRouter({ reviewService, userService, verifier: effectiveVerifier })
  );
  app.use(
    '/api/v1/admin/reviews',
    createAdminReviewRouter({ reviewService, userService, verifier: effectiveVerifier })
  );
  app.use(notFound);
  app.use(errorHandler);

  return { app, repos: { reviewRepo } };
}

function withServer(build, fn) {
  return async () => {
    const { app, repos } = build();
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    try {
      await fn(`http://127.0.0.1:${port}`, repos);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

function request(method, url, token, body) {
  return fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

let verifier;
let tokenCustomer;
let tokenStaff;
let tokenAdmin;
let tokenAdminClaimSpoof;

before(async () => {
  const { privateKey, publicJwk } = await createKeyPair();
  verifier = createJwtVerifier({
    keys: [publicJwk],
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ALGORITHMS,
  });

  tokenCustomer = await signToken({
    privateKey,
    subject: 'auth-customer-1',
    claims: { email: 'amina@example.com', name: 'Amina Rahman' },
  });
  tokenStaff = await signToken({
    privateKey,
    subject: 'auth-staff-1',
    claims: { email: 'staff@example.com', name: 'Staff Person' },
  });
  tokenAdmin = await signToken({
    privateKey,
    subject: 'auth-admin-1',
    claims: { email: 'admin@example.com', name: 'Admin Person' },
  });
  tokenAdminClaimSpoof = await signToken({
    privateKey,
    subject: 'auth-customer-1',
    claims: { role: 'ADMIN', email: 'amina@example.com', name: 'Amina Rahman' },
  });
});

test('public GET reviews requires no auth and exposes only APPROVED', withServer(
  () =>
    buildApp({
      users: seedUsers(),
      products: [productDoc()],
      reviews: [
        reviewDoc({ _id: '507f1f77bcf86cd799439208', status: S.APPROVED, rating: 5 }),
        reviewDoc({ _id: '507f1f77bcf86cd799439209', status: S.PENDING, rating: 3 }),
        reviewDoc({ _id: '507f1f77bcf86cd799439210', status: S.REJECTED, rating: 1 }),
      ],
    }),
  async (baseUrl) => {
    const res = await request('GET', `${baseUrl}/api/v1/products/${PRODUCT_ID}/reviews`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.reviews.length, 1, 'only APPROVED reviews are public');
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes('PENDING') && !raw.includes('REJECTED'), 'moderation state never leaks');
    assert.ok(!raw.includes('customerId'), 'customer identity never leaks publicly');
    assert.equal(body.data.summary.totalReviews, 1);
    assert.equal(body.data.summary.averageRating, 5);
    assert.deepEqual(body.data.summary.ratingBreakdown, { 5: 1 });
  }
));

test('public GET reviews for an unknown or inactive product → 404 PRODUCT_NOT_FOUND', withServer(
  () =>
    buildApp({
      users: seedUsers(),
      products: [productDoc({ _id: INACTIVE_PRODUCT_ID, isActive: false })],
    }),
  async (baseUrl) => {
    for (const productId of [UNKNOWN_PRODUCT_ID, INACTIVE_PRODUCT_ID]) {
      const res = await request('GET', `${baseUrl}/api/v1/products/${productId}/reviews`);
      assert.equal(res.status, 404, `product ${productId}`);
      assert.equal((await res.json()).error.code, ERROR_CODES.PRODUCT_NOT_FOUND);
    }
  }
));

test('POST reviews requires a CUSTOMER (401 unauthenticated, 403 for staff)', withServer(
  () => buildApp({ users: seedUsers(), products: [productDoc()] }),
  async (baseUrl) => {
    const base = `${baseUrl}/api/v1/products/${PRODUCT_ID}/reviews`;

    const anon = await request('POST', base, null, { rating: 5 });
    assert.equal(anon.status, 401);

    const staff = await request('POST', base, tokenStaff, { rating: 5 });
    assert.equal(staff.status, 403);
    assert.equal((await staff.json()).error.code, ERROR_CODES.FORBIDDEN);
  }
));

test('POST reviews creates a PENDING review from the authenticated identity only', withServer(
  () => buildApp({ users: seedUsers(), products: [productDoc()] }),
  async (baseUrl, { reviewRepo }) => {
    const res = await request(
      'POST',
      `${baseUrl}/api/v1/products/${PRODUCT_ID}/reviews`,
      tokenCustomer,
      { rating: 4, comment: 'Great abaya' }
    );
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.data.review.status, S.PENDING);
    assert.equal(body.data.review.rating, 4);
    assert.equal(body.data.review.comment, 'Great abaya');

    const doc = reviewRepo.docs[0];
    assert.equal(doc.customerId, CUSTOMER_ID, 'identity always from the token, never the body');
    assert.equal(doc.status, S.PENDING, 'status can never be forced');
    assert.equal(doc.productId, PRODUCT_ID);
    assert.equal(doc.customerDisplayName, 'Amina Rahman');
  }
));

test('POST reviews rejects spoofed identity/status fields in the body (400)', withServer(
  () => buildApp({ users: seedUsers(), products: [productDoc()] }),
  async (baseUrl, { reviewRepo }) => {
    const res = await request(
      'POST',
      `${baseUrl}/api/v1/products/${PRODUCT_ID}/reviews`,
      tokenCustomer,
      { rating: 4, comment: 'Great abaya', customerId: 'attacker', status: 'APPROVED', approvedBy: 'admin' }
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, ERROR_CODES.INVALID_REVIEW);
    assert.equal(reviewRepo.docs.length, 0, 'nothing is persisted when the body is rejected');
  }
));

test('POST reviews rejects invalid ratings and unknown fields (400 INVALID_REVIEW)', withServer(
  () => buildApp({ users: seedUsers(), products: [productDoc()] }),
  async (baseUrl) => {
    const base = `${baseUrl}/api/v1/products/${PRODUCT_ID}/reviews`;
    for (const payload of [
      { rating: 0 },
      { rating: 6 },
      { rating: 3.5 },
      {},
      { rating: 5, $set: { status: 'APPROVED' } },
    ]) {
      const res = await request('POST', base, tokenCustomer, payload);
      assert.equal(res.status, 400, JSON.stringify(payload));
      assert.equal((await res.json()).error.code, ERROR_CODES.INVALID_REVIEW);
    }
  }
));

test('admin moderation: PENDING → APPROVED and the review becomes public', withServer(
  () =>
    buildApp({
      users: seedUsers(),
      products: [productDoc()],
      reviews: [reviewDoc({ status: S.PENDING })],
    }),
  async (baseUrl) => {
    const approved = await request(
      'POST',
      `${baseUrl}/api/v1/admin/reviews/${REVIEW_ID}/approve`,
      tokenAdmin,
      { note: 'verified' }
    );
    assert.equal(approved.status, 200);
    const approvedBody = await approved.json();
    assert.equal(approvedBody.data.review.status, S.APPROVED);
    assert.equal(approvedBody.data.review.approvedBy, ADMIN_ID);

    const publicList = await request('GET', `${baseUrl}/api/v1/products/${PRODUCT_ID}/reviews`);
    const publicBody = await publicList.json();
    assert.equal(publicBody.data.reviews.length, 1, 'approved review now visible publicly');
  }
));

test('admin moderation: PENDING → REJECTED stays hidden forever', withServer(
  () =>
    buildApp({
      users: seedUsers(),
      products: [productDoc()],
      reviews: [reviewDoc({ status: S.PENDING })],
    }),
  async (baseUrl) => {
    const rejected = await request(
      'POST',
      `${baseUrl}/api/v1/admin/reviews/${REVIEW_ID}/reject`,
      tokenAdmin,
      { note: 'spam' }
    );
    assert.equal(rejected.status, 200);
    const body = await rejected.json();
    assert.equal(body.data.review.status, S.REJECTED);
    assert.equal(body.data.review.rejectedBy, ADMIN_ID);

    const publicList = await request('GET', `${baseUrl}/api/v1/products/${PRODUCT_ID}/reviews`);
    assert.equal((await publicList.json()).data.reviews.length, 0, 'rejected stays hidden');
  }
));

test('moderation reversal is forbidden: APPROVED cannot be rejected (409)', withServer(
  () =>
    buildApp({
      users: seedUsers(),
      products: [productDoc()],
      reviews: [reviewDoc({ status: S.APPROVED, approvedBy: ADMIN_ID })],
    }),
  async (baseUrl) => {
    const res = await request(
      'POST',
      `${baseUrl}/api/v1/admin/reviews/${REVIEW_ID}/reject`,
      tokenAdmin
    );
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, ERROR_CODES.REVIEW_INVALID_STATE);
  }
));

test('admin moderation is ADMIN-only; STAFF and CUSTOMER are forbidden', withServer(
  () =>
    buildApp({
      users: seedUsers(),
      products: [productDoc()],
      reviews: [reviewDoc({ status: S.PENDING })],
    }),
  async (baseUrl) => {
    for (const token of [tokenCustomer, tokenStaff]) {
      const res = await request(
        'POST',
        `${baseUrl}/api/v1/admin/reviews/${REVIEW_ID}/approve`,
        token
      );
      assert.equal(res.status, 403);
      assert.equal((await res.json()).error.code, ERROR_CODES.FORBIDDEN);
    }
    const spoof = await request(
      'POST',
      `${baseUrl}/api/v1/admin/reviews/${REVIEW_ID}/approve`,
      tokenAdminClaimSpoof
    );
    assert.equal(spoof.status, 403, 'role comes from the stored User, not the token claim');
  }
));

test('admin list/get review exposes the full moderation view and filters by status', withServer(
  () =>
    buildApp({
      users: seedUsers(),
      products: [productDoc()],
      reviews: [
        reviewDoc({ _id: '507f1f77bcf86cd799439208', status: S.PENDING, rating: 4 }),
        reviewDoc({ _id: '507f1f77bcf86cd799439209', status: S.APPROVED, rating: 5 }),
      ],
    }),
  async (baseUrl) => {
    const pending = await request('GET', `${baseUrl}/api/v1/admin/reviews?status=PENDING`, tokenAdmin);
    assert.equal(pending.status, 200);
    const pendingBody = await pending.json();
    assert.equal(pendingBody.data.reviews.length, 1);
    assert.equal(pendingBody.data.reviews[0].status, S.PENDING);
    assert.equal(pendingBody.data.reviews[0].customerId, CUSTOMER_ID);

    const badStatus = await request('GET', `${baseUrl}/api/v1/admin/reviews?status=PAID`, tokenAdmin);
    assert.equal(badStatus.status, 400);
    assert.equal((await badStatus.json()).error.code, ERROR_CODES.INVALID_REVIEW_STATUS);

    const detail = await request('GET', `${baseUrl}/api/v1/admin/reviews/507f1f77bcf86cd799439208`, tokenAdmin);
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).data.review.rating, 4);

    const missing = await request('GET', `${baseUrl}/api/v1/admin/reviews/507f1f77bcf86cd799439999`, tokenAdmin);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, ERROR_CODES.REVIEW_NOT_FOUND);
  }
));
