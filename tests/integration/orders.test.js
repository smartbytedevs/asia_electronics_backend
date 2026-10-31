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

const BASE = '/api/v1/orders';

function withCart(users = seedUsers()) {
  return buildApp({ users });
}

async function seedCartViaApi(baseUrl, token, items) {
  for (const item of items) {
    await request('POST', `${baseUrl}/api/v1/cart/items`, token, item);
  }
}

function checkoutHeaders(key) {
  return { 'Idempotency-Key': key };
}

test('order endpoints require authentication (401)', withServer(
  () => withCart(),
  async (baseUrl) => {
    for (const [path, method] of [
      [`${BASE}/checkout`, 'POST'],
      [BASE, 'GET'],
      [`${BASE}/507f1f77bcf86cd799439099`, 'GET'],
      [`${BASE}/507f1f77bcf86cd799439099/cancel`, 'POST'],
    ]) {
      const res = await request(method, `${baseUrl}${path}`);
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal((await res.json()).error.code, ERROR_CODES.UNAUTHORIZED);
    }
  }
));

test('STAFF and ADMIN are forbidden from customer order endpoints (403)', withServer(
  () => withCart(),
  async (baseUrl) => {
    for (const token of [tokens.tokenStaff, tokens.tokenAdmin]) {
      const res = await request('POST', `${baseUrl}${BASE}/checkout`, token, checkoutBody(), checkoutHeaders('k'));
      assert.equal(res.status, 403);
      assert.equal((await res.json()).error.code, ERROR_CODES.FORBIDDEN);
    }
  }
));

test('checkout creates a PENDING order with server-derived money/zone and clears the cart', withServer(
  () => withCart(),
  async (baseUrl, repos) => {
    await seedCartViaApi(baseUrl, tokens.tokenCustomer, [
      { productVariantId: V1, quantity: 2 },
      { productVariantId: V2, quantity: 1 },
    ]);

    const res = await request('POST', `${baseUrl}${BASE}/checkout`, tokens.tokenCustomer, checkoutBody(), checkoutHeaders('key-1'));
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.success, true);
    const order = body.data.order;
    assert.equal(order.status, 'PENDING');
    assert.match(order.orderNumber, /^TAQ-\d{8}-\d{6}$/);
    assert.equal(order.delivery.zone, 'INSIDE_CHITTAGONG');
    assert.equal(order.totals.itemsSubtotalMinorUnits, 254000);
    assert.equal(order.totals.totalDiscountMinorUnits, 6000);
    assert.equal(order.totals.grandTotalMinorUnits, 256000);
    assert.equal(order.reservationReference, undefined, 'reservation internals hidden from the customer');
    assert.equal(order.customerId, '507f1f77bcf86cd799439111');
    assert.equal(order.items.length, 2);

    assert.equal(repos.resRepo.docs.length, 2, 'one reservation per line');
    assert.equal(repos.invRepo.docs[0].reservedQuantity, 2);
    assert.equal(repos.cartRepo.docs[0].isCheckedOut, true);
    assert.equal(repos.cartRepo.docs[0].items.length, 0);
  }
));

test('checkout records BKASH, BANK_TRANSFER and CARD; rejects an unknown method', withServer(
  () => withCart(),
  async (baseUrl) => {
    for (const [method, key] of [
      ['BKASH', 'key-bkash'],
      ['BANK_TRANSFER', 'key-bank'],
      ['CARD', 'key-card'],
    ]) {
      await seedCartViaApi(baseUrl, tokens.tokenCustomer, [{ productVariantId: V1, quantity: 1 }]);
      const res = await request(
        'POST',
        `${baseUrl}${BASE}/checkout`,
        tokens.tokenCustomer,
        checkoutBody({ paymentMethod: method }),
        checkoutHeaders(key)
      );
      assert.equal(res.status, 201, `${method}: checkout must succeed`);
      assert.equal((await res.json()).data.order.paymentMethod, method);
    }

    await seedCartViaApi(baseUrl, tokens.tokenCustomer, [{ productVariantId: V1, quantity: 1 }]);
    const res = await request(
      'POST',
      `${baseUrl}${BASE}/checkout`,
      tokens.tokenCustomer,
      checkoutBody({ paymentMethod: 'UPI' }),
      checkoutHeaders('key-upi')
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, ERROR_CODES.INVALID_ORDER);
  }
));

