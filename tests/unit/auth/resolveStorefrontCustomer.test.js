'use strict';

process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { ROLES, ACCOUNT_STATUSES } = require('../../../src/constants');
const resolveStorefrontCustomer = require('../../../src/middlewares/resolveStorefrontCustomer');
const authorizeRoles = require('../../../src/middlewares/authorizeRoles');
const notFound = require('../../../src/middlewares/notFound');
const errorHandler = require('../../../src/middlewares/errorHandler');
const ApiError = require('../../../src/utils/ApiError');
const { createJwtVerifier } = require('../../../src/integrations/auth/jwtVerifier');
const { createKeyPair, signToken } = require('../../../tests/helpers/jwt-fixtures');

const ISSUER = 'taqwa-frontend';
const AUDIENCE = 'taqwa-backend';
const ALGORITHMS = ['RS256'];

const GUEST_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function appUser({ authProviderId, role, status = ACCOUNT_STATUSES.ACTIVE }) {
  return {
    id: `app-${authProviderId}`,
    authProviderId,
    email: undefined,
    displayName: undefined,
    phone: undefined,
    role,
    status,
  };
}

/**
 * Fake userService mirroring UserService.resolveAuthenticatedUser without a
 * database: looks up `usersByAuthProviderId`, optionally auto-provisions a
 * CUSTOMER, otherwise throws the controlled not-found error.
 */
function createFakeUserService({ users = {}, autoProvision = true } = {}) {
  const calls = [];
  const service = {
    calls,
    resolveAuthenticatedUser: async (authIdentity) => {
      calls.push(authIdentity);
      const existing = users[authIdentity.authProviderId];
      if (existing) return existing;
      if (autoProvision) {
        return appUser({ authProviderId: authIdentity.authProviderId, role: ROLES.CUSTOMER });
      }
      throw ApiError.forbidden('User account not found');
    },
  };
  return service;
}

function buildApp(verifier, userService) {
  const app = express();
  app.use(express.json());

  const gate = resolveStorefrontCustomer({ verifier, userService });
  const ok = (req, res) => res.json({ success: true, data: { role: req.user.role, id: req.user.id } });

  app.get('/whoami', gate, (req, res) => res.json({ success: true, data: { user: req.user } }));
  app.get('/customer-only', gate, authorizeRoles(ROLES.CUSTOMER), ok);
  app.get('/staff-only', gate, authorizeRoles(ROLES.ADMIN, ROLES.STAFF), ok);

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
let capturedService;

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
    claims: { role: 'CUSTOMER', email: 'customer@example.com' },
  });
});

function tokenApp() {
  const service = createFakeUserService({
    users: {
      'auth-customer-1': appUser({ authProviderId: 'auth-customer-1', role: ROLES.CUSTOMER }),
    },
  });
  capturedService = service;
  return buildApp(verifier, service);
}

test('a valid Bearer token resolves exactly like the authenticated path', withServer(() => tokenApp(), async (baseUrl) => {
  const res = await fetch(`${baseUrl}/whoami`, {
    headers: { Authorization: `Bearer ${tokenCustomer}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.user.authProviderId, 'auth-customer-1', 'token subject maps to the application user');
  assert.equal(body.data.user.role, 'CUSTOMER');
  assert.equal(capturedService.calls.length, 1);
  assert.deepEqual(capturedService.calls[0], {
    authProviderId: 'auth-customer-1',
    email: 'customer@example.com',
  });
}));

test('an invalid Bearer token → 401 with no guest fallback', withServer(() => tokenApp(), async (baseUrl) => {
  const res = await fetch(`${baseUrl}/whoami`, {
    headers: { Authorization: 'Bearer not-a-real-token', 'X-Guest-Id': GUEST_A },
  });
  assert.equal(res.status, 401);
  assert.equal(capturedService.calls.length, 0, 'a bad token never silently downgrades to a guest');
}));

test('a guest identity is resolved to a provisioned ACTIVE CUSTOMER user', withServer(() => {
  const service = createFakeUserService({ users: {} });
  capturedService = service;
  return buildApp(verifier, service);
}, async (baseUrl) => {
  const res = await fetch(`${baseUrl}/customer-only`, {
    headers: { 'X-Guest-Id': GUEST_A },
  });
  assert.equal(res.status, 200);
  assert.equal(capturedService.calls.length, 1);
  assert.deepEqual(capturedService.calls[0], { authProviderId: `guest:${GUEST_A}` });
}));

test('guest identity does not reach admin/staff roles (CUSTOMER only)', withServer(() => {
  const service = createFakeUserService({ users: {} });
  return buildApp(verifier, service);
}, async (baseUrl) => {
  const res = await fetch(`${baseUrl}/staff-only`, {
    headers: { 'X-Guest-Id': GUEST_A },
  });
  assert.equal(res.status, 403);
}));

test('neither token nor guest id → 401', withServer(() => tokenApp(), async (baseUrl) => {
  const res = await fetch(`${baseUrl}/whoami`);
  assert.equal(res.status, 401);
}));

test('invalid or malformed guest id → 401', withServer(() => tokenApp(), async (baseUrl) => {
  for (const badId of [
    'not-a-uuid',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa',
    'zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz',
    '',
  ]) {
    const res = await fetch(`${baseUrl}/whoami`, { headers: { 'X-Guest-Id': badId } });
    assert.equal(res.status, 401, `guest id: ${badId}`);
    assert.equal(capturedService.calls.length, 0, 'invalid guest ids never reach user resolution');
  }
}));

test('an existing suspended guest user → 403', withServer(() => buildApp(verifier, createFakeUserService({
  users: {
    [`guest:${GUEST_A}`]: appUser({ authProviderId: `guest:${GUEST_A}`, role: ROLES.CUSTOMER, status: ACCOUNT_STATUSES.SUSPENDED }),
  },
})), async (baseUrl) => {
  const res = await fetch(`${baseUrl}/customer-only`, {
    headers: { 'X-Guest-Id': GUEST_A },
  });
  assert.equal(res.status, 403);
}));

test('auto-provisioning disabled → 403 (controlled)', withServer(() => buildApp(verifier, createFakeUserService({ users: {}, autoProvision: false })), async (baseUrl) => {
  const res = await fetch(`${baseUrl}/whoami`, {
    headers: { 'X-Guest-Id': GUEST_A },
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.message, 'User account not found');
  assert.equal(body.error.code, 'FORBIDDEN');
}));

test('factory requires a userService (delegated to resolveCurrentUser)', () => {
  assert.throws(() => resolveStorefrontCustomer(), /userService/);
  assert.throws(() => resolveStorefrontCustomer({ userService: {} }), /userService/);
});
