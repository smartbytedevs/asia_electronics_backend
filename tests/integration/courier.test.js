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
const { createMockCourierProvider } = require('../../src/modules/courier/courier.provider.mock');
const {
  CourierProviderError,
  COURIER_PROVIDER_ERROR_CODES,
} = require('../../src/modules/courier/courier.errors');

let tokens;

before(async () => {
  tokens = await setupAuth();
});

const WEBHOOK_SECRET = 'test-secret';

function withApp() {
  return buildApp({ users: seedUsers() });
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

async function confirmedOrder(baseUrl, key) {
  await seedCartViaApi(baseUrl, tokens.tokenCustomer, [{ productVariantId: V1, quantity: 1 }]);
  const { order } = await checkout(baseUrl, tokens.tokenCustomer, key);
  const confirm = await request('POST', `${baseUrl}/api/v1/admin/orders/${order.id}/confirm`, tokens.tokenAdmin, {});
  assert.equal(confirm.status, 200);
  return { order, confirm };
}

function dispatchUrl(orderId) {
  return `/api/v1/admin/orders/${orderId}/courier/dispatch`;
}

async function dispatch(baseUrl, orderId, token = tokens.tokenStaff, body = {}) {
  return request('POST', `${baseUrl}${dispatchUrl(orderId)}`, token, body);
}

async function adminOrderStatus(baseUrl, orderId) {
  const res = await request('GET', `${baseUrl}/api/v1/admin/orders/${orderId}`, tokens.tokenStaff);
  assert.equal(res.status, 200);
  return (await res.json()).data.order.status;
}

function webhook(baseUrl, body, signature = WEBHOOK_SECRET, headers = {}) {
  const headerMap = { ...headers };
  if (signature) {
    headerMap['X-Pathao-Signature'] = signature;
  }
  return request('POST', `${baseUrl}/api/v1/webhooks/pathao`, undefined, body, headerMap);
}

function deliveredWebhookBody(consignmentId, orderNumber) {
  return {
    consignment_id: consignmentId,
    merchant_order_id: orderNumber,
    order_status: 'Delivered',
    order_status_updated_at: '2026-08-08 10:00:00',
    event: 'delivery_status',
  };
}

test('courier endpoints require authentication (401)', withServer(
  () => withApp(),
  async (baseUrl) => {
    const orderId = '507f1f77bcf86cd799439111';
    const shipmentId = '507f1f77bcf86cd799439222';
    for (const [path, method] of [
      [dispatchUrl(orderId), 'POST'],
      [`/api/v1/admin/shipments/${shipmentId}/retry`, 'POST'],
      [`/api/v1/admin/shipments/${shipmentId}/cancel`, 'POST'],
      ['/api/v1/admin/shipments', 'GET'],
      [`/api/v1/admin/shipments/${shipmentId}`, 'GET'],
      [`/api/v1/orders/${orderId}/tracking`, 'GET'],
    ]) {
      const res = await request(method, `${baseUrl}${path}`);
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal((await res.json()).error.code, ERROR_CODES.UNAUTHORIZED);
    }
  }
));

test('CUSTOMER role is forbidden from admin courier endpoints (403)', withServer(
  () => withApp(),
  async (baseUrl) => {
    const res = await request('GET', `${baseUrl}/api/v1/admin/shipments`, tokens.tokenCustomer);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, ERROR_CODES.FORBIDDEN);
  }
));

test('dispatch requires a CONFIRMED order (409 COURIER_DISPATCH_NOT_ALLOWED)', withServer(
  () => withApp(),
  async (baseUrl) => {
    await seedCartViaApi(baseUrl, tokens.tokenCustomer, [{ productVariantId: V1, quantity: 1 }]);
    const { order } = await checkout(baseUrl, tokens.tokenCustomer, 'not-confirmed');

    const res = await dispatch(baseUrl, order.id);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, ERROR_CODES.COURIER_DISPATCH_NOT_ALLOWED);
  }
));