test('checkout without an Idempotency-Key is rejected (400)', withServer(
  () => withCart(),
  async (baseUrl) => {
    await seedCartViaApi(baseUrl, tokens.tokenCustomer, [{ productVariantId: V1, quantity: 1 }]);
    const res = await request('POST', `${baseUrl}${BASE}/checkout`, tokens.tokenCustomer, checkoutBody());
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, ERROR_CODES.INVALID_ORDER);
  }
));

test('checkout is idempotent: retry returns the same order, different body conflicts', withServer(
  () => withCart(),
  async (baseUrl, repos) => {
    await seedCartViaApi(baseUrl, tokens.tokenCustomer, [{ productVariantId: V1, quantity: 1 }]);

    const first = await request('POST', `${baseUrl}${BASE}/checkout`, tokens.tokenCustomer, checkoutBody(), checkoutHeaders('idem-1'));
    const firstBody = await first.json();
    assert.equal(first.status, 201);

    const retry = await request('POST', `${baseUrl}${BASE}/checkout`, tokens.tokenCustomer, checkoutBody(), checkoutHeaders('idem-1'));
    assert.equal(retry.status, 200);
    const retryBody = await retry.json();
    assert.equal(retryBody.data.order.id, firstBody.data.order.id);
    assert.equal(repos.orderRepo.docs.length, 1, 'no duplicate order');
    assert.equal(repos.resRepo.docs.length, 1, 'no double reservation');

    const conflict = await request('POST', `${baseUrl}${BASE}/checkout`, tokens.tokenCustomer, checkoutBody({ notes: 'changed' }), checkoutHeaders('idem-1'));
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, ERROR_CODES.ORDER_IDEMPOTENCY_CONFLICT);
  }
));

test('checkout rejects client money, fee, invalid zone, status, and identity fields', withServer(
  () => withCart(),
  async (baseUrl) => {
    const badBodies = [
      checkoutBody({ delivery: { address: { city: 'Dhaka', district: 'Dhaka', fullName: 'A', phone: '1', line1: 'L', area: 'A', postalCode: '1', country: 'BD' }, deliveryFeeMinorUnits: 5000 } }),
      checkoutBody({ delivery: { address: { city: 'Dhaka', district: 'Dhaka', fullName: 'A', phone: '1', line1: 'L', area: 'A', postalCode: '1', country: 'BD' }, zone: 'DHAKA' } }),
      { ...checkoutBody(), totals: { grandTotalMinorUnits: 1 } },
      { ...checkoutBody(), status: 'CONFIRMED' },
      { ...checkoutBody(), customerId: '507f1f77bcf86cd799439999' },
    ];
    for (const body of badBodies) {
      await seedCartViaApi(baseUrl, tokens.tokenCustomer, [{ productVariantId: V1, quantity: 1 }]);
      const res = await request('POST', `${baseUrl}${BASE}/checkout`, tokens.tokenCustomer, body, checkoutHeaders('bad-body'));
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error.code, ERROR_CODES.INVALID_ORDER);
    }
  }
));

test('checkout without a cart (404) and of an existing empty cart (400)', withServer(
  () => withCart(),
  async (baseUrl) => {
    const noCart = await request('POST', `${baseUrl}${BASE}/checkout`, tokens.tokenCustomer, checkoutBody(), checkoutHeaders('empty-key'));
    assert.equal(noCart.status, 404);
    assert.equal((await noCart.json()).error.code, ERROR_CODES.CART_NOT_FOUND);

    await request('GET', `${baseUrl}/api/v1/cart`, tokens.tokenCustomer);
    const emptyCart = await request('POST', `${baseUrl}${BASE}/checkout`, tokens.tokenCustomer, checkoutBody(), checkoutHeaders('empty-key-2'));
    assert.equal(emptyCart.status, 400);
    assert.equal((await emptyCart.json()).error.code, ERROR_CODES.CART_EMPTY);
  }
));

