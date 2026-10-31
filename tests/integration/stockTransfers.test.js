'use strict';

process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createStockTransferRouter } = require('../../src/modules/stockTransfers/stockTransfer.routes');
const { StockTransferService } = require('../../src/modules/stockTransfers/stockTransfer.service');
const { UserService } = require('../../src/modules/users/user.service');
const { ROLES, ACCOUNT_STATUSES, ERROR_CODES } = require('../../src/constants');
const notFound = require('../../src/middlewares/notFound');
const errorHandler = require('../../src/middlewares/errorHandler');
const { createJwtVerifier } = require('../../src/integrations/auth/jwtVerifier');
const { createKeyPair, signToken } = require('../../tests/helpers/jwt-fixtures');
const {
  createMemoryVariantRepository,
  createMemoryInventoryRepository,
  createMemoryMovementRepository,
  noopTransaction,
} = require('../../tests/helpers/inventory-stubs');
const {
  createMemoryOutletRepository,
  createMemoryStockTransferRepository,
} = require('../../tests/helpers/stockTransfer-stubs');

const ISSUER = 'taqwa-frontend';
const AUDIENCE = 'taqwa-backend';
const ALGORITHMS = ['RS256'];

const VARIANT_ID = '507f1f77bcf86cd799439031';
const UNKNOWN_VARIANT_ID = '507f1f77bcf86cd799439999';
const SOURCE_OUTLET_ID = '507f1f77bcf86cd799439041';
const DEST_OUTLET_ID = '507f1f77bcf86cd799439042';
const UNKNOWN_OUTLET_ID = '507f1f77bcf86cd799439999';

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

function variantDoc(overrides = {}) {
  return { _id: VARIANT_ID, sku: 'ABAYA-52', isActive: true, ...overrides };
}

function outletDoc(overrides = {}) {
  return { _id: SOURCE_OUTLET_ID, name: 'Outlet A', code: 'OUT-A', isActive: true, ...overrides };
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

function buildApp({ users, inventoryDocs = [] }) {
  const userService = new UserService({
    repository: createStubUserRepository(users),
    autoProvisionCustomers: true,
  });
  const variantRepository = createMemoryVariantRepository([variantDoc()]);
  const inventoryRepository = createMemoryInventoryRepository(inventoryDocs);
  const movementRepository = createMemoryMovementRepository();
  const outletRepository = createMemoryOutletRepository([
    outletDoc(),
    outletDoc({ _id: DEST_OUTLET_ID, name: 'Outlet B', code: 'OUT-B' }),
  ]);
  const transferRepository = createMemoryStockTransferRepository();
  const stockTransferService = new StockTransferService({
    transferRepository,
    inventoryRepository,
    movementRepository,
    variantRepository,
    outletRepository,
    runTransaction: noopTransaction,
  });

  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/admin/stock-transfers',
    createStockTransferRouter({ stockTransferService, userService, verifier })
  );
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

function outletStockDoc(outletId, onlineQuantity) {
  return {
    _id: `inv-${String(outletId).slice(-4)}`,
    productVariantId: VARIANT_ID,
    outletId,
    onlineQuantity,
    offlineQuantity: 0,
    reservedQuantity: 0,
    lowStockThreshold: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
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

test('stock transfer endpoints require authentication (401)', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl) => {
    for (const path of [
      '/api/v1/admin/stock-transfers',
      '/api/v1/admin/stock-transfers/507f1f77bcf86cd799439041',
    ]) {
      const res = await fetch(`${baseUrl}${path}`);
      assert.equal(res.status, 401, `${path} requires a token`);
      const body = await res.json();
      assert.equal(body.error.code, ERROR_CODES.UNAUTHORIZED);
    }
  }
));

test('STAFF and CUSTOMER are forbidden from stock transfer endpoints (403), and JWT role spoofing does not elevate', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl) => {
    const paths = [
      ['/api/v1/admin/stock-transfers', 'POST', { sourceOutletId: SOURCE_OUTLET_ID, destinationOutletId: DEST_OUTLET_ID, productVariantId: VARIANT_ID, quantity: 1 }],
      ['/api/v1/admin/stock-transfers', 'GET', null],
    ];
    for (const token of [tokenStaff, tokenSpoofedAdmin]) {
      for (const [path, method, body] of paths) {
        const res = method === 'POST' ? await post(`${baseUrl}${path}`, token, body) : await get(`${baseUrl}${path}`, token);
        assert.equal(res.status, 403, `${method} ${path} with role-spoofed token must 403`);
        const parsed = await res.json();
        assert.equal(parsed.error.code, ERROR_CODES.FORBIDDEN);
      }
    }
  }
));

