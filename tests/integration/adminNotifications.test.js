'use strict';

process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createAdminNotificationRouter } = require('../../src/modules/notifications/adminNotification.routes');
const { NotificationService } = require('../../src/modules/notifications/notification.service');
const { createMemoryNotificationRepository } = require('../../tests/helpers/notification-stubs');
const { createMemoryUserRepository } = require('../../tests/helpers/customer-stubs');
const { UserService } = require('../../src/modules/users/user.service');
const {
  ROLES,
  ACCOUNT_STATUSES,
  ERROR_CODES,
} = require('../../src/constants');
const { NOTIFICATION_STATUSES } = require('../../src/modules/notifications/notification.constants');
const notFound = require('../../src/middlewares/notFound');
const errorHandler = require('../../src/middlewares/errorHandler');
const { createJwtVerifier } = require('../../src/integrations/auth/jwtVerifier');
const { createKeyPair, signToken } = require('../../tests/helpers/jwt-fixtures');

const ISSUER = 'taqwa-frontend';
const AUDIENCE = 'taqwa-backend';
const ALGORITHMS = ['RS256'];

const CUSTOMER_ID = '507f1f77bcf86cd799439201';
const STAFF_ID = '507f1f77bcf86cd799439202';
const ADMIN_ID = '507f1f77bcf86cd799439203';
const NOTIFICATION_ID = '507f1f77bcf86cd799439204';
const UNKNOWN_ID = '507f1f77bcf86cd799439999';

const S = NOTIFICATION_STATUSES;

function notificationDoc(overrides = {}) {
  return {
    _id: NOTIFICATION_ID,
    recipient: CUSTOMER_ID,
    channel: 'EMAIL',
    eventType: 'ORDER_PLACED',
    templateKey: 'order-placed',
    entityRef: 'TAQ-1001',
    payload: { orderNumber: 'TAQ-1001' },
    status: S.SENT,
    attempts: 1,
    lastAttemptAt: new Date(),
    lastError: null,
    provider: 'mock',
    providerRef: 'mock-message-1',
    deliveredAt: new Date(),
    createdAt: new Date('2026-01-02T10:00:00Z'),
    updatedAt: new Date('2026-01-02T10:00:00Z'),
    ...overrides,
  };
}

function seedNotifications() {
  return [
    notificationDoc(),
    notificationDoc({
      _id: '507f1f77bcf86cd799439205',
      entityRef: 'TAQ-1002',
      status: S.QUEUED,
      attempts: 0,
      deliveredAt: null,
    }),
    notificationDoc({
      _id: '507f1f77bcf86cd799439206',
      entityRef: 'TAQ-1003',
      eventType: 'PAYMENT_VERIFIED',
      status: S.FAILED,
      lastError: { code: 'EMAIL_SEND_FAILED', message: 'provider down' },
    }),
    notificationDoc({
      _id: '507f1f77bcf86cd799439207',
      recipient: CUSTOMER_ID,
      channel: 'ADMIN',
      eventType: 'ADMIN_ORDER_PLACED',
      templateKey: 'ADMIN_ORDER_PLACED',
      entityRef: '507f1f77bcf86cd799439208',
      payload: {
        title: 'New order TAQ-1004',
        message: 'Amina Rahman placed an order TAQ-1004 with 2 items (total \u09F32,480.00, payment: COD).',
      },
      status: S.SENT,
      attempts: 1,
      deliveredAt: new Date('2026-01-03T09:00:00Z'),
      createdAt: new Date('2026-01-03T09:00:00Z'),
      updatedAt: new Date('2026-01-03T09:00:00Z'),
    }),
  ];
}

function seedUsers() {
  return [
    {
      _id: CUSTOMER_ID,
      authProviderId: 'auth-customer-1',
      email: 'amina@example.com',
      displayName: 'Amina Rahman',
      role: ROLES.CUSTOMER,
      status: ACCOUNT_STATUSES.ACTIVE,
    },
    {
      _id: STAFF_ID,
      authProviderId: 'auth-staff-1',
      email: 'staff@example.com',
      displayName: 'Staff Person',
      role: ROLES.STAFF,
      status: ACCOUNT_STATUSES.ACTIVE,
    },
    {
      _id: ADMIN_ID,
      authProviderId: 'auth-admin-1',
      email: 'admin@example.com',
      displayName: 'Admin Person',
      role: ROLES.ADMIN,
      status: ACCOUNT_STATUSES.ACTIVE,
    },
  ];
}

function buildApp({ notifications = seedNotifications(), verifier: appVerifier } = {}) {
  const effectiveVerifier = appVerifier || verifier;
  const userService = new UserService({
    repository: createMemoryUserRepository(seedUsers()),
    autoProvisionCustomers: true,
  });
  const notificationService = new NotificationService({
    notificationRepository: createMemoryNotificationRepository(notifications),
    userRepository: createMemoryUserRepository(seedUsers()),
    enabled: true,
  });

  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/admin/notifications',
    createAdminNotificationRouter({ notificationService, userService, verifier: effectiveVerifier })
  );
  app.use(notFound);
  app.use(errorHandler);

  return { app };
}