test('checkout with insufficient online stock fails and does not clear the cart', withServer(
  () => withCart(),
  async (baseUrl, repos) => {
    await seedCartViaApi(baseUrl, tokens.tokenCustomer, [{ productVariantId: V1, quantity: 25 }]);
    const res = await request('POST', `${baseUrl}${BASE}/checkout`, tokens.tokenCustomer, checkoutBody(), checkoutHeaders('stock-key'));
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, ERROR_CODES.INSUFFICIENT_AVAILABLE_STOCK);
    assert.equal(repos.orderRepo.docs.length, 0, 'no order created');
    assert.equal(repos.resRepo.docs.length, 0, 'no reservations leaked');
    assert.equal(repos.cartRepo.docs[0].isCheckedOut, false, 'cart is untouched on failure');
  }
));

test('list + detail + cancel are strictly customer-scoped (IDOR → 404)', withServer(
  () => withCart(),
  async (baseUrl, repos) => {
    await seedCartViaApi(baseUrl, tokens.tokenCustomer, [{ productVariantId: V1, quantity: 1 }]);
    const created = await request('POST', `${baseUrl}${BASE}/checkout`, tokens.tokenCustomer, checkoutBody(), checkoutHeaders('scoped-key'));
    const { order } = (await created.json()).data;
    const orderId = order.id;

    const myList = await request('GET', `${baseUrl}${BASE}`, tokens.tokenCustomer);
    assert.equal(myList.status, 200);
    assert.equal((await myList.json()).data.orders.length, 1);

    const myDetail = await request('GET', `${baseUrl}${BASE}/${orderId}`, tokens.tokenCustomer);
    assert.equal(myDetail.status, 200);
    assert.equal((await myDetail.json()).data.order.id, orderId);

    const otherList = await request('GET', `${baseUrl}${BASE}`, tokens.tokenCustomer2);
    assert.equal((await otherList.json()).data.orders.length, 0, 'history never leaks');

    for (const path of [`${BASE}/${orderId}`, `${BASE}/${orderId}/cancel`]) {
      const method = path.endsWith('/cancel') ? 'POST' : 'GET';
      const res = await request(method, `${baseUrl}${path}`, tokens.tokenCustomer2);
      assert.equal(res.status, 404, `cross-customer ${path}`);
      assert.equal((await res.json()).error.code, ERROR_CODES.ORDER_NOT_FOUND);
    }
  }
));

test('customer cancel releases stock and a second cancel is rejected', withServer(
  () => withCart(),
  async (baseUrl, repos) => {
    await seedCartViaApi(baseUrl, tokens.tokenCustomer, [{ productVariantId: V1, quantity: 2 }]);
    const created = await request('POST', `${baseUrl}${BASE}/checkout`, tokens.tokenCustomer, checkoutBody(), checkoutHeaders('cancel-key'));
    const { order } = (await created.json()).data;

    const cancelled = await request('POST', `${baseUrl}${BASE}/${order.id}/cancel`, tokens.tokenCustomer, {});
    assert.equal(cancelled.status, 200);
    const cancelledBody = await cancelled.json();
    assert.equal(cancelledBody.data.order.status, 'CANCELLED');
    assert.equal(repos.resRepo.docs[0].status, 'RELEASED', 'reservation released on cancel');
    assert.equal(repos.invRepo.docs[0].reservedQuantity, 0);

    const second = await request('POST', `${baseUrl}${BASE}/${order.id}/cancel`, tokens.tokenCustomer, {});
    assert.equal(second.status, 409);
    assert.equal((await second.json()).error.code, ERROR_CODES.ORDER_CANCELLATION_NOT_ALLOWED);
  }
));