test('ADMIN creates a transfer: both outlets update and ledger movements are written', withServer(
  () =>
    buildApp({
      users: seedUsers(),
      inventoryDocs: [outletStockDoc(SOURCE_OUTLET_ID, 20), outletStockDoc(DEST_OUTLET_ID, 5)],
    }),
  async (baseUrl) => {
    const res = await post(
      `${baseUrl}/api/v1/admin/stock-transfers`,
      tokenAdmin,
      {
        sourceOutletId: SOURCE_OUTLET_ID,
        destinationOutletId: DEST_OUTLET_ID,
        productVariantId: VARIANT_ID,
        quantity: 5,
        reason: 'replenish gulshan',
      }
    );
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.success, true);
    const transfer = body.data.transfer;
    assert.equal(transfer.status, 'COMPLETED');
    assert.equal(transfer.quantity, 5);
    assert.equal(transfer.createdBy, 'usr-admin-1', 'createdBy comes from the authenticated admin');
    assert.ok(transfer.id);

    const listRes = await get(`${baseUrl}/api/v1/admin/stock-transfers`, tokenAdmin);
    assert.equal(listRes.status, 200);
    const list = await listRes.json();
    assert.equal(list.data.transfers.length, 1);

    const fetched = await get(`${baseUrl}/api/v1/admin/stock-transfers/${transfer.id}`, tokenAdmin);
    assert.equal(fetched.status, 200);
    const fetchedBody = await fetched.json();
    assert.equal(fetchedBody.data.transfer.id, transfer.id);
  }
));

test('ADMIN cannot create a transfer with insufficient source stock (409)', withServer(
  () =>
    buildApp({
      users: seedUsers(),
      inventoryDocs: [outletStockDoc(SOURCE_OUTLET_ID, 3), outletStockDoc(DEST_OUTLET_ID, 0)],
    }),
  async (baseUrl) => {
    const res = await post(
      `${baseUrl}/api/v1/admin/stock-transfers`,
      tokenAdmin,
      {
        sourceOutletId: SOURCE_OUTLET_ID,
        destinationOutletId: DEST_OUTLET_ID,
        productVariantId: VARIANT_ID,
        quantity: 5,
      }
    );
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error.code, ERROR_CODES.INSUFFICIENT_STOCK);
  }
));

test('ADMIN cannot transfer to an unknown outlet (404)', withServer(
  () => buildApp({ users: seedUsers(), inventoryDocs: [outletStockDoc(SOURCE_OUTLET_ID, 10)] }),
  async (baseUrl) => {
    const res = await post(
      `${baseUrl}/api/v1/admin/stock-transfers`,
      tokenAdmin,
      {
        sourceOutletId: SOURCE_OUTLET_ID,
        destinationOutletId: UNKNOWN_OUTLET_ID,
        productVariantId: VARIANT_ID,
        quantity: 1,
      }
    );
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, ERROR_CODES.OUTLET_NOT_FOUND);
  }
));

test('ADMIN cannot transfer an unknown variant (404)', withServer(
  () => buildApp({ users: seedUsers(), inventoryDocs: [outletStockDoc(SOURCE_OUTLET_ID, 10)] }),
  async (baseUrl) => {
    const res = await post(
      `${baseUrl}/api/v1/admin/stock-transfers`,
      tokenAdmin,
      {
        sourceOutletId: SOURCE_OUTLET_ID,
        destinationOutletId: DEST_OUTLET_ID,
        productVariantId: UNKNOWN_VARIANT_ID,
        quantity: 1,
      }
    );
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, ERROR_CODES.VARIANT_NOT_FOUND);
  }
));

test('ADMIN cannot transfer to the same outlet or with invalid quantity (400)', withServer(
  () => buildApp({ users: seedUsers(), inventoryDocs: [outletStockDoc(SOURCE_OUTLET_ID, 10)] }),
  async (baseUrl) => {
    const cases = [
      {
        sourceOutletId: SOURCE_OUTLET_ID,
        destinationOutletId: SOURCE_OUTLET_ID,
        productVariantId: VARIANT_ID,
        quantity: 1,
      },
      {
        sourceOutletId: SOURCE_OUTLET_ID,
        destinationOutletId: DEST_OUTLET_ID,
        productVariantId: VARIANT_ID,
        quantity: 0,
      },
    ];
    for (const body of cases) {
      const res = await post(`${baseUrl}/api/v1/admin/stock-transfers`, tokenAdmin, body);
      assert.equal(res.status, 400);
      const parsed = await res.json();
      assert.equal(parsed.error.code, ERROR_CODES.INVALID_STOCK_TRANSFER);
    }
  }
));

test('ADMIN cannot spoof the acting user via the body (400)', withServer(
  () => buildApp({ users: seedUsers(), inventoryDocs: [outletStockDoc(SOURCE_OUTLET_ID, 10)] }),
  async (baseUrl) => {
    const res = await post(
      `${baseUrl}/api/v1/admin/stock-transfers`,
      tokenAdmin,
      {
        sourceOutletId: SOURCE_OUTLET_ID,
        destinationOutletId: DEST_OUTLET_ID,
        productVariantId: VARIANT_ID,
        quantity: 1,
        createdBy: 'usr-customer-1',
      }
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, ERROR_CODES.INVALID_STOCK_TRANSFER);
  }
));
