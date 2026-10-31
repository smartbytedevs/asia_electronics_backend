'use strict';

process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');

const { ERROR_CODES } = require('../../src/constants');
const {
  V1,
  V2,
  seedUsers,
  buildApp,
  withServer,
  request,
  checkoutBody,
  setupAuth,
} = require('../helpers/order-integration-fixtures');

let tokens;

before(async () => {
  tokens = await setupAuth();
});

const BASE = '/api/v1/admin/orders';

function withCart(users = seedUsers()) {
  return buildApp({ users });
}

async function seedCartViaApi(baseUrl, token, items) {
  for (const item of items) {
    await request('POST', `${baseUrl}/api/v1/cart/items`, token, item);
  }
}

async function checkout(baseUrl, token, key, body = checkoutBody()) {
  const res = await request('POST', `${baseUrl}/api/v1/orders/checkout`, token, body, {
    'Idempotency-Key': key,
  });
  const { order } = (await res.json()).data;
  return { res, order };
}

test('admin order endpoints require authentication (401)', withServer(
  () => withCart(),
  async (baseUrl) => {
    for (const [path, method] of [
      [BASE, 'GET'],
      [`${BASE}/507f1f77bcf86cd799439099`, 'GET'],
      [`${BASE}/507f1f77bcf86cd799439099/confirm`, 'POST'],
      [`${BASE}/507f1f77bcf86cd799439099/process`, 'POST'],
      [`${BASE}/507f1f77bcf86cd799439099/reject`, 'POST'],
    ]) {
      const res = await request(method, `${baseUrl}${path}`);
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal((await res.json()).error.code, ERROR_CODES.UNAUTHORIZED);
    }
  }
));

test('CUSTOMER role is forbidden from admin order endpoints (403)', withServer(
  () => withCart(),
  async (baseUrl) => {
    const res = await request('GET', `${baseUrl}${BASE}`, tokens.tokenCustomer);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, ERROR_CODES.FORBIDDEN);
  }
));

test('STAFF can list, confirm, and process an order end-to-end', withServer(
  () => withCart(),
  async (baseUrl, repos) => {
    await seedCartViaApi(baseUrl, tokens.tokenCustomer, [
      { productVariantId: V1, quantity: 1 },
      { productVariantId: V2, quantity: 1 },
    ]);
    const { order } = await checkout(baseUrl, tokens.tokenCustomer, 'staff-flow');

    const list = await request('GET', `${baseUrl}${BASE}?status=PENDING`, tokens.tokenStaff);
    assert.equal(list.status, 200);
    assert.equal((await list.json()).data.orders.length, 1);

    const confirm = await request('POST', `${baseUrl}${BASE}/${order.id}/confirm`, tokens.tokenStaff, {});
    assert.equal(confirm.status, 200);
    assert.equal((await confirm.json()).data.order.status, 'CONFIRMED');
    assert.equal(repos.resRepo.docs.every((r) => r.status === 'ACTIVE'), true, 'confirm does not touch reservations');

    const process = await request('POST', `${baseUrl}${BASE}/${order.id}/process`, tokens.tokenStaff, {});
    assert.equal(process.status, 200);
    assert.equal((await process.json()).data.order.status, 'PROCESSING');
  }
));

test('reject releases stock; confirming a processed order is a stale 409', withServer(
  () => withCart(),
  async (baseUrl, repos) => {
    await seedCartViaApi(baseUrl, tokens.tokenCustomer, [{ productVariantId: V1, quantity: 3 }]);
    const { order } = await checkout(baseUrl, tokens.tokenCustomer, 'reject-flow');

    const reject = await request('POST', `${baseUrl}${BASE}/${order.id}/reject`, tokens.tokenAdmin, {});
    assert.equal(reject.status, 200);
    assert.equal((await reject.json()).data.order.status, 'REJECTED');
    assert.equal(repos.resRepo.docs[0].status, 'RELEASED', 'reject releases reservations');
    assert.equal(repos.invRepo.docs[0].reservedQuantity, 0);

    const stale = await request('POST', `${baseUrl}${BASE}/${order.id}/confirm`, tokens.tokenAdmin, {});
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error.code, ERROR_CODES.ORDER_CONFIRMATION_NOT_ALLOWED);
  }
));

test('admin list filters by status/customer and paginates', withServer(
  () => withCart(),
  async (baseUrl) => {
    await seedCartViaApi(baseUrl, tokens.tokenCustomer, [{ productVariantId: V1, quantity: 1 }]);
    const first = await checkout(baseUrl, tokens.tokenCustomer, 'page-1');
    await seedCartViaApi(baseUrl, tokens.tokenCustomer2, [{ productVariantId: V2, quantity: 1 }]);
    const second = await checkout(baseUrl, tokens.tokenCustomer2, 'page-2');

    const all = await request('GET', `${baseUrl}${BASE}`, tokens.tokenAdmin);
    assert.equal((await all.json()).data.orders.length, 2);

    const byStatus = await request('GET', `${baseUrl}${BASE}?status=PENDING`, tokens.tokenAdmin);
    assert.equal((await byStatus.json()).data.orders.length, 2);

    const byCustomer = await request('GET', `${baseUrl}${BASE}?customerId=507f1f77bcf86cd799439111`, tokens.tokenAdmin);
    assert.equal((await byCustomer.json()).data.orders.length, 1);

    const page = await request('GET', `${baseUrl}${BASE}?page=1&limit=1`, tokens.tokenAdmin);
    const pageBody = await page.json();
    assert.equal(pageBody.data.orders.length, 1);
    assert.equal(pageBody.data.pagination.total, 2);
    assert.equal(first.res.status, 201);
    assert.equal(second.res.status, 201);
  }
));

test('performedBy and status in admin bodies are rejected (400)', withServer(
  () => withCart(),
  async (baseUrl) => {
    await seedCartViaApi(baseUrl, tokens.tokenCustomer, [{ productVariantId: V1, quantity: 1 }]);
    const { order } = await checkout(baseUrl, tokens.tokenCustomer, 'inject-key');

    const res = await request('POST', `${baseUrl}${BASE}/${order.id}/confirm`, tokens.tokenAdmin, {
      performedBy: '507f1f77bcf86cd799439999',
      status: 'PROCESSING',
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, ERROR_CODES.INVALID_ORDER);
  }
));

test('admin detail exposes money and address but no internal fields', withServer(
  () => withCart(),
  async (baseUrl) => {
    await seedCartViaApi(baseUrl, tokens.tokenCustomer, [{ productVariantId: V1, quantity: 1 }]);
    const { order } = await checkout(baseUrl, tokens.tokenCustomer, 'detail-key');

    const detail = await request('GET', `${baseUrl}${BASE}/${order.id}`, tokens.tokenAdmin);
    assert.equal(detail.status, 200);
    const body = await detail.json();
    assert.equal(body.data.order.id, order.id);
    assert.equal(typeof body.data.order.totals.grandTotalMinorUnits, 'number');
    assert.equal(typeof body.data.order.delivery.address.line1, 'string');
    assert.equal(body.data.order.purchasePriceMinorUnits, undefined);
    assert.equal(body.data.order.reservationReference.referenceType, 'ORDER');
    assert.equal(body.data.order.reservationReference.reservationIds.length, 1, 'admin traceability');
    assert.equal(body.data.order.__v, undefined);
    assert.equal(body.data.order._id, undefined);
    assert.equal(body.data.order.reservations, undefined, 'raw reservation collection never leaks');
    assert.equal(JSON.stringify(body).includes('reservedQuantity'), false, 'no reservation internals leakage');
  }
));
