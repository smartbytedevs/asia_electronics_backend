'use strict';

process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createInventoryRouter } = require('../../src/modules/inventory/inventory.routes');
const { InventoryService } = require('../../src/modules/inventory/inventory.service');
const { ReservationService } = require('../../src/modules/inventory/reservation.service');
const { UserService } = require('../../src/modules/users/user.service');
const { ROLES, ACCOUNT_STATUSES, ERROR_CODES } = require('../../src/constants');
const notFound = require('../../src/middlewares/notFound');
const errorHandler = require('../../src/middlewares/errorHandler');
const { createJwtVerifier } = require('../../src/integrations/auth/jwtVerifier');
const { createKeyPair, signToken } = require('../../tests/helpers/jwt-fixtures');
const {
  createMemoryVariantRepository,
  createMemoryProductRepository,
  createMemoryInventoryRepository,
  createMemoryMovementRepository,
  createMemoryReservationRepository,
  noopTransaction,
} = require('../../tests/helpers/inventory-stubs');

const ISSUER = 'taqwa-frontend';
const AUDIENCE = 'taqwa-backend';
const ALGORITHMS = ['RS256'];

const VARIANT_ID = '507f1f77bcf86cd799439031';
const SECOND_VARIANT_ID = '507f1f77bcf86cd799439032';
const UNKNOWN_VARIANT_ID = '507f1f77bcf86cd799439999';
const SIMPLE_PRODUCT_ID = '507f1f77bcf86cd799439010';

let nextHex = 0;
function freshHexId() {
  nextHex += 1;
  return `507f1f77bcf86cd79943${String(9000 + nextHex)}`;
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

function variantDoc(overrides = {}) {
  return {
    _id: VARIANT_ID,
    sku: 'ABAYA-52',
    attributes: { size: '52' },
    isActive: true,
    ...overrides,
  };
}

function productDoc(overrides = {}) {
  return {
    _id: SIMPLE_PRODUCT_ID,
    name: 'Simple Hijab',
    isActive: true,
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

function buildApp({
  users,
  variants = [variantDoc(), variantDoc({ _id: SECOND_VARIANT_ID, sku: 'ABAYA-54' })],
  products = [],
  verifier: appVerifier,
}) {
  const effectiveVerifier = appVerifier || verifier;
  const userService = new UserService({
    repository: createStubUserRepository(users),
    autoProvisionCustomers: true,
  });
  const inventoryRepository = createMemoryInventoryRepository();
  const movementRepository = createMemoryMovementRepository();
  const reservationRepository = createMemoryReservationRepository();
  const variantRepository = createMemoryVariantRepository(variants);
  const inventoryService = new InventoryService({
    inventoryRepository,
    movementRepository,
    variantRepository,
    productRepository: createMemoryProductRepository(products),
    runTransaction: noopTransaction,
  });
  const reservationService = new ReservationService({
    reservationRepository,
    inventoryRepository,
    movementRepository,
    variantRepository,
    runTransaction: noopTransaction,
  });

  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/inventory',
    createInventoryRouter({ inventoryService, reservationService, userService, verifier: effectiveVerifier })
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

test('inventory endpoints require authentication (401)', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl) => {
    for (const path of [
      '/api/v1/inventory',
      '/api/v1/inventory/initialize',
      '/api/v1/inventory/stock-in',
      '/api/v1/inventory/reservations',
    ]) {
      const res = await fetch(`${baseUrl}${path}`);
      assert.equal(res.status, 401, `${path} requires a token`);
      const body = await res.json();
      assert.equal(body.error.code, ERROR_CODES.UNAUTHORIZED);
    }
  }
));

test('STAFF and CUSTOMER are forbidden from every inventory endpoint (403)', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl) => {
    const paths = [
      ['/api/v1/inventory', 'GET'],
      ['/api/v1/inventory/initialize', 'POST'],
      ['/api/v1/inventory/stock-in', 'POST'],
      ['/api/v1/inventory/stock-out', 'POST'],
      ['/api/v1/inventory/transfer', 'POST'],
      ['/api/v1/inventory/adjust', 'POST'],
      ['/api/v1/inventory/reservations', 'POST'],
    ];
    for (const [path, method] of paths) {
      for (const token of [tokenCustomer, tokenStaff]) {
        const res = method === 'GET'
          ? await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } })
          : await post(`${baseUrl}${path}`, token, {});
        assert.equal(res.status, 403, `${method} ${path} as non-admin`);
        const body = await res.json();
        assert.equal(body.error.code, ERROR_CODES.FORBIDDEN);
      }
    }
  }
));