test('manual-method orders (BKASH) cannot be confirmed until the payment is VERIFIED', withServer(
  () => withApp(),
  async (baseUrl, repos) => {
    await seedCartViaApi(baseUrl, tokens.tokenCustomer, [{ productVariantId: V1, quantity: 1 }]);
    const { order } = await checkout(
      baseUrl,
      tokens.tokenCustomer,
      'bkash-dispatch',
      checkoutBody({ paymentMethod: 'BKASH' })
    );
    assert.equal(order.paymentMethod, 'BKASH');
    assert.equal(order.totals.grandTotalMinorUnits, 108000);

    const blocked = await request(
      'POST',
      `${baseUrl}/api/v1/admin/orders/${order.id}/confirm`,
      tokens.tokenAdmin,
      {}
    );
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).error.code, ERROR_CODES.ORDER_CONFIRMATION_NOT_ALLOWED);

    await repos.paymentRepo.create({ orderId: order.id, status: 'VERIFIED', statusHistory: [] });

    const confirm = await request(
      'POST',
      `${baseUrl}/api/v1/admin/orders/${order.id}/confirm`,
      tokens.tokenAdmin,
      {}
    );
    assert.equal(confirm.status, 200);

    const res = await dispatch(baseUrl, order.id);
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.data.shipment.status, 'ACTIVE');
    assert.equal(
      body.data.shipment.amountToCollectMinorUnits,
      0,
      'a VERIFIED payment is not collected again at the door'
    );
  }
));

test('dispatch auto-advances a PROCESSING order to DISPATCHED', withServer(
  () => withApp(),
  async (baseUrl, repos) => {
    const { order } = await confirmedOrder(baseUrl, 'processing-dispatch');
    const process = await request('POST', `${baseUrl}/api/v1/admin/orders/${order.id}/process`, tokens.tokenStaff, {});
    assert.equal(process.status, 200);
    assert.equal(repos.orderRepo.docs[0].status, 'PROCESSING');

    const res = await dispatch(baseUrl, order.id);
    assert.equal(res.status, 201);
    assert.equal(repos.shipmentRepo.docs[0].status, 'ACTIVE');
    assert.equal(
      await adminOrderStatus(baseUrl, order.id),
      'DISPATCHED',
      'successful dispatch auto-advances a PROCESSING order to DISPATCHED'
    );
  }
));

test('staff dispatches a confirmed order; re-dispatch is idempotent; ship/deliver are staff steps', withServer(
  () => withApp(),
  async (baseUrl, repos) => {
    const { order } = await confirmedOrder(baseUrl, 'happy-path');

    const first = await dispatch(baseUrl, order.id);
    assert.equal(first.status, 201);
    const firstBody = await first.json();
    assert.equal(firstBody.data.shipment.status, 'ACTIVE');
    assert.equal(firstBody.data.shipment.orderId, order.id);
    const consignmentId = firstBody.data.shipment.consignmentId;
    assert.match(consignmentId, /^MOCK-\d+$/);
    assert.equal(firstBody.data.shipment.fees.providerDeliveryFeeMinorUnits, 6000);
    assert.equal(
      await adminOrderStatus(baseUrl, order.id),
      'DISPATCHED',
      'dispatch moves a CONFIRMED order to DISPATCHED'
    );

    const again = await dispatch(baseUrl, order.id);
    assert.equal(again.status, 201);
    assert.equal((await again.json()).data.shipment.consignmentId, consignmentId, 're-dispatch reuses the consignment');

    const hook = await webhook(baseUrl, deliveredWebhookBody(consignmentId, order.orderNumber));
    assert.equal(hook.status, 200);
    assert.equal(repos.shipmentRepo.docs[0].status, 'DELIVERED');
    assert.equal(
      await adminOrderStatus(baseUrl, order.id),
      'DISPATCHED',
      'provider DELIVERED never auto-delivers the order'
    );

    const shipped = await request('POST', `${baseUrl}/api/v1/admin/orders/${order.id}/ship`, tokens.tokenStaff, {});
    assert.equal(shipped.status, 200);
    assert.equal((await shipped.json()).data.order.status, 'SHIPPED');
    const delivered = await request('POST', `${baseUrl}/api/v1/admin/orders/${order.id}/deliver`, tokens.tokenStaff, {});
    assert.equal(delivered.status, 200);
    assert.equal((await delivered.json()).data.order.status, 'DELIVERED');

    const detail = await request('GET', `${baseUrl}/api/v1/admin/shipments/${repos.shipmentRepo.docs[0]._id}`, tokens.tokenStaff);
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).data.shipment.status, 'DELIVERED');

    const tracking = await request('GET', `${baseUrl}/api/v1/orders/${order.id}/tracking`, tokens.tokenCustomer);
    assert.equal(tracking.status, 200);
    const trackingData = (await tracking.json()).data.tracking;
    assert.equal(trackingData.status, 'DELIVERED');
    assert.equal(trackingData.consignmentId, consignmentId);
    assert.equal(trackingData.deliveryFeeMinorUnits, 6000);
  }
));

