'use strict';

process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createUserRouter } = require('../../src/modules/users/user.routes');
const { UserService } = require('../../src/modules/users/user.service');
const { ROLES, ACCOUNT_STATUSES } = require('../../src/constants');
const notFound = require('../../src/middlewares/notFound');
const errorHandler = require('../../src/middlewares/errorHandler');
const { createJwtVerifier } = require('../../src/integrations/auth/jwtVerifier');
const { createKeyPair, signToken } = require('../../tests/helpers/jwt-fixtures');

const ISSUER = 'taqwa-frontend';
const AUDIENCE = 'taqwa-backend';
const ALGORITHMS = ['RS256'];

const MESSAGES = {
  PROFILE_FETCHED: 'User profile retrieved successfully',
  UNAUTHORIZED: 'Authentication required',
  ACCOUNT_NOT_FOUND: 'User account not found',
  ACCOUNT_SUSPENDED: 'Account is suspended',
};

function userDoc(overrides = {}) {
  return {
    _id: '507f1f77bcf86cd799439011',
    authProviderId: 'auth-customer-1',
    email: 'amina@example.com',
    displayName: 'Amina Rahman',
    phone: '+8801712345678',
    role: ROLES.CUSTOMER,
    status: ACCOUNT_STATUSES.ACTIVE,
    ...overrides,
  };
}

/**
 * Real service + real repository interface (in-memory stub): exercises the
 * production chain  authenticate → resolveCurrentUser → controller.getMe
 * over a real HTTP server. Only JWT keys and the user store are test doubles.
 */
function createStubRepository(users) {
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

function buildApp(users, autoProvisionCustomers, verifier) {
  const service = new UserService({
    repository: createStubRepository(users),
    autoProvisionCustomers,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createUserRouter({ userService: service, verifier }));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

function withServer(getApp, fn) {
  return async () => {
    const server = getApp().listen(0);
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

let verifier;
let tokenCustomer;
let tokenExpired;
let tokenUnknown;
let tokenAdminClaim;

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
  tokenUnknown = await signToken({
    privateKey,
    subject: 'auth-never-seen',
    claims: { email: 'new@example.com', name: 'New Person' },
  });
  tokenExpired = await signToken({
    privateKey,
    subject: 'auth-customer-1',
    claims: {},
    expiresIn: Math.floor(Date.now() / 1000) - 3600,
  });
  tokenAdminClaim = await signToken({
    privateKey,
    subject: 'auth-customer-1',
    claims: { role: 'ADMIN', email: 'amina@example.com' },
  });
});

test('missing Authorization header → 401', withServer(() => buildApp([], true, verifier), async (baseUrl) => {
  const res = await fetch(`${baseUrl}/api/v1/me`);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(body.message, MESSAGES.UNAUTHORIZED);
  assert.equal(body.error.code, 'UNAUTHORIZED');
}));

test('invalid token → 401', withServer(() => buildApp([], true, verifier), async (baseUrl) => {
  const res = await fetch(`${baseUrl}/api/v1/me`, {
    headers: { Authorization: 'Bearer not.a.jwt' },
  });
  assert.equal(res.status, 401);
}));

test('expired token → 401', withServer(() => buildApp([], true, verifier), async (baseUrl) => {
  const res = await fetch(`${baseUrl}/api/v1/me`, {
    headers: { Authorization: `Bearer ${tokenExpired}` },
  });
  assert.equal(res.status, 401);
}));

test('valid token + existing user → 200 with safe profile', withServer(() => buildApp([userDoc()], true, verifier), async (baseUrl) => {
  const res = await fetch(`${baseUrl}/api/v1/me`, {
    headers: { Authorization: `Bearer ${tokenCustomer}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.message, MESSAGES.PROFILE_FETCHED);
  assert.deepEqual(body.data.user, {
    id: '507f1f77bcf86cd799439011',
    email: 'amina@example.com',
    displayName: 'Amina Rahman',
    phone: '+8801712345678',
    role: ROLES.CUSTOMER,
    status: ACCOUNT_STATUSES.ACTIVE,
  });
}));

test('valid token + existing user → authProviderId and internals never leak', withServer(() => buildApp([userDoc()], true, verifier), async (baseUrl) => {
  const res = await fetch(`${baseUrl}/api/v1/me`, {
    headers: { Authorization: `Bearer ${tokenCustomer}` },
  });
  const raw = await res.text();
  assert.ok(!raw.includes('authProviderId'), 'authProviderId is never serialized');
  assert.ok(!raw.includes('_id'), 'raw _id is never serialized');
  assert.ok(!raw.includes('__v'), 'version key is never serialized');
}));

test('unknown user with auto-provisioning → 200 and provisioned as CUSTOMER', withServer(() => buildApp([], true, verifier), async (baseUrl) => {
  const res = await fetch(`${baseUrl}/api/v1/me`, {
    headers: { Authorization: `Bearer ${tokenUnknown}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.user.role, ROLES.CUSTOMER);
  assert.equal(body.data.user.email, 'new@example.com');
  assert.equal(body.data.user.displayName, 'New Person');
  assert.equal(body.data.user.status, ACCOUNT_STATUSES.ACTIVE);
}));

test('unknown user without auto-provisioning → 403', withServer(() => buildApp([], false, verifier), async (baseUrl) => {
  const res = await fetch(`${baseUrl}/api/v1/me`, {
    headers: { Authorization: `Bearer ${tokenUnknown}` },
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.message, MESSAGES.ACCOUNT_NOT_FOUND);
  assert.equal(body.error.code, 'FORBIDDEN');
}));

test('suspended user → 403', withServer(() => buildApp([userDoc({ status: ACCOUNT_STATUSES.SUSPENDED })], true, verifier), async (baseUrl) => {
  const res = await fetch(`${baseUrl}/api/v1/me`, {
    headers: { Authorization: `Bearer ${tokenCustomer}` },
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.message, MESSAGES.ACCOUNT_SUSPENDED);
}));

test('role claim in the JWT never changes the application role', withServer(() => buildApp([userDoc()], true, verifier), async (baseUrl) => {
  const res = await fetch(`${baseUrl}/api/v1/me`, {
    headers: { Authorization: `Bearer ${tokenAdminClaim}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.user.role, ROLES.CUSTOMER, 'stored role wins over the claimed role');
}));

test('valid token → the raw token is never echoed', withServer(() => buildApp([userDoc()], true, verifier), async (baseUrl) => {
  const res = await fetch(`${baseUrl}/api/v1/me`, {
    headers: { Authorization: `Bearer ${tokenCustomer}` },
  });
  const raw = await res.text();
  assert.ok(!raw.includes(tokenCustomer), 'raw token never appears in the response body');
}));
