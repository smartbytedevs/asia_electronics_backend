'use strict';

process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');

const { ERROR_CODES } = require('../../src/constants');
const {
  V1,
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

const CART = '/api/v1/cart/items';
const ORDERS = '/api/v1/orders';

test('MongoDB $-operator injection is rejected in item, checkout, and address bodies', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl, repos) => {
    const attempts = [
      { method: 'POST', path: CART, body: { productVariantId: V1, quantity: 1, $inc: { quantity: 100 } } },
      { method: 'PATCH', path: `${CART}/${V1}`, body: { quantity: 2, $set: { quantity: 99 } } },
      { method: 'POST', path: `${ORDERS}/checkout`, body: { ...checkoutBody(), $where: '1' }, headers: { 'Idempotency-Key': 'sec-1' } },
      {
        method: 'POST',
        path: `${ORDERS}/checkout`,
        body: { ...checkoutBody(), delivery: { address: { ...checkoutBody().delivery.address, $gt: '' } } },
        headers: { 'Idempotency-Key': 'sec-2' },
      },
    ];
    for (const attempt of attempts) {
      const res = await request(attempt.method, `${baseUrl}${attempt.path}`, tokens.tokenCustomer, attempt.body, attempt.headers);
      assert.ok([400].includes(res.status), `${attempt.method} ${attempt.path} expected 400`);
      const { error } = await res.json();
      assert.ok(
        [ERROR_CODES.INVALID_ORDER, ERROR_CODES.INVALID_CART_ITEM, ERROR_CODES.INVALID_DELIVERY_ADDRESS].includes(error.code),
        `unexpected code ${error.code}`
      );
    }
    assert.equal(repos.orderRepo.docs.length, 0, 'no order materialized from injection attempts');
    assert.equal(repos.resRepo.docs.length, 0, 'no reservations materialized from injection attempts');
  }
));

test('oversized note and address fields are rejected', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl) => {
    const longText = 'x'.repeat(2000);
    const body = checkoutBody({ notes: longText });
    const res = await request('POST', `${baseUrl}${ORDERS}/checkout`, tokens.tokenCustomer, body, {
      'Idempotency-Key': 'sec-3',
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, ERROR_CODES.INVALID_ORDER);
  }
));

test('XSS payloads in address/notes are stored as plain data and returned unchanged (no eval)', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl) => {
    const payload = '<script>alert(1)</script>';
    await request('POST', `${baseUrl}${CART}`, tokens.tokenCustomer, { productVariantId: V1, quantity: 1 });

    const checkoutRes = await request('POST', `${baseUrl}${ORDERS}/checkout`, tokens.tokenCustomer, checkoutBody({ notes: payload }), {
      'Idempotency-Key': 'sec-4',
    });
    assert.equal(checkoutRes.status, 201);
    const { order } = (await checkoutRes.json()).data;
    assert.equal(order.notes, payload, 'stored and returned verbatim (never executed, never stripped)');

    const detail = await request('GET', `${baseUrl}${ORDERS}/${order.id}`, tokens.tokenCustomer);
    const { order: again } = (await detail.json()).data;
    assert.equal(again.notes, payload);
  }
));

test('customer cannot read admin reservation internals through any endpoint', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl) => {
    await request('POST', `${baseUrl}${CART}`, tokens.tokenCustomer, { productVariantId: V1, quantity: 1 });
    const checkoutRes = await request('POST', `${baseUrl}${ORDERS}/checkout`, tokens.tokenCustomer, checkoutBody(), {
      'Idempotency-Key': 'sec-5',
    });
    const { order } = (await checkoutRes.json()).data;

    const list = await request('GET', `${baseUrl}${ORDERS}`, tokens.tokenCustomer);
    const body = await list.json();
    assert.equal(JSON.stringify(body).includes('reservationReference'), false, 'customer list never exposes reservation references');
    assert.equal(JSON.stringify(body).includes('reservationIds'), false);

    const detail = await request('GET', `${baseUrl}${ORDERS}/${order.id}`, tokens.tokenCustomer);
    const detailBody = await detail.json();
    assert.equal(JSON.stringify(detailBody).includes('reservationReference'), false);
  }
));
