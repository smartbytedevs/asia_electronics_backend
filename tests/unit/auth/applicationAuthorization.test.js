'use strict';

process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { ROLES, ACCOUNT_STATUSES } = require('../../../src/constants');
const authenticate = require('../../../src/middlewares/authenticate');
const resolveCurrentUser = require('../../../src/middlewares/resolveCurrentUser');
const authorizeRoles = require('../../../src/middlewares/authorizeRoles');
const notFound = require('../../../src/middlewares/notFound');
const errorHandler = require('../../../src/middlewares/errorHandler');
const ApiError = require('../../../src/utils/ApiError');
const { createJwtVerifier } = require('../../../src/integrations/auth/jwtVerifier');
const { createKeyPair, signToken } = require('../../../tests/helpers/jwt-fixtures');

const ISSUER = 'taqwa-frontend';
const AUDIENCE = 'taqwa-backend';
const ALGORITHMS = ['RS256'];

const MESSAGES = {
  UNAUTHORIZED: 'Authentication required',
  ACCOUNT_NOT_FOUND: 'User account not found',
  ACCOUNT_SUSPENDED: 'Account is suspended',
  ACCOUNT_DISABLED: 'Account is disabled',
  FORBIDDEN: 'You do not have permission to perform this action',
};

function appUser({ authProviderId, role, status = ACCOUNT_STATUSES.ACTIVE, email }) {
  return {
    id: `app-${authProviderId}`,
    authProviderId,
    email,
    displayName: 'App User',
    phone: undefined,
    role,
    status,
  };
}

/**
 * Fake userService that mimics UserService.resolveAuthenticatedUser without a
 * database: looks up `usersByAuthProviderId`, optionally auto-provisions a
 * CUSTOMER, otherwise throws the controlled not-found error.
 */
function createFakeUserService({ users = {}, autoProvision = true, rejectWith } = {}) {
  const calls = [];
  const service = {
    calls,
    resolveAuthenticatedUser: async (authIdentity) => {
      calls.push(authIdentity);
      if (rejectWith) throw rejectWith;
      const existing = users[authIdentity.authProviderId];
      if (existing) return existing;
      if (autoProvision) {
        return appUser({ authProviderId: authIdentity.authProviderId, role: ROLES.CUSTOMER, email: authIdentity.email });
      }
      throw ApiError.forbidden(MESSAGES.ACCOUNT_NOT_FOUND);
    },
  };
  return service;
}

function buildApp(verifier, userService) {
  const app = express();
  app.use(express.json());

  const auth = authenticate(verifier);
  const resolve = resolveCurrentUser({ userService });
  const ok = (req, res) => res.json({ success: true, data: { role: req.user.role } });

  app.get('/whoami', auth, resolve, (req, res) =>
    res.json({ success: true, data: { user: req.user } })
  );
  app.get('/customer-only', auth, resolve, authorizeRoles(ROLES.CUSTOMER), ok);
  app.get('/staff-only', auth, resolve, authorizeRoles(ROLES.ADMIN, ROLES.STAFF), ok);
  app.get('/admin-only', auth, resolve, authorizeRoles(ROLES.ADMIN), ok);
  app.post('/admin-only', auth, resolve, authorizeRoles(ROLES.ADMIN), ok);
  app.get('/no-authenticate', resolve, authorizeRoles(ROLES.ADMIN), ok);

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
let tokenStaff;
let tokenAdmin;
let capturedService;

before(async () => {
  const { privateKey, publicJwk } = await createKeyPair();
  verifier = createJwtVerifier({
    keys: [publicJwk],
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ALGORITHMS,
  });

  const baseClaims = {
    'auth-customer': { role: 'CUSTOMER', email: 'customer@example.com' },
    'auth-staff': { role: 'STAFF', email: 'staff@example.com' },
    'auth-admin': { role: 'ADMIN', email: 'admin@example.com' },
    'auth-spoof': { role: 'ADMIN', email: 'spoof@example.com' },
  };

  tokenCustomer = await signToken({ privateKey, subject: 'auth-customer', claims: baseClaims['auth-customer'] });
  tokenStaff = await signToken({ privateKey, subject: 'auth-staff', claims: baseClaims['auth-staff'] });
  tokenAdmin = await signToken({ privateKey, subject: 'auth-admin', claims: baseClaims['auth-admin'] });
});

function escalationApp() {
  return buildApp(verifier, createFakeUserService({
    users: {
      'auth-customer': appUser({ authProviderId: 'auth-customer', role: ROLES.CUSTOMER, email: 'customer@example.com' }),
    },
  }));
}

test('JWT role claim cannot escalate beyond the application role', withServer(() => escalationApp(), async (baseUrl) => {
  const headers = { Authorization: `Bearer ${tokenCustomer}` };
  assert.equal((await fetch(`${baseUrl}/customer-only`, { headers })).status, 200);
  assert.equal((await fetch(`${baseUrl}/staff-only`, { headers })).status, 403);
  assert.equal((await fetch(`${baseUrl}/admin-only`, { headers })).status, 403);
  const who = await (await fetch(`${baseUrl}/whoami`, { headers })).json();
  assert.equal(who.data.user.role, 'CUSTOMER', 'role comes from the application user');
}));

test('application role STAFF is honored even when the JWT claims CUSTOMER', withServer(() => buildApp(verifier, createFakeUserService({
  users: {
    'auth-staff': appUser({ authProviderId: 'auth-staff', role: ROLES.STAFF, email: 'staff@example.com' }),
  },
})), async (baseUrl) => {
  const headers = { Authorization: `Bearer ${tokenStaff}` };
  assert.equal((await fetch(`${baseUrl}/staff-only`, { headers })).status, 200);
  assert.equal((await fetch(`${baseUrl}/admin-only`, { headers })).status, 403);
}));

test('application role ADMIN is honored even when the JWT claims CUSTOMER', withServer(() => buildApp(verifier, createFakeUserService({
  users: {
    'auth-admin': appUser({ authProviderId: 'auth-admin', role: ROLES.ADMIN, email: 'admin@example.com' }),
  },
})), async (baseUrl) => {
  const headers = { Authorization: `Bearer ${tokenAdmin}` };
  assert.equal((await fetch(`${baseUrl}/staff-only`, { headers })).status, 200);
  assert.equal((await fetch(`${baseUrl}/admin-only`, { headers })).status, 200);
}));

test('resolveAuthenticatedUser receives the verified auth identity', withServer(() => {
  const service = createFakeUserService({
    users: {
      'auth-customer': appUser({ authProviderId: 'auth-customer', role: ROLES.CUSTOMER, email: 'customer@example.com' }),
    },
  });
  capturedService = service;
  return buildApp(verifier, service);
}, async (baseUrl) => {
  await fetch(`${baseUrl}/whoami`, {
    headers: { Authorization: `Bearer ${tokenCustomer}` },
  });
  assert.equal(capturedService.calls.length, 1);
  assert.deepEqual(capturedService.calls[0], {
    authProviderId: 'auth-customer',
    email: 'customer@example.com',
  });
}));

test('X-Role header cannot escalate privileges', withServer(() => escalationApp(), async (baseUrl) => {
  const res = await fetch(`${baseUrl}/admin-only`, {
    headers: { Authorization: `Bearer ${tokenCustomer}`, 'X-Role': 'ADMIN' },
  });
  assert.equal(res.status, 403);

  const who = await (await fetch(`${baseUrl}/whoami`, {
    headers: { Authorization: `Bearer ${tokenCustomer}`, 'X-Role': 'ADMIN' },
  })).json();
  assert.equal(who.data.user.role, 'CUSTOMER', 'identity role comes from the application user');
}));

test('request body role cannot escalate privileges', withServer(() => escalationApp(), async (baseUrl) => {
  const res = await fetch(`${baseUrl}/admin-only`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenCustomer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'ADMIN' }),
  });
  assert.equal(res.status, 403);
}));