test('tracking is scoped to the owning customer (404 for other customers)', withServer(
  () => withApp(),
  async (baseUrl, repos) => {
    const { order } = await confirmedOrder(baseUrl, 'owner-scope');
    await dispatch(baseUrl, order.id);

    const mine = await request('GET', `${baseUrl}/api/v1/orders/${order.id}/tracking`, tokens.tokenCustomer);
    assert.equal(mine.status, 200);
    assert.equal((await mine.json()).data.tracking.status, 'ACTIVE');

    const theirs = await request('GET', `${baseUrl}/api/v1/orders/${order.id}/tracking`, tokens.tokenCustomer2);
    assert.equal(theirs.status, 404);
    assert.equal((await theirs.json()).error.code, ERROR_CODES.ORDER_NOT_FOUND);
  }
));

test('undispatched order resolves tracking as null', withServer(
  () => withApp(),
  async (baseUrl) => {
    await seedCartViaApi(baseUrl, tokens.tokenCustomer, [{ productVariantId: V1, quantity: 1 }]);
    const { order } = await checkout(baseUrl, tokens.tokenCustomer, 'undispatched');

    const res = await request('GET', `${baseUrl}/api/v1/orders/${order.id}/tracking`, tokens.tokenCustomer);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.tracking, null);
  }
));

test('webhook rejects a missing or wrong signature (401)', withServer(
  () => withApp(),
  async (baseUrl) => {
    const missing = await webhook(baseUrl, deliveredWebhookBody('MOCK-000001', 'ORD-1'), null);
    assert.equal(missing.status, 401);
    assert.equal((await missing.json()).error.code, ERROR_CODES.COURIER_WEBHOOK_INVALID_SIGNATURE);

    const wrong = await webhook(baseUrl, deliveredWebhookBody('MOCK-000001', 'ORD-1'), 'wrong-secret');
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).error.code, ERROR_CODES.COURIER_WEBHOOK_INVALID_SIGNATURE);
  }
));

test('webhook matches by merchant_order_id and cancels the shipment (order unchanged)', withServer(
  () => withApp(),
  async (baseUrl, repos) => {
    const { order } = await confirmedOrder(baseUrl, 'webhook-by-ref');
    await dispatch(baseUrl, order.id);

    const hook = await webhook(baseUrl, {
      merchant_order_id: order.orderNumber,
      order_status: 'Cancelled',
      order_status_updated_at: '2026-08-08 11:00:00',
      event: 'delivery_status',
    });
    assert.equal(hook.status, 200);
    assert.equal(repos.shipmentRepo.docs[0].status, 'CANCELLED');
    assert.equal(
      await adminOrderStatus(baseUrl, order.id),
      'DISPATCHED',
      'a courier CANCELLED webhook never changes the order'
    );

    const tracking = await request('GET', `${baseUrl}/api/v1/orders/${order.id}/tracking`, tokens.tokenCustomer);
    assert.equal((await tracking.json()).data.tracking.status, 'CANCELLED');
  }
));

test('unknown webhook shipments are acknowledged and ignored', withServer(
  () => withApp(),
  async (baseUrl, repos) => {
    const hook = await webhook(baseUrl, deliveredWebhookBody('MOCK-999999', 'ORD-NOPE'));
    assert.equal(hook.status, 200);
    assert.equal(repos.shipmentRepo.docs.length, 0);
  }
));

test('provider rejection marks the shipment FAILED; retry dispatches it', withServer(
  () => withApp(),
  async (baseUrl, repos) => {
    const { order } = await confirmedOrder(baseUrl, 'retry-flow');
    const provider = repos.courierService.provider;

    provider._harness.failNextSubmitWith(
      new CourierProviderError(
        COURIER_PROVIDER_ERROR_CODES.PROVIDER_REJECTED,
        'rate limited by provider'
      )
    );
    const failed = await dispatch(baseUrl, order.id);
    assert.equal(failed.status, 400);
    assert.equal((await failed.json()).error.code, ERROR_CODES.COURIER_PROVIDER_REJECTED);
    assert.equal(repos.shipmentRepo.docs[0].status, 'FAILED');

    const retried = await request('POST', `${baseUrl}/api/v1/admin/shipments/${repos.shipmentRepo.docs[0]._id}/retry`, tokens.tokenStaff, {});
    assert.equal(retried.status, 200);
    const retriedBody = await retried.json();
    assert.equal(retriedBody.data.shipment.status, 'ACTIVE');
    assert.match(retriedBody.data.shipment.consignmentId, /^MOCK-\d+$/);
  }
));

