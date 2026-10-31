'use strict';

process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const authenticate = require('../../../src/middlewares/authenticate');
const notFound = require('../../../src/middlewares/notFound');
const errorHandler = require('../../../src/middlewares/errorHandler');
const { createJwtVerifier } = require('../../../src/integrations/auth/jwtVerifier');
const { createKeyPair, signToken } = require('../../../tests/helpers/jwt-fixtures');

const ISSUER = 'taqwa-frontend';
const AUDIENCE = 'taqwa-backend';
const ALGORITHMS = ['RS256'];

/**
 * Isolated app using the REAL `authenticate` middleware. Only authentication
 * identity (`req.auth`) is exercised here; application-user resolution and
 * role authorization are covered in applicationAuthorization.test.js.
 */
function buildApp(verifier) {
  const app = express();
  app.use(express.json());

  const auth = authenticate(verifier);

  app.get('/auth-info', auth, (req, res) =>
    res.json({ success: true, data: { auth: req.auth } })
  );
  app.get('/no-resolver', auth, (req, res) =>
    res.json({ success: true, hasUser: Object.prototype.hasOwnProperty.call(req, 'user') })
  );

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

const UNAUTHORIZED_MESSAGE = 'Authentication required';

let app;
let customerToken;
let adminClaimToken;
let expiredToken;

before(async () => {
  const { privateKey, publicJwk } = await createKeyPair();
  const verifier = createJwtVerifier({
    keys: [publicJwk],
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ALGORITHMS,
  });
  app = buildApp(verifier);

  customerToken = await signToken({
    privateKey,
    subject: 'auth-customer-1',
    claims: { email: 'customer@example.com', name: 'Customer One' },
  });
  adminClaimToken = await signToken({
    privateKey,
    subject: 'auth-2',
    claims: { role: 'ADMIN', email: 'impersonator@example.com' },
  });
  expiredToken = await signToken({
    privateKey,
    subject: 'auth-customer-1',
    claims: { role: 'CUSTOMER' },
    expiresIn: Math.floor(Date.now() / 1000) - 3600,
  });
});

test('missing Authorization header → 401 UNAUTHORIZED with contract message', withServer(() => app, async (baseUrl) => {
  const res = await fetch(`${baseUrl}/auth-info`);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(body.message, UNAUTHORIZED_MESSAGE);
  assert.equal(body.error.code, 'UNAUTHORIZED');
}));

test('non-Bearer Authorization header → 401', withServer(() => app, async (baseUrl) => {
  const res = await fetch(`${baseUrl}/auth-info`, {
    headers: { Authorization: 'Basic Zm9vOmJhcg==' },
  });
  assert.equal(res.status, 401);
}));

test('malformed Authorization header (missing token) → 401', withServer(() => app, async (baseUrl) => {
  const res = await fetch(`${baseUrl}/auth-info`, {
    headers: { Authorization: 'Bearer' },
  });
  assert.equal(res.status, 401);
}));

test('malformed token → 401', withServer(() => app, async (baseUrl) => {
  const res = await fetch(`${baseUrl}/auth-info`, {
    headers: { Authorization: 'Bearer not.a.jwt' },
  });
  assert.equal(res.status, 401);
}));

test('expired token → 401', withServer(() => app, async (baseUrl) => {
  const res = await fetch(`${baseUrl}/auth-info`, {
    headers: { Authorization: `Bearer ${expiredToken}` },
  });
  assert.equal(res.status, 401);
}));

test('valid token → 200 with normalized authentication identity', withServer(() => app, async (baseUrl) => {
  const res = await fetch(`${baseUrl}/auth-info`, {
    headers: { Authorization: `Bearer ${customerToken}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.data.auth, {
    authProviderId: 'auth-customer-1',
    email: 'customer@example.com',
    displayName: 'Customer One',
  });
}));

test('valid token carrying a role claim does NOT expose a role in req.auth', withServer(() => app, async (baseUrl) => {
  const res = await fetch(`${baseUrl}/auth-info`, {
    headers: { Authorization: `Bearer ${adminClaimToken}` },
  });
  const body = await res.json();
  assert.ok(!('role' in body.data.auth), 'role claim is dropped from the auth identity');
  assert.deepEqual(body.data.auth, {
    authProviderId: 'auth-2',
    email: 'impersonator@example.com',
  });
}));

test('authenticate alone never sets req.user (role resolution is a separate step)', withServer(() => app, async (baseUrl) => {
  const res = await fetch(`${baseUrl}/no-resolver`, {
    headers: { Authorization: `Bearer ${customerToken}` },
  });
  const body = await res.json();
  assert.equal(body.hasUser, false);
}));

test('raw token is never echoed in responses', withServer(() => app, async (baseUrl) => {
  const raw = await (await fetch(`${baseUrl}/auth-info`, {
    headers: { Authorization: `Bearer ${customerToken}` },
  })).text();
  assert.ok(!raw.includes(customerToken), 'raw token is never echoed in responses');
}));