function withServer(build, fn) {
  return async () => {
    const { app } = build();
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    try {
      await fn(`http://127.0.0.1:${port}`);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

function request(method, url, token) {
  return fetch(url, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
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

test('admin notifications is ADMIN-only (401 anonymous, 403 customer/staff and spoofed role claim)', withServer(
  () => buildApp(),
  async (baseUrl) => {
    const anon = await request('GET', `${baseUrl}/api/v1/admin/notifications`);
    assert.equal(anon.status, 401);

    for (const token of [tokenCustomer, tokenStaff, tokenAdminClaimSpoof]) {
      const res = await request('GET', `${baseUrl}/api/v1/admin/notifications`, token);
      assert.equal(res.status, 403, 'role comes from the stored User, not the token claim');
      assert.equal((await res.json()).error.code, ERROR_CODES.FORBIDDEN);
    }
  }
));

test('admin notifications list returns the safe serializer shape and pagination', withServer(
  () => buildApp(),
  async (baseUrl) => {
    const res = await request('GET', `${baseUrl}/api/v1/admin/notifications?page=1&limit=2`, tokenAdmin);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.notifications.length, 2);
    assert.equal(body.data.pagination.page, 1);
    assert.equal(body.data.pagination.limit, 2);
    assert.equal(body.data.pagination.total, 4);
    assert.equal(body.data.pagination.totalPages, 2);

    const raw = JSON.stringify(body);
    assert.ok(!raw.includes('payload'), 'the internal payload snapshot never leaves the backend');
    const first = body.data.notifications[0];
    assert.equal(first.eventType, 'ADMIN_ORDER_PLACED');
    assert.equal(first.channel, 'ADMIN');
    assert.equal(first.status, S.SENT);
    assert.equal(first.recipient, CUSTOMER_ID);
    assert.equal(first.entityRef, '507f1f77bcf86cd799439208');
    assert.match(first.title, /New order TAQ-1004/);
    assert.match(first.message, /Amina Rahman placed an order TAQ-1004/);
    assert.ok(!first.title.includes('507f1f77'), 'no Mongo id in the notification title');
    assert.ok(!first.message.includes('507f1f77'), 'no Mongo id in the notification message');
  }
));

test('admin notifications list filters by status and eventType', withServer(
  () => buildApp(),
  async (baseUrl) => {
    const failed = await request('GET', `${baseUrl}/api/v1/admin/notifications?status=FAILED`, tokenAdmin);
    assert.equal(failed.status, 200);
    const failedBody = await failed.json();
    assert.equal(failedBody.data.notifications.length, 1);
    assert.equal(failedBody.data.notifications[0].status, S.FAILED);
    assert.ok(failedBody.data.notifications[0].lastError, 'delivery error visible to admins');

    const verified = await request('GET', `${baseUrl}/api/v1/admin/notifications?eventType=PAYMENT_VERIFIED`, tokenAdmin);
    assert.equal(verified.status, 200);
    assert.equal((await verified.json()).data.notifications.length, 1);

    const adminOrder = await request('GET', `${baseUrl}/api/v1/admin/notifications?eventType=ADMIN_ORDER_PLACED`, tokenAdmin);
    assert.equal(adminOrder.status, 200);
    const adminBody = await adminOrder.json();
    assert.equal(adminBody.data.notifications.length, 1);
    assert.match(adminBody.data.notifications[0].title, /New order/);
  }
));

test('admin notifications list rejects unknown status/eventType (400)', withServer(
  () => buildApp(),
  async (baseUrl) => {
    const badStatus = await request('GET', `${baseUrl}/api/v1/admin/notifications?status=DRAFT`, tokenAdmin);
    assert.equal(badStatus.status, 400);
    assert.equal((await badStatus.json()).error.code, ERROR_CODES.INVALID_NOTIFICATION_STATUS);

    const badEvent = await request('GET', `${baseUrl}/api/v1/admin/notifications?eventType=UNKNOWN_EVENT`, tokenAdmin);
    assert.equal(badEvent.status, 400);
    assert.equal((await badEvent.json()).error.code, ERROR_CODES.INVALID_NOTIFICATION_EVENT_TYPE);
  }
));

test('admin notifications detail returns one notification; unknown id → 404', withServer(
  () => buildApp(),
  async (baseUrl) => {
    const detail = await request('GET', `${baseUrl}/api/v1/admin/notifications/${NOTIFICATION_ID}`, tokenAdmin);
    assert.equal(detail.status, 200);
    const detailBody = await detail.json();
    assert.equal(detailBody.data.notification.id, NOTIFICATION_ID);
    assert.equal(detailBody.data.notification.entityRef, 'TAQ-1001');
    assert.ok(!JSON.stringify(detailBody).includes('payload'), 'payload never serialized');

    const missing = await request('GET', `${baseUrl}/api/v1/admin/notifications/${UNKNOWN_ID}`, tokenAdmin);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, ERROR_CODES.NOTIFICATION_NOT_FOUND);

    const malformed = await request('GET', `${baseUrl}/api/v1/admin/notifications/not-an-id`, tokenAdmin);
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, ERROR_CODES.INVALID_NOTIFICATION);
  }
));
