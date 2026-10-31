'use strict';

process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createOutletRouter } = require('../../src/modules/outlets/outlet.routes');
const { createAdminOutletRouter } = require('../../src/modules/outlets/adminOutlet.routes');
const { OutletService } = require('../../src/modules/outlets/outlet.service');
const { UserService } = require('../../src/modules/users/user.service');
const { ROLES, ACCOUNT_STATUSES, ERROR_CODES } = require('../../src/constants');
const notFound = require('../../src/middlewares/notFound');
const errorHandler = require('../../src/middlewares/errorHandler');
const { createJwtVerifier } = require('../../src/integrations/auth/jwtVerifier');
const { createKeyPair, signToken } = require('../../tests/helpers/jwt-fixtures');
const { createMemoryOutletRepository } = require('../../tests/helpers/stockTransfer-stubs');

const ISSUER = 'taqwa-frontend';
const AUDIENCE = 'taqwa-backend';
const ALGORITHMS = ['RS256'];

const OUTLET_A_ID = '507f1f77bcf86cd799439041';
const OUTLET_B_ID = '507f1f77bcf86cd799439042';

function outletDoc(overrides = {}) {
  return {
    _id: OUTLET_A_ID,
    name: 'Gulshan Outlet',
    code: 'GUL',
    address: 'Gulshan 2, Dhaka',
    phone: '+8801712000000',
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function userDoc(overrides = {}) {
  return {
    _id: `usr-${overrides.authProviderId || 'x'}`,
    authProviderId: 'auth-customer-1',
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
      _id: 'usr-staff-1',
      authProviderId: 'auth-staff-1',
      email: 'staff@example.com',
      displayName: 'Staff Person',
      role: ROLES.STAFF,
    }),
    userDoc({
      _id: 'usr-admin-1',
      authProviderId: 'auth-admin-1',
      email: 'admin@example.com',
      displayName: 'Admin Person',
      role: ROLES.ADMIN,
    }),
  ];
}