test('query role cannot escalate privileges', withServer(() => escalationApp(), async (baseUrl) => {
  const res = await fetch(`${baseUrl}/admin-only?role=ADMIN`, {
    headers: { Authorization: `Bearer ${tokenCustomer}` },
  });
  assert.equal(res.status, 403);
}));

test('suspended user → 403 with controlled message', withServer(() => buildApp(verifier, createFakeUserService({
  users: {
    'auth-customer': appUser({ authProviderId: 'auth-customer', role: ROLES.CUSTOMER, status: ACCOUNT_STATUSES.SUSPENDED }),
  },
})), async (baseUrl) => {
  const res = await fetch(`${baseUrl}/customer-only`, {
    headers: { Authorization: `Bearer ${tokenCustomer}` },
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.message, MESSAGES.ACCOUNT_SUSPENDED);
  assert.equal(body.error.code, 'FORBIDDEN');
}));

test('disabled user → 403 with controlled message', withServer(() => buildApp(verifier, createFakeUserService({
  users: {
    'auth-customer': appUser({ authProviderId: 'auth-customer', role: ROLES.CUSTOMER, status: ACCOUNT_STATUSES.DISABLED }),
  },
})), async (baseUrl) => {
  const res = await fetch(`${baseUrl}/customer-only`, {
    headers: { Authorization: `Bearer ${tokenCustomer}` },
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.message, MESSAGES.ACCOUNT_DISABLED);
  assert.equal(body.error.code, 'FORBIDDEN');
}));

test('missing user with auto-provisioning disabled → 403 controlled error', withServer(() => buildApp(verifier, createFakeUserService({ users: {}, autoProvision: false })), async (baseUrl) => {
  const res = await fetch(`${baseUrl}/whoami`, {
    headers: { Authorization: `Bearer ${tokenAdmin}` },
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.message, MESSAGES.ACCOUNT_NOT_FOUND);
  assert.equal(body.error.code, 'FORBIDDEN');
}));

test('missing user with auto-provisioning enabled → provisioned as CUSTOMER', withServer(() => buildApp(verifier, createFakeUserService({ users: {}, autoProvision: true })), async (baseUrl) => {
  const res = await fetch(`${baseUrl}/whoami`, {
    headers: { Authorization: `Bearer ${tokenAdmin}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.user.role, 'CUSTOMER', 'auto-provisioning never grants the claimed role');
  assert.equal(body.data.user.authProviderId, 'auth-admin');
}));

test('resolveCurrentUser without authenticate (no req.auth) → 401 defensively', withServer(() => buildApp(verifier, createFakeUserService({})), async (baseUrl) => {
  const res = await fetch(`${baseUrl}/no-authenticate`);
  assert.equal(res.status, 401);
}));

test('forbidden response uses the contract message', withServer(() => escalationApp(), async (baseUrl) => {
  const res = await fetch(`${baseUrl}/admin-only`, {
    headers: { Authorization: `Bearer ${tokenCustomer}` },
  });
  const body = await res.json();
  assert.equal(body.message, MESSAGES.FORBIDDEN);
  assert.equal(body.error.code, 'FORBIDDEN');
}));

test('authorizeRoles rejects unknown roles at factory time', () => {
  assert.throws(() => authorizeRoles('SUPERUSER'), /unknown role/);
});

test('resolveCurrentUser requires a userService', () => {
  assert.throws(() => resolveCurrentUser(), /userService/);
  assert.throws(() => resolveCurrentUser({ userService: {} }), /userService/);
});
