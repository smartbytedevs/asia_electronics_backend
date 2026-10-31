'use strict';

process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');

const { ERROR_CODES } = require('../../src/constants');
const {
  V1,
  UNKNOWN_VARIANT_ID,
  seedUsers,
  buildApp,
  withServer,
  request,
  setupAuth,
} = require('../helpers/order-integration-fixtures');

let tokens;

before(async () => {
  tokens = await setupAuth();
});

const BASE = '/api/v1/cart';

test('cart endpoints require authentication (401)', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl) => {
    for (const [path, method] of [
      [BASE, 'GET'],
      [`${BASE}/items`, 'POST'],
      [`${BASE}/items/507f1f77bcf86cd799439011`, 'PATCH'],
      [`${BASE}/items/507f1f77bcf86cd799439011`, 'DELETE'],
      [BASE, 'DELETE'],
    ]) {
      const res = await request(method, `${baseUrl}${path}`);
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal((await res.json()).error.code, ERROR_CODES.UNAUTHORIZED);
    }
  }
));

test('STAFF and ADMIN are forbidden from the cart (403)', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl) => {
    for (const token of [tokens.tokenStaff, tokens.tokenAdmin]) {
      const res = await request('GET', `${baseUrl}${BASE}`, token);
      assert.equal(res.status, 403);
      assert.equal((await res.json()).error.code, ERROR_CODES.FORBIDDEN);
    }
  }
));

test('role spoofing cannot elevate: JWT claim, header, or query', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl) => {
    const jwtSpoof = await request('GET', `${baseUrl}${BASE}`, tokens.tokenAdminClaimSpoof);
    assert.equal(jwtSpoof.status, 200, 'role comes from the stored User, never the token claim: a CUSTOMER token carrying an ADMIN claim stays a customer (no elevation to admin)');

    const headerSpoof = await request('GET', `${baseUrl}${BASE}`, tokens.tokenCustomer, undefined, {
      'X-Role': 'ADMIN',
    });
    assert.equal(headerSpoof.status, 200, 'X-Role header is ignored (still a customer)');

    const querySpoof = await request('GET', `${baseUrl}${BASE}?role=ADMIN`, tokens.tokenCustomer);
    assert.equal(querySpoof.status, 200, 'query role is ignored (still a customer)');
  }
));

test('customer id, money, and unknown fields are rejected in the item body', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl) => {
    for (const body of [
      { productVariantId: V1, quantity: 1, customerId: '507f1f77bcf86cd799439011' },
      { productVariantId: V1, quantity: 1, priceMinorUnits: 5000 },
      { productVariantId: V1, quantity: 1, discountMinorUnits: 1 },
      { productVariantId: V1, quantity: 1, performedBy: 'attacker' },
      { productVariantId: V1, quantity: 1, $set: { quantity: 5 } },
    ]) {
      const res = await request('POST', `${baseUrl}${BASE}/items`, tokens.tokenCustomer, body);
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error.code, ERROR_CODES.INVALID_CART_ITEM);
    }
  }
));

test('add → get → update → remove → clear full cart flow', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl, repos) => {
    const added = await request('POST', `${baseUrl}${BASE}/items`, tokens.tokenCustomer, {
      productVariantId: V1,
      quantity: 2,
    });
    assert.equal(added.status, 200);
    const addedBody = await added.json();
    assert.equal(addedBody.data.cart.items.length, 1);
    assert.equal(addedBody.data.cart.items[0].priceMinorUnits, 100000);
    assert.equal(addedBody.data.cart.items[0].availableOnlineQuantity, 20);
    const itemId = addedBody.data.cart.items[0].id;

    const got = await request('GET', `${baseUrl}${BASE}`, tokens.tokenCustomer);
    assert.equal((await got.json()).data.cart.itemCount, 2);

    const updated = await request('PATCH', `${baseUrl}${BASE}/items/${itemId}`, tokens.tokenCustomer, {
      quantity: 5,
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).data.cart.items[0].quantity, 5);

    const removed = await request('DELETE', `${baseUrl}${BASE}/items/${itemId}`, tokens.tokenCustomer);
    assert.equal(removed.status, 200);
    assert.equal((await removed.json()).data.cart.items.length, 0);

    const cleared = await request('DELETE', `${baseUrl}${BASE}`, tokens.tokenCustomer);
    assert.equal(cleared.status, 200);
    assert.equal((await cleared.json()).data.cart.items.length, 0);
    assert.equal(repos.cartRepo.docs[0].items.length, 0);
  }
));

test('adding an unknown or inactive variant is rejected (404)', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl) => {
    const res = await request('POST', `${baseUrl}${BASE}/items`, tokens.tokenCustomer, {
      productVariantId: UNKNOWN_VARIANT_ID,
      quantity: 1,
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, ERROR_CODES.INVALID_CART_ITEM);
  }
));

test('customers are fully isolated from each others carts (IDOR)', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl) => {
    await request('POST', `${baseUrl}${BASE}/items`, tokens.tokenCustomer, {
      productVariantId: V1,
      quantity: 2,
    });

    const other = await request('GET', `${baseUrl}${BASE}`, tokens.tokenCustomer2);
    assert.equal(other.status, 200);
    assert.equal((await other.json()).data.cart.items.length, 0, 'no cross-customer leakage');

    const otherAdd = await request('POST', `${baseUrl}${BASE}/items`, tokens.tokenCustomer2, {
      productVariantId: V1,
      quantity: 1,
    });
    const otherCart = await otherAdd.json();
    assert.equal(otherCart.data.cart.items.length, 1);
    assert.notEqual(otherCart.data.cart.items[0].id, undefined);
  }
));

test('an empty cart serializes cleanly', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl) => {
    const res = await request('GET', `${baseUrl}${BASE}`, tokens.tokenCustomer2);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.cart.items.length, 0);
    assert.equal(body.data.cart.itemCount, 0);
    assert.equal(body.data.cart.itemsSubtotalMinorUnits, 0);
  }
));