test('an ACTIVE shipment can be cancelled through the provider (order unchanged)', withServer(
  () => withApp(),
  async (baseUrl, repos) => {
    const { order } = await confirmedOrder(baseUrl, 'cancel-flow');
    await dispatch(baseUrl, order.id);
    const shipmentId = repos.shipmentRepo.docs[0]._id;
    const consignmentId = repos.shipmentRepo.docs[0].consignmentId;

    const cancel = await request('POST', `${baseUrl}/api/v1/admin/shipments/${shipmentId}/cancel`, tokens.tokenStaff, {});
    assert.equal(cancel.status, 200);
    assert.equal((await cancel.json()).data.shipment.status, 'CANCELLED');
    assert.equal(repos.courierService.provider._harness._registry.get(consignmentId).status, 'Cancelled');
    assert.equal(
      await adminOrderStatus(baseUrl, order.id),
      'DISPATCHED',
      'admin shipment cancel is decoupled from the order'
    );
  }
));

test('a DELIVERED shipment cannot be cancelled (409 COURIER_INVALID_STATE)', withServer(
  () => withApp(),
  async (baseUrl, repos) => {
    const { order } = await confirmedOrder(baseUrl, 'delivered-cancel');
    await dispatch(baseUrl, order.id);
    const shipmentId = repos.shipmentRepo.docs[0]._id;
    const consignmentId = repos.shipmentRepo.docs[0].consignmentId;

    await webhook(baseUrl, deliveredWebhookBody(consignmentId, order.orderNumber));
    const cancel = await request('POST', `${baseUrl}/api/v1/admin/shipments/${shipmentId}/cancel`, tokens.tokenStaff, {});
    assert.equal(cancel.status, 409);
    assert.equal((await cancel.json()).error.code, ERROR_CODES.COURIER_INVALID_STATE);
  }
));

test('customer order cancel propagates to the courier shipment', withServer(
  () => withApp(),
  async (baseUrl, repos) => {
    const { order } = await confirmedOrder(baseUrl, 'order-cancel-hook');
    await dispatch(baseUrl, order.id);
    assert.equal(repos.shipmentRepo.docs[0].status, 'ACTIVE');

    const cancel = await request('POST', `${baseUrl}/api/v1/orders/${order.id}/cancel`, tokens.tokenCustomer, {});
    assert.equal(cancel.status, 200);
    assert.equal((await cancel.json()).data.order.status, 'CANCELLED');
    assert.equal(repos.shipmentRepo.docs[0].status, 'CANCELLED', 'courier shipment follows the order cancel');
  }
));

test('confirming an order auto-dispatches it when enabled', withServer(
  () => buildApp({ users: seedUsers(), autoDispatchOnConfirm: true }),
  async (baseUrl, repos) => {
    await seedCartViaApi(baseUrl, tokens.tokenCustomer, [{ productVariantId: V1, quantity: 1 }]);
    const { order } = await checkout(baseUrl, tokens.tokenCustomer, 'auto-dispatch');

    const confirm = await request('POST', `${baseUrl}/api/v1/admin/orders/${order.id}/confirm`, tokens.tokenAdmin, {});
    assert.equal(confirm.status, 200);
    assert.equal((await confirm.json()).data.order.status, 'CONFIRMED');

    assert.equal(repos.shipmentRepo.docs.length, 1, 'confirmation created a shipment');
    assert.equal(repos.shipmentRepo.docs[0].status, 'ACTIVE', 'shipment auto-dispatched');
    assert.match(repos.shipmentRepo.docs[0].consignmentId, /^MOCK-\d+$/);
    assert.equal(
      await adminOrderStatus(baseUrl, order.id),
      'DISPATCHED',
      'auto-dispatch moves the order to DISPATCHED'
    );
  }
));

test('invalid dispatch body is rejected (400 INVALID_COURIER_REQUEST)', withServer(
  () => withApp(),
  async (baseUrl) => {
    const { order } = await confirmedOrder(baseUrl, 'bad-body');
    const res = await dispatch(baseUrl, order.id, tokens.tokenStaff, { $operator: true });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, ERROR_CODES.INVALID_COURIER_REQUEST);
  }
));