test('role spoofing cannot elevate: JWT claim, header, body, or query', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl) => {
    const jwtSpoof = await post(`${baseUrl}/api/v1/inventory/initialize`, tokenAdminClaimSpoof, {
      productVariantId: VARIANT_ID,
    });
    assert.equal(jwtSpoof.status, 403, 'role comes from the stored User, never the token claim');

    const headerSpoof = await post(
      `${baseUrl}/api/v1/inventory/initialize`,
      tokenCustomer,
      { productVariantId: VARIANT_ID },
      { 'X-Role': 'ADMIN' }
    );
    assert.equal(headerSpoof.status, 403, 'X-Role header is ignored');

    const querySpoof = await fetch(
      `${baseUrl}/api/v1/inventory?role=ADMIN`,
      { headers: { Authorization: `Bearer ${tokenCustomer}` } }
    );
    assert.equal(querySpoof.status, 403, 'query role is ignored');
  }
));

test('actor is never accepted from the body (performedBy is an unknown field)', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl) => {
    const res = await post(`${baseUrl}/api/v1/inventory/initialize`, tokenAdmin, {
      productVariantId: VARIANT_ID,
      performedBy: 'attacker-id',
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, ERROR_CODES.INVALID_INVENTORY_OPERATION);
  }
));

test('admin initialize → 201 with derived quantities, second initialize → 409', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl) => {
    const res = await post(`${baseUrl}/api/v1/inventory/initialize`, tokenAdmin, {
      productVariantId: VARIANT_ID,
      onlineQuantity: 20,
      offlineQuantity: 5,
      lowStockThreshold: 2,
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.inventory.productVariantId, VARIANT_ID);
    assert.equal(body.data.inventory.onlineQuantity, 20);
    assert.equal(body.data.inventory.offlineQuantity, 5);
    assert.equal(body.data.inventory.availableOnlineQuantity, 20);
    assert.equal(body.data.inventory.totalPhysicalQuantity, 25);
    assert.equal(body.data.inventory.isLowStock, false);
    assert.equal(body.data.inventory._id, undefined, 'no raw _id serialized');

    const second = await post(`${baseUrl}/api/v1/inventory/initialize`, tokenAdmin, {
      productVariantId: VARIANT_ID,
      onlineQuantity: 50,
    });
    assert.equal(second.status, 409);
    const secondBody = await second.json();
    assert.equal(secondBody.error.code, ERROR_CODES.INVENTORY_ALREADY_EXISTS);
  }
));

test('initialize for an unknown or inactive variant is rejected', withServer(
  () =>
    buildApp({
      users: seedUsers(),
      variants: [variantDoc({ isActive: false })],
    }),
  async (baseUrl) => {
    const unknown = await post(`${baseUrl}/api/v1/inventory/initialize`, tokenAdmin, {
      productVariantId: UNKNOWN_VARIANT_ID,
    });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, ERROR_CODES.VARIANT_NOT_FOUND);

    const inactive = await post(`${baseUrl}/api/v1/inventory/initialize`, tokenAdmin, {
      productVariantId: VARIANT_ID,
    });
    assert.equal(inactive.status, 400);
    assert.equal((await inactive.json()).error.code, ERROR_CODES.INVALID_INVENTORY_OPERATION);
  }
));

test('operator injection and unknown fields are rejected (400)', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl) => {
    const injected = await post(`${baseUrl}/api/v1/inventory/stock-in`, tokenAdmin, {
      productVariantId: VARIANT_ID,
      $inc: { onlineQuantity: 999 },
    });
    assert.equal(injected.status, 400);
    assert.equal((await injected.json()).error.code, ERROR_CODES.INVALID_INVENTORY_OPERATION);

    const unknown = await post(`${baseUrl}/api/v1/inventory/stock-in`, tokenAdmin, {
      productVariantId: VARIANT_ID,
      location: 'ONLINE',
      quantity: 5,
      isAdmin: true,
    });
    assert.equal(unknown.status, 400);
  }
));

test('stock-out beyond available online stock → 409 INSUFFICIENT_AVAILABLE_STOCK', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl) => {
    await post(`${baseUrl}/api/v1/inventory/initialize`, tokenAdmin, {
      productVariantId: VARIANT_ID,
      onlineQuantity: 2,
    });
    const res = await post(`${baseUrl}/api/v1/inventory/stock-out`, tokenAdmin, {
      productVariantId: VARIANT_ID,
      location: 'ONLINE',
      quantity: 3,
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, ERROR_CODES.INSUFFICIENT_AVAILABLE_STOCK);
  }
));