function buildApp({ users, outlets }) {
  const userService = new UserService({
    repository: createStubUserRepository(users),
    autoProvisionCustomers: true,
  });
  const outletService = new OutletService({
    repository: createMemoryOutletRepository(outlets),
  });

  const app = express();
  app.use(express.json());
  app.use('/api/v1/outlets', createOutletRouter({ outletService }));
  app.use(
    '/api/v1/admin/outlets',
    createAdminOutletRouter({ outletService, userService, verifier })
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

function post(url, token, body, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function patch(url, token, body) {
  return fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function get(url, token) {
  return fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

let verifier;
let tokenStaff;
let tokenAdmin;
let tokenSpoofedAdmin;

before(async () => {
  const { privateKey, publicJwk } = await createKeyPair();
  verifier = createJwtVerifier({
    keys: [publicJwk],
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ALGORITHMS,
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
  tokenSpoofedAdmin = await signToken({
    privateKey,
    subject: 'auth-staff-1',
    claims: { role: 'ADMIN', email: 'staff@example.com', name: 'Staff Person' },
  });
});

test('public outlet reads need no auth and only surface ACTIVE outlets', withServer(
  () => buildApp({ users: seedUsers(), outlets: [outletDoc(), outletDoc({ _id: OUTLET_B_ID, name: 'Uttara Outlet', code: 'UTT', isActive: false })] }),
  async (baseUrl) => {
    const listRes = await get(`${baseUrl}/api/v1/outlets`);
    assert.equal(listRes.status, 200);
    const list = await listRes.json();
    assert.equal(list.data.outlets.length, 1, 'inactive outlet hidden from public list');
    assert.equal(list.data.outlets[0].id, OUTLET_A_ID);

    const byIdRes = await get(`${baseUrl}/api/v1/outlets/${OUTLET_A_ID}`);
    assert.equal(byIdRes.status, 200);
    assert.equal((await byIdRes.json()).data.outlet.code, 'GUL');

    const byCodeRes = await get(`${baseUrl}/api/v1/outlets/code/gul`);
    assert.equal(byCodeRes.status, 200);
    assert.equal((await byCodeRes.json()).data.outlet.id, OUTLET_A_ID);
  }
));

test('public reads treat an inactive outlet as not-found (404)', withServer(
  () => buildApp({ users: seedUsers(), outlets: [outletDoc({ isActive: false })] }),
  async (baseUrl) => {
    const byId = await get(`${baseUrl}/api/v1/outlets/${OUTLET_A_ID}`);
    assert.equal(byId.status, 404);
    assert.equal((await byId.json()).error.code, ERROR_CODES.OUTLET_NOT_FOUND);

    const byCode = await get(`${baseUrl}/api/v1/outlets/code/gul`);
    assert.equal(byCode.status, 404);
  }
));

test('admin outlet management requires auth (401) and rejects STAFF with spoofed roles (403)', withServer(
  () => buildApp({ users: seedUsers(), outlets: [outletDoc()] }),
  async (baseUrl) => {
    for (const path of ['/api/v1/admin/outlets', `/api/v1/admin/outlets/${OUTLET_A_ID}`]) {
      const res = await fetch(`${baseUrl}${path}`);
      assert.equal(res.status, 401, `${path} requires a token`);
    }

    for (const token of [tokenStaff, tokenSpoofedAdmin]) {
      for (const [method, path, body] of [
        ['POST', '/api/v1/admin/outlets', { name: 'X', code: 'X' }],
        ['GET', '/api/v1/admin/outlets', null],
        ['PATCH', `/api/v1/admin/outlets/${OUTLET_A_ID}`, { isActive: false }],
      ]) {
        const res =
          method === 'POST'
            ? await post(`${baseUrl}${path}`, token, body)
            : method === 'PATCH'
              ? await patch(`${baseUrl}${path}`, token, body)
              : await get(`${baseUrl}${path}`, token);
        assert.equal(res.status, 403, `${method} ${path} must 403 for STAFF/spoofed admin`);
        assert.equal((await res.json()).error.code, ERROR_CODES.FORBIDDEN);
      }
    }
  }
));

test('ADMIN creates an outlet (code uppercased) and rejects a duplicate code (400)', withServer(
  () => buildApp({ users: seedUsers(), outlets: [outletDoc()] }),
  async (baseUrl) => {
    const createdRes = await post(
      `${baseUrl}/api/v1/admin/outlets`,
      tokenAdmin,
      { name: '  Badda Outlet  ', code: ' badda ', address: 'Badda, Dhaka' }
    );
    assert.equal(createdRes.status, 201);
    const created = (await createdRes.json()).data.outlet;
    assert.equal(created.name, 'Badda Outlet');
    assert.equal(created.code, 'BADDA', 'code uppercased and trimmed');
    assert.equal(created.isActive, true);

    const dupRes = await post(`${baseUrl}/api/v1/admin/outlets`, tokenAdmin, { name: 'Another', code: ' badda ' });
    assert.equal(dupRes.status, 400);
    assert.equal((await dupRes.json()).error.code, ERROR_CODES.OUTLET_CODE_ALREADY_EXISTS);
  }
));

test('ADMIN can update, then deactivate, and admin list still shows the inactive outlet', withServer(
  () => buildApp({ users: seedUsers(), outlets: [outletDoc()] }),
  async (baseUrl) => {
    const patchRes = await patch(`${baseUrl}/api/v1/admin/outlets/${OUTLET_A_ID}`, tokenAdmin, {
      name: 'Gulshan Main',
      phone: '+8801712999999',
    });
    assert.equal(patchRes.status, 200);
    const updated = (await patchRes.json()).data.outlet;
    assert.equal(updated.name, 'Gulshan Main');
    assert.equal(updated.code, 'GUL', 'untouched fields preserved');

    const deactRes = await patch(`${baseUrl}/api/v1/admin/outlets/${OUTLET_A_ID}`, tokenAdmin, {
      isActive: false,
    });
    assert.equal(deactRes.status, 200);
    assert.equal((await deactRes.json()).data.outlet.isActive, false);

    const adminList = await get(`${baseUrl}/api/v1/admin/outlets`, tokenAdmin);
    assert.equal((await adminList.json()).data.outlets.length, 1, 'admin sees deactivated outlet');

    const adminGet = await get(`${baseUrl}/api/v1/admin/outlets/${OUTLET_A_ID}`, tokenAdmin);
    assert.equal(adminGet.status, 200);

    const publicGet = await get(`${baseUrl}/api/v1/outlets/${OUTLET_A_ID}`);
    assert.equal(publicGet.status, 404, 'deactivated outlet hidden from storefront');
  }
));

test('ADMIN cannot create an outlet with immutable/unknown keys (400)', withServer(
  () => buildApp({ users: seedUsers(), outlets: [] }),
  async (baseUrl) => {
    for (const body of [
      { name: 'X', code: 'X', _id: '507f1f77bcf86cd799439099' },
      { name: 'X', code: 'X', $set: { name: 'Hacked' } },
      { name: 'X', code: 'X', createdAt: new Date().toISOString() },
    ]) {
      const res = await post(`${baseUrl}/api/v1/admin/outlets`, tokenAdmin, body);
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error.code, ERROR_CODES.INVALID_OUTLET);
    }
  }
));
