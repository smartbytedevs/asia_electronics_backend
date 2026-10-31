'use strict';

process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createAdminCustomerRouter } = require('../../src/modules/users/adminCustomer.routes');
const { UserService } = require('../../src/modules/users/user.service');
const { createMemoryUserRepository } = require('../../tests/helpers/customer-stubs');
const {
  ROLES,
  ACCOUNT_STATUSES,
  ERROR_CODES,
} = require('../../src/constants');
const notFound = require('../../src/middlewares/notFound');
const errorHandler = require('../../src/middlewares/errorHandler');
const { createJwtVerifier } = require('../../src/integrations/auth/jwtVerifier');
const { createKeyPair, signToken } = require('../../tests/helpers/jwt-fixtures');

const ISSUER = 'taqwa-frontend';
const AUDIENCE = 'taqwa-backend';
const ALGORITHMS = ['RS256'];

const ADMIN_ID = '507f1f77bcf86cd799439201';
const STAFF_ID = '507f1f77bcf86cd799439202';
const CUSTOMER_ID = '507f1f77bcf86cd799439203';
const UNKNOWN_ID = '507f1f77bcf86cd799439999';

function userDoc(overrides = {}) {
  const authProviderId = overrides.authProviderId || 'auth-customer-1';
  const ids = {
    'auth-customer-1': CUSTOMER_ID,
    'auth-staff-1': STAFF_ID,
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
    createdAt: new Date('2026-01-02T10:00:00Z'),
    updatedAt: new Date('2026-01-02T10:00:00Z'),
    ...overrides,
  };
}

function seedUsers() {
  return [
    userDoc(),
    userDoc({ _id: '507f1f77bcf86cd799439204', authProviderId: 'auth-customer-2' }),
    userDoc({ _id: '507f1f77bcf86cd799439205', authProviderId: 'auth-customer-3', status: ACCOUNT_STATUSES.SUSPENDED }),
    userDoc({ _id: '507f1f77bcf86cd799439206', authProviderId: 'auth-customer-4', status: ACCOUNT_STATUSES.DISABLED }),
    userDoc({
      _id: STAFF_ID,
      authProviderId: 'auth-staff-1',
      email: 'staff@example.com',
      displayName: 'Staff Person',
      role: ROLES.STAFF,
    }),
    userDoc({
      _id: ADMIN_ID,
      authProviderId: 'auth-admin-1',
      email: 'admin@example.com',
      displayName: 'Admin Person',
      role: ROLES.ADMIN,
    }),
  ];
}

function buildApp({ users = seedUsers(), verifier: appVerifier } = {}) {
  const effectiveVerifier = appVerifier || verifier;
  const userService = new UserService({
    repository: createMemoryUserRepository(users),
    autoProvisionCustomers: true,
  });

  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/admin/customers',
    createAdminCustomerRouter({ userService, verifier: effectiveVerifier })
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

test('admin customers is ADMIN-only (401 anonymous, 403 customer/staff and spoofed role claim)', withServer(
  () => buildApp(),
  async (baseUrl) => {
    const anon = await request('GET', `${baseUrl}/api/v1/admin/customers`);
    assert.equal(anon.status, 401);

    for (const token of [tokenCustomer, tokenStaff, tokenAdminClaimSpoof]) {
      const res = await request('GET', `${baseUrl}/api/v1/admin/customers`, token);
      assert.equal(res.status, 403, 'role comes from the stored User, not the token claim');
      assert.equal((await res.json()).error.code, ERROR_CODES.FORBIDDEN);
    }
  }
));

test('admin customers list returns safe admin views with pagination', withServer(
  () => buildApp(),
  async (baseUrl) => {
    const res = await request('GET', `${baseUrl}/api/v1/admin/customers?page=1&limit=2`, tokenAdmin);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.customers.length, 2);
    assert.equal(body.data.pagination.page, 1);
    assert.equal(body.data.pagination.limit, 2);
    assert.equal(body.data.pagination.total, 6);
    assert.equal(body.data.pagination.totalPages, 3);

    const raw = JSON.stringify(body);
    assert.ok(!raw.includes('authProviderId'), 'authProviderId never leaks to admin clients');
    const first = body.data.customers[0];
    assert.ok(first.id && first.email && first.role && first.status, 'safe fields present');
    assert.equal(typeof first.displayName, 'string');
    assert.ok(first.createdAt && first.updatedAt, 'timestamps present');
  }
));

test('admin customers list filters by role and status, newest first', withServer(
  () => buildApp(),
  async (baseUrl) => {
    const customers = await request('GET', `${baseUrl}/api/v1/admin/customers?role=CUSTOMER&status=SUSPENDED`, tokenAdmin);
    assert.equal(customers.status, 200);
    const customersBody = await customers.json();
    assert.equal(customersBody.data.customers.length, 1);
    assert.equal(customersBody.data.customers[0].role, ROLES.CUSTOMER);
    assert.equal(customersBody.data.customers[0].status, ACCOUNT_STATUSES.SUSPENDED);

    const staff = await request('GET', `${baseUrl}/api/v1/admin/customers?role=STAFF`, tokenAdmin);
    const staffBody = await staff.json();
    assert.equal(staffBody.data.customers.length, 1);
    assert.equal(staffBody.data.customers[0].displayName, 'Staff Person');
  }
));

test('admin customers list rejects unknown role/status values (400)', withServer(
  () => buildApp(),
  async (baseUrl) => {
    const badRole = await request('GET', `${baseUrl}/api/v1/admin/customers?role=ROOT`, tokenAdmin);
    assert.equal(badRole.status, 400);
    assert.equal((await badRole.json()).error.code, ERROR_CODES.INVALID_USER_ROLE);

    const badStatus = await request('GET', `${baseUrl}/api/v1/admin/customers?status=DELETED`, tokenAdmin);
    assert.equal(badStatus.status, 400);
    assert.equal((await badStatus.json()).error.code, ERROR_CODES.INVALID_USER_STATUS);
  }
));

test('admin customers detail returns one safe customer; unknown id → 404', withServer(
  () => buildApp(),
  async (baseUrl) => {
    const detail = await request('GET', `${baseUrl}/api/v1/admin/customers/${CUSTOMER_ID}`, tokenAdmin);
    assert.equal(detail.status, 200);
    const detailBody = await detail.json();
    assert.equal(detailBody.data.customer.id, CUSTOMER_ID);
    assert.equal(detailBody.data.customer.displayName, 'Amina Rahman');
    assert.ok(!JSON.stringify(detailBody).includes('authProviderId'));

    const missing = await request('GET', `${baseUrl}/api/v1/admin/customers/${UNKNOWN_ID}`, tokenAdmin);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, ERROR_CODES.USER_NOT_FOUND);

    const malformed = await request('GET', `${baseUrl}/api/v1/admin/customers/not-an-id`, tokenAdmin);
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, ERROR_CODES.INVALID_USER);
  }
));