test('full ledger audit over HTTP: initialize → stock-in → transfer → adjust → stock-out', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl) => {
    await post(`${baseUrl}/api/v1/inventory/initialize`, tokenAdmin, {
      productVariantId: VARIANT_ID,
      onlineQuantity: 20,
    });
    await post(`${baseUrl}/api/v1/inventory/stock-in`, tokenAdmin, {
      productVariantId: VARIANT_ID,
      location: 'OFFLINE',
      quantity: 10,
      reason: 'delivery',
    });
    await post(`${baseUrl}/api/v1/inventory/transfer`, tokenAdmin, {
      productVariantId: VARIANT_ID,
      fromLocation: 'ONLINE',
      toLocation: 'OFFLINE',
      quantity: 5,
    });
    await post(`${baseUrl}/api/v1/inventory/adjust`, tokenAdmin, {
      productVariantId: VARIANT_ID,
      location: 'ONLINE',
      quantity: -2,
      reason: 'cycle count',
    });
    await post(`${baseUrl}/api/v1/inventory/stock-out`, tokenAdmin, {
      productVariantId: VARIANT_ID,
      location: 'ONLINE',
      quantity: 3,
      reason: 'damaged',
    });

    const get = await fetch(`${baseUrl}/api/v1/inventory/${VARIANT_ID}`, {
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    assert.equal(get.status, 200);
    const body = await get.json();
    assert.equal(body.data.inventory.onlineQuantity, 10, '20 − 5 − 2 − 3');
    assert.equal(body.data.inventory.offlineQuantity, 15, '0 + 10 + 5');
    assert.equal(body.data.inventory.availableOnlineQuantity, 10);

    const movements = await fetch(`${baseUrl}/api/v1/inventory/${VARIANT_ID}/movements`, {
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    const movementsBody = await movements.json();
    assert.equal(movementsBody.data.pagination.total, 5);
    const types = movementsBody.data.movements.map((m) => m.type).sort();
    assert.deepEqual(types, ['ADJUSTMENT', 'INITIAL_STOCK', 'STOCK_IN', 'STOCK_OUT', 'TRANSFER']);
    assert.ok(
      movementsBody.data.movements.every((m) => m.performedBy === 'usr-admin-1'),
      'actor always resolved from req.user'
    );
  }
));

test('GET list and low-stock reads are admin-only and correct', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl) => {
    await post(`${baseUrl}/api/v1/inventory/initialize`, tokenAdmin, {
      productVariantId: VARIANT_ID,
      onlineQuantity: 2,
      lowStockThreshold: 2,
    });
    await post(`${baseUrl}/api/v1/inventory/initialize`, tokenAdmin, {
      productVariantId: SECOND_VARIANT_ID,
      onlineQuantity: 100,
    });

    const list = await fetch(`${baseUrl}/api/v1/inventory`, {
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    assert.equal(list.status, 200);
    const listBody = await list.json();
    assert.equal(listBody.data.pagination.total, 2);

    const lowStock = await fetch(`${baseUrl}/api/v1/inventory/low-stock`, {
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    const lowBody = await lowStock.json();
    assert.equal(lowBody.data.inventory.length, 1);
    assert.equal(lowBody.data.inventory[0].productVariantId, VARIANT_ID);
  }
));

test('an active product with no inventory appears as Not initialized, then initializes', withServer(
  () =>
    buildApp({
      users: seedUsers(),
      products: [productDoc()],
    }),
  async (baseUrl) => {
    const list = await fetch(`${baseUrl}/api/v1/inventory`, {
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    assert.equal(list.status, 200);
    const listBody = await list.json();
    const uninitialized = listBody.data.inventory.filter((item) => item.isInitialized === false);
    assert.equal(uninitialized.length, 1, 'one synthetic Not initialized row');
    assert.equal(uninitialized[0].productId, SIMPLE_PRODUCT_ID);
    assert.equal(uninitialized[0].productVariantId, null);
    assert.equal(uninitialized[0].id, null, 'synthetic row carries no inventory record id');
    assert.equal(uninitialized[0].totalPhysicalQuantity, 0);
    assert.equal(uninitialized[0].productName, 'Simple Hijab');

    const init = await post(`${baseUrl}/api/v1/inventory/initialize`, tokenAdmin, {
      productId: SIMPLE_PRODUCT_ID,
      onlineQuantity: 7,
    });
    assert.equal(init.status, 201);
    const initBody = await init.json();
    assert.equal(initBody.data.inventory.isInitialized, true);
    assert.equal(initBody.data.inventory.productId, SIMPLE_PRODUCT_ID);
    assert.equal(initBody.data.inventory.productVariantId, null);
    assert.equal(initBody.data.inventory.onlineQuantity, 7);
    assert.equal(initBody.data.inventory.availableOnlineQuantity, 7);

    const listAfter = await fetch(`${baseUrl}/api/v1/inventory`, {
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    const afterBody = await listAfter.json();
    assert.equal(
      afterBody.data.inventory.filter((item) => item.isInitialized === false).length,
      0,
      'no Not initialized rows remain after initialization'
    );
    const record = afterBody.data.inventory.find((item) => item.productId === SIMPLE_PRODUCT_ID);
    assert.ok(record, 'the initialized record is listed');
    assert.equal(record.isInitialized, true);
    assert.equal(record.onlineQuantity, 7);
  }
));

test('reservation lifecycle over HTTP: create → release (idempotent) → consume → expire', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl) => {
    await post(`${baseUrl}/api/v1/inventory/initialize`, tokenAdmin, {
      productVariantId: VARIANT_ID,
      onlineQuantity: 10,
    });

    const created = await post(`${baseUrl}/api/v1/inventory/reservations`, tokenAdmin, {
      productVariantId: VARIANT_ID,
      quantity: 3,
      referenceType: 'ORDER',
      referenceId: 'order-1',
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.equal(createdBody.data.reservation.status, 'ACTIVE');
    const reservationId = createdBody.data.reservation.id;

    const duplicate = await post(`${baseUrl}/api/v1/inventory/reservations`, tokenAdmin, {
      productVariantId: VARIANT_ID,
      quantity: 2,
      referenceType: 'ORDER',
      referenceId: 'order-1',
    });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).error.code, ERROR_CODES.RESERVATION_CONFLICT);

    const overSell = await post(`${baseUrl}/api/v1/inventory/reservations`, tokenAdmin, {
      productVariantId: VARIANT_ID,
      quantity: 100,
      referenceType: 'ORDER',
      referenceId: 'order-oversell',
    });
    assert.equal(overSell.status, 409);
    assert.equal((await overSell.json()).error.code, ERROR_CODES.INSUFFICIENT_AVAILABLE_STOCK);

    const released = await post(
      `${baseUrl}/api/v1/inventory/reservations/${reservationId}/release`,
      tokenAdmin,
      {}
    );
    assert.equal(released.status, 200);
    const releasedBody = await released.json();
    assert.equal(releasedBody.data.reservation.status, 'RELEASED');
    assert.equal(releasedBody.data.inventory.availableOnlineQuantity, 10);

    const releasedAgain = await post(
      `${baseUrl}/api/v1/inventory/reservations/${reservationId}/release`,
      tokenAdmin,
      {}
    );
    assert.equal(releasedAgain.status, 200, 'double release is retry-safe');
    const releasedAgainBody = await releasedAgain.json();
    assert.equal(releasedAgainBody.data.reservation.status, 'RELEASED');
    assert.equal(releasedAgainBody.data.inventory, null, 'no stock change on retry');

    const consumeRes = await post(`${baseUrl}/api/v1/inventory/reservations`, tokenAdmin, {
      productVariantId: VARIANT_ID,
      quantity: 2,
      referenceType: 'ORDER',
      referenceId: 'order-2',
    });
    const consumeId = (await consumeRes.json()).data.reservation.id;
    const consumed = await post(
      `${baseUrl}/api/v1/inventory/reservations/${consumeId}/consume`,
      tokenAdmin,
      {}
    );
    assert.equal(consumed.status, 200);
    const consumedBody = await consumed.json();
    assert.equal(consumedBody.data.reservation.status, 'CONSUMED');
    assert.equal(consumedBody.data.inventory.onlineQuantity, 8, 'reserved stock leaves ONLINE');

    const releaseConsumed = await post(
      `${baseUrl}/api/v1/inventory/reservations/${consumeId}/release`,
      tokenAdmin,
      {}
    );
    assert.equal(releaseConsumed.status, 409);
    assert.equal((await releaseConsumed.json()).error.code, ERROR_CODES.RESERVATION_NOT_ACTIVE);

    const expireRes = await post(`${baseUrl}/api/v1/inventory/reservations`, tokenAdmin, {
      productVariantId: VARIANT_ID,
      quantity: 1,
      referenceType: 'ORDER',
      referenceId: 'order-3',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const expireId = (await expireRes.json()).data.reservation.id;
    const expired = await post(
      `${baseUrl}/api/v1/inventory/reservations/${expireId}/expire`,
      tokenAdmin,
      {}
    );
    assert.equal(expired.status, 200);
    assert.equal((await expired.json()).data.reservation.status, 'EXPIRED');

    const getOne = await fetch(`${baseUrl}/api/v1/inventory/reservations/${expireId}`, {
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    assert.equal(getOne.status, 200);
    assert.equal((await getOne.json()).data.reservation.status, 'EXPIRED');

    const list = await fetch(`${baseUrl}/api/v1/inventory/reservations?status=ACTIVE`, {
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    const listBody = await list.json();
    assert.equal(listBody.data.pagination.total, 0, 'all reservations settled');
    assert.equal(listBody.data.reservations.length, 0);
  }
));

test('raw token is never echoed in responses', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/inventory`, {
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    const raw = await res.text();
    assert.ok(!raw.includes(tokenAdmin), 'raw token never appears in the response body');
  }
));
