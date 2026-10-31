'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { CourierService } = require('../../../src/modules/courier/courier.service');
const { createMockCourierProvider } = require('../../../src/modules/courier/courier.provider.mock');
const {
  CourierProviderError,
  COURIER_PROVIDER_ERROR_CODES,
} = require('../../../src/modules/courier/courier.errors');
const { COURIER_STATUSES } = require('../../../src/modules/courier/courier.constants');
const { ERROR_CODES } = require('../../../src/constants');
const { createMemoryShipmentRepository } = require('../../helpers/courier-stubs');
const { createMemoryOrderRepository } = require('../../helpers/order-stubs');
const { createMemoryPaymentRepository } = require('../../helpers/payment-stubs');

const CUSTOMER_ID = '507f1f77bcf86cd799439011';
const STAFF_ID = '507f1f77bcf86cd799439022';
const OTHER_CUSTOMER_ID = '507f1f77bcf86cd799439033';
const ORDER_ID = '507f1f77bcf86cd7994390b1';

function orderDoc(overrides = {}) {
  return {
    _id: ORDER_ID,
    customerId: CUSTOMER_ID,
    orderNumber: 'TAQ-20260808-000001',
    status: 'CONFIRMED',
    paymentMethod: 'COD',
    totals: {
      itemsSubtotalMinorUnits: 100000,
      totalDiscountMinorUnits: 0,
      deliveryFeeMinorUnits: 0,
      grandTotalMinorUnits: 100000,
    },
    delivery: {
      address: {
        fullName: 'Ayesha Siddiqua',
        phone: '01712345678',
        line1: 'House 12, Road 5',
        line2: null,
        city: 'Chattogram',
        area: 'GEC',
        district: 'Chattogram',
        postalCode: '4000',
        country: 'BD',
      },
      zone: 'INSIDE_CHITTAGONG',
      deliveryFeeMinorUnits: 0,
    },
    items: [{ productName: 'Abaya', quantity: 2 }],
    notes: null,
    ...overrides,
  };
}

function build({ shipments = [], orders = [], payments = [], provider } = {}) {
  const shipmentRepo = createMemoryShipmentRepository(shipments);
  const orderRepo = createMemoryOrderRepository(orders);
  const paymentRepo = createMemoryPaymentRepository(payments);
  const activeProvider = provider || createMockCourierProvider();
  const service = new CourierService({
    shipmentRepository: shipmentRepo,
    orderRepository: orderRepo,
    paymentRepository: paymentRepo,
    provider: activeProvider,
    config: { webhookSecret: 'webhook-secret' },
  });
  return { service, shipmentRepo, orderRepo, paymentRepo, provider: activeProvider };
}

function paymentDoc(status, overrides = {}) {
  return {
    _id: '507f1f77bcf86cd799439c01',
    orderId: ORDER_ID,
    orderNumber: 'TAQ-20260808-000001',
    status,
    ...overrides,
  };
}

test('dispatchForOrder creates a PENDING shipment and submits it to ACTIVE', async () => {
  const { service, provider, shipmentRepo } = build({ orders: [orderDoc()] });

  const outcome = await service.dispatchForOrder({ orderId: ORDER_ID, performedBy: STAFF_ID });

  assert.equal(outcome.shipment.status, COURIER_STATUSES.ACTIVE);
  assert.equal(outcome.shipment.provider, 'mock');
  assert.ok(outcome.shipment.consignmentId);
  assert.equal(outcome.shipment.amountToCollectMinorUnits, 100000);
  assert.equal(outcome.shipment.fees.providerDeliveryFeeMinorUnits, 6000);
  assert.equal(outcome.shipment.submission.attempts, 1);

  const statuses = outcome.shipment.statusHistory.map((entry) => entry.status);
  assert.deepEqual(statuses, [COURIER_STATUSES.PENDING, COURIER_STATUSES.ACTIVE]);

  const stored = shipmentRepo.docs[0];
  assert.equal(String(stored.dispatch.requestedBy), STAFF_ID);
  assert.equal(provider._harness._registry.size, 1);
});

test('dispatchForOrder with an ACTIVE shipment is an idempotent no-op', async () => {
  const provider = createMockCourierProvider();
  const { service } = build({ orders: [orderDoc()], provider });

  await service.dispatchForOrder({ orderId: ORDER_ID, performedBy: STAFF_ID });
  const again = await service.dispatchForOrder({ orderId: ORDER_ID, performedBy: STAFF_ID });

  assert.equal(provider._harness._registry.size, 1, 'only one consignment may be created');
  assert.equal(again.shipment.status, COURIER_STATUSES.ACTIVE);
});

test('dispatchForOrder on a terminal shipment rejects with SHIPMENT_EXISTS', async () => {
  const provider = createMockCourierProvider();
  const { service, shipmentRepo } = build({ orders: [orderDoc()], provider });
  await service.dispatchForOrder({ orderId: ORDER_ID, performedBy: STAFF_ID });
  shipmentRepo.docs[0].status = COURIER_STATUSES.DELIVERED;

  await assert.rejects(
    service.dispatchForOrder({ orderId: ORDER_ID, performedBy: STAFF_ID }),
    (err) => err.code === ERROR_CODES.COURIER_SHIPMENT_EXISTS && err.statusCode === 409
  );
});

test('dispatchForOrder rejects when the order is not CONFIRMED', async () => {
  const { service } = build({ orders: [orderDoc({ status: 'PENDING' })] });

  await assert.rejects(
    service.dispatchForOrder({ orderId: ORDER_ID, performedBy: STAFF_ID }),
    (err) => err.code === ERROR_CODES.COURIER_DISPATCH_NOT_ALLOWED && err.statusCode === 409
  );
});

test('dispatchForOrder on a missing order rejects with ORDER_NOT_FOUND', async () => {
  const { service } = build({ orders: [] });

  await assert.rejects(
    service.dispatchForOrder({ orderId: ORDER_ID, performedBy: STAFF_ID }),
    (err) => err.code === ERROR_CODES.ORDER_NOT_FOUND && err.statusCode === 404
  );
});

test('COD orders dispatch with the full order total as cash to collect', async () => {
  const { service, provider } = build({ orders: [orderDoc()] });

  const outcome = await service.dispatchForOrder({ orderId: ORDER_ID, performedBy: STAFF_ID });

  assert.equal(outcome.shipment.status, COURIER_STATUSES.ACTIVE);
  assert.equal(outcome.shipment.amountToCollectMinorUnits, 100000);
  assert.equal(
    provider._harness._registry.get(outcome.shipment.consignmentId).amountToCollectMinorUnits,
    100000,
    'COD collects the full total from the recipient'
  );
});

test('unverified manual-method orders (no payment) dispatch with the full order total to collect', async () => {
  for (const paymentMethod of ['BKASH', 'BANK_TRANSFER', 'MANUAL']) {
    const { service, provider, paymentRepo } = build({ orders: [orderDoc({ paymentMethod })] });

    const outcome = await service.dispatchForOrder({ orderId: ORDER_ID, performedBy: STAFF_ID });

    assert.equal(outcome.shipment.status, COURIER_STATUSES.ACTIVE, `${paymentMethod}: dispatch succeeds`);
    assert.equal(paymentRepo.docs.length, 0, `${paymentMethod}: no payment record was created`);
    assert.equal(
      outcome.shipment.amountToCollectMinorUnits,
      100000,
      `${paymentMethod}: an unpaid manual order is collected in full`
    );
    assert.equal(
      provider._harness._registry.get(outcome.shipment.consignmentId).amountToCollectMinorUnits,
      100000,
      `${paymentMethod}: provider receives the full total`
    );
    assert.equal(provider._harness._registry.size, 1);
  }
});

test('submitted (pending-review) manual-method orders still dispatch with the full order total to collect', async () => {
  for (const paymentMethod of ['BKASH', 'BANK_TRANSFER', 'MANUAL']) {
    const { service, provider } = build({
      orders: [orderDoc({ paymentMethod })],
      payments: [paymentDoc('SUBMITTED')],
    });

    const outcome = await service.dispatchForOrder({ orderId: ORDER_ID, performedBy: STAFF_ID });

    assert.equal(outcome.shipment.status, COURIER_STATUSES.ACTIVE);
    assert.equal(
      provider._harness._registry.get(outcome.shipment.consignmentId).amountToCollectMinorUnits,
      100000,
      `${paymentMethod}: a SUBMITTED payment is not paid yet`
    );
    assert.equal(provider._harness._registry.size, 1);
  }
});

test('rejected manual-method orders dispatch with the full order total to collect', async () => {
  for (const paymentMethod of ['BKASH', 'BANK_TRANSFER', 'MANUAL']) {
    const { service, provider } = build({
      orders: [orderDoc({ paymentMethod })],
      payments: [paymentDoc('REJECTED')],
    });

    const outcome = await service.dispatchForOrder({ orderId: ORDER_ID, performedBy: STAFF_ID });

    assert.equal(outcome.shipment.status, COURIER_STATUSES.ACTIVE);
    assert.equal(
      provider._harness._registry.get(outcome.shipment.consignmentId).amountToCollectMinorUnits,
      100000,
      `${paymentMethod}: a REJECTED payment is not paid`
    );
    assert.equal(provider._harness._registry.size, 1);
  }
});

test('VERIFIED manual-method orders dispatch with zero cash to collect', async () => {
  for (const paymentMethod of ['BKASH', 'BANK_TRANSFER', 'MANUAL']) {
    const { service, provider } = build({
      orders: [orderDoc({ paymentMethod })],
      payments: [paymentDoc('VERIFIED')],
    });

    const outcome = await service.dispatchForOrder({ orderId: ORDER_ID, performedBy: STAFF_ID });

    assert.equal(outcome.shipment.status, COURIER_STATUSES.ACTIVE);
    assert.equal(outcome.shipment.amountToCollectMinorUnits, 0);
    assert.equal(
      provider._harness._registry.get(outcome.shipment.consignmentId).amountToCollectMinorUnits,
      0,
      `${paymentMethod}: VERIFIED payment is already paid`
    );
    assert.equal(provider._harness._registry.size, 1);
  }
});

test('CARD orders dispatch with zero cash to collect (gateway-reserved, no manual capture)', async () => {
  const { service, provider } = build({ orders: [orderDoc({ paymentMethod: 'CARD' })] });

  const outcome = await service.dispatchForOrder({ orderId: ORDER_ID, performedBy: STAFF_ID });

  assert.equal(outcome.shipment.status, COURIER_STATUSES.ACTIVE);
  assert.equal(outcome.shipment.amountToCollectMinorUnits, 0);
  assert.equal(provider._harness._registry.size, 1);
});

test('a rejected provider submission marks the shipment FAILED and translates the error', async () => {
  const provider = createMockCourierProvider();
  provider._harness.failNextSubmitWith(
    new CourierProviderError(
      COURIER_PROVIDER_ERROR_CODES.PROVIDER_REJECTED,
      'recipient_phone is invalid'
    )
  );
  const { service, shipmentRepo } = build({ orders: [orderDoc()], provider });

  await assert.rejects(
    service.dispatchForOrder({ orderId: ORDER_ID, performedBy: STAFF_ID }),
    (err) => err.code === ERROR_CODES.COURIER_PROVIDER_REJECTED && err.statusCode === 400
  );

  const stored = shipmentRepo.docs[0];
  assert.equal(stored.status, COURIER_STATUSES.FAILED);
  assert.equal(stored.submission.attempts, 1);
  assert.equal(stored.submission.lastError.code, COURIER_PROVIDER_ERROR_CODES.PROVIDER_REJECTED);
  assert.match(stored.submission.lastError.message, /recipient_phone/);
});

test('retryDispatch recovers a FAILED shipment to ACTIVE', async () => {
  const provider = createMockCourierProvider();
  provider._harness.failNextSubmitWith(
    new CourierProviderError(COURIER_PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE, 'timeout')
  );
  const { service, shipmentRepo } = build({ orders: [orderDoc()], provider });

  await assert.rejects(
    service.dispatchForOrder({ orderId: ORDER_ID, performedBy: STAFF_ID }),
    (err) => err.code === ERROR_CODES.COURIER_PROVIDER_UNAVAILABLE
  );
  assert.equal(shipmentRepo.docs[0].status, COURIER_STATUSES.FAILED);

  const outcome = await service.retryDispatch({
    shipmentId: String(shipmentRepo.docs[0]._id),
    performedBy: STAFF_ID,
  });
  assert.equal(outcome.shipment.status, COURIER_STATUSES.ACTIVE);
  assert.ok(outcome.shipment.consignmentId);
  assert.equal(outcome.shipment.submission.attempts, 2);
});

test('retryDispatch rejects shipments that are not FAILED', async () => {
  const { service, shipmentRepo } = build({ orders: [orderDoc()] });
  const created = await shipmentRepo.create({
    orderId: ORDER_ID,
    merchantReference: 'TAQ-20260808-000001',
    provider: 'mock',
    status: COURIER_STATUSES.PENDING,
    statusHistory: [],
  });

  await assert.rejects(
    service.retryDispatch({ shipmentId: String(created._id), performedBy: STAFF_ID }),
    (err) => err.code === ERROR_CODES.COURIER_INVALID_STATE
  );
});

test('cancelShipment on PENDING cancels locally without contacting the provider', async () => {
  const provider = createMockCourierProvider();
  const { service, shipmentRepo } = build({ orders: [orderDoc()], provider });
  const created = await shipmentRepo.create({
    orderId: ORDER_ID,
    merchantReference: 'TAQ-20260808-000001',
    provider: 'mock',
    status: COURIER_STATUSES.PENDING,
    statusHistory: [],
  });

  const outcome = await service.cancelShipment({
    shipmentId: String(created._id),
    performedBy: STAFF_ID,
  });
  assert.equal(outcome.shipment.status, COURIER_STATUSES.CANCELLED);
  assert.equal(provider._harness._registry.size, 0, 'provider must never be contacted');
  assert.ok(outcome.shipment.cancel.confirmedAt);
});

test('cancelShipment on ACTIVE cancels via the provider', async () => {
  const provider = createMockCourierProvider();
  const { service } = build({ orders: [orderDoc()], provider });
  const outcome = await service.dispatchForOrder({ orderId: ORDER_ID, performedBy: STAFF_ID });

  const cancelled = await service.cancelShipment({
    shipmentId: outcome.shipment.id,
    performedBy: STAFF_ID,
  });
  assert.equal(cancelled.shipment.status, COURIER_STATUSES.CANCELLED);
  assert.ok(cancelled.shipment.cancel.confirmedAt);
  const record = provider._harness._registry.get(outcome.shipment.consignmentId);
  assert.equal(record.status, 'Cancelled');
});

test('a refused provider cancellation leaves the shipment CANCELLATION_FAILED', async () => {
  const provider = createMockCourierProvider();
  const { service } = build({ orders: [orderDoc()], provider });
  const outcome = await service.dispatchForOrder({ orderId: ORDER_ID, performedBy: STAFF_ID });
  provider._harness.failNextCancelWith(
    new CourierProviderError(COURIER_PROVIDER_ERROR_CODES.CANCEL_REJECTED, 'too late to cancel')
  );

  await assert.rejects(
    service.cancelShipment({ shipmentId: outcome.shipment.id, performedBy: STAFF_ID }),
    (err) => err.code === ERROR_CODES.COURIER_CANCEL_REJECTED && err.statusCode === 409
  );

  const stored = outcome.shipment;
  const fresh = await service.getShipment({ shipmentId: stored.id });
  assert.equal(fresh.shipment.status, COURIER_STATUSES.CANCELLATION_FAILED);
  assert.equal(fresh.shipment.cancel.lastError.code, COURIER_PROVIDER_ERROR_CODES.CANCEL_REJECTED);
});

test('cancelShipment on DELIVERED is rejected', async () => {
  const provider = createMockCourierProvider();
  const { service } = build({ orders: [orderDoc()], provider });
  const outcome = await service.dispatchForOrder({ orderId: ORDER_ID, performedBy: STAFF_ID });
  const shipment = outcome.shipment;
  await service.applyProviderStatusUpdate({
    shipment: { _id: shipment.id, status: COURIER_STATUSES.ACTIVE },
    localStatus: COURIER_STATUSES.DELIVERED,
    providerStatus: 'Delivered',
    note: 'test',
  });

  await assert.rejects(
    service.cancelShipment({ shipmentId: shipment.id, performedBy: STAFF_ID }),
    (err) => err.code === ERROR_CODES.COURIER_INVALID_STATE
  );
});

test('webhook delivery event moves an ACTIVE shipment to DELIVERED', async () => {
  const provider = createMockCourierProvider();
  const { service } = build({ orders: [orderDoc()], provider });
  const outcome = await service.dispatchForOrder({ orderId: ORDER_ID, performedBy: STAFF_ID });

  const updated = await service.handleProviderStatusUpdate({
    consignmentId: outcome.shipment.consignmentId,
    providerStatus: 'Delivered',
  });

  assert.equal(updated.status, COURIER_STATUSES.DELIVERED);
  assert.equal(updated.providerStatus.status, 'Delivered');
  const lastEntry = updated.statusHistory[updated.statusHistory.length - 1];
  assert.equal(lastEntry.status, COURIER_STATUSES.DELIVERED);
  assert.match(lastEntry.note, /Webhook/);
});

test('webhook cancellation event moves an ACTIVE shipment to CANCELLED', async () => {
  const provider = createMockCourierProvider();
  const { service } = build({ orders: [orderDoc()], provider });
  const outcome = await service.dispatchForOrder({ orderId: ORDER_ID, performedBy: STAFF_ID });

  const updated = await service.handleProviderStatusUpdate({
    consignmentId: outcome.shipment.consignmentId,
    providerStatus: 'Cancelled',
  });

  assert.equal(updated.status, COURIER_STATUSES.CANCELLED);
  assert.ok(updated.cancel.confirmedAt);
});

test('webhook matching falls back to merchantReference (order number)', async () => {
  const provider = createMockCourierProvider();
  const { service } = build({ orders: [orderDoc()], provider });
  const outcome = await service.dispatchForOrder({ orderId: ORDER_ID, performedBy: STAFF_ID });
  assert.equal(outcome.shipment.orderNumber, 'TAQ-20260808-000001');

  const updated = await service.handleProviderStatusUpdate({
    merchantReference: 'TAQ-20260808-000001',
    providerStatus: 'Delivered',
  });
  assert.equal(updated.status, COURIER_STATUSES.DELIVERED);
});

test('an unknown webhook returns null (acknowledged, ignored)', async () => {
  const { service } = build({ orders: [orderDoc()] });
  const result = await service.handleProviderStatusUpdate({
    consignmentId: 'MOCK-999999',
    providerStatus: 'Delivered',
  });
  assert.equal(result, null);
});

test('reconcileActiveShipments polls stale ACTIVE shipments and applies terminal statuses', async () => {
  const provider = createMockCourierProvider();
  const { service, shipmentRepo } = build({ orders: [orderDoc()], provider });
  const outcome = await service.dispatchForOrder({ orderId: ORDER_ID, performedBy: STAFF_ID });

  provider._harness.advance(outcome.shipment.consignmentId, 'Delivered', new Date());
  shipmentRepo.docs[0].providerStatus.fetchedAt = new Date(Date.now() - 120000);

  const result = await service.reconcileActiveShipments({ staleAfterMs: 0 });
  assert.deepEqual(result, { scanned: 1, updated: 1, failed: 0 });

  const fresh = await service.getShipment({ shipmentId: outcome.shipment.id });
  assert.equal(fresh.shipment.status, COURIER_STATUSES.DELIVERED);
});

test('getCustomerTracking returns tracking for the owner', async () => {
  const provider = createMockCourierProvider();
  const { service } = build({ orders: [orderDoc()], provider });
  const outcome = await service.dispatchForOrder({ orderId: ORDER_ID, performedBy: STAFF_ID });

  const result = await service.getCustomerTracking({ customerId: CUSTOMER_ID, orderId: ORDER_ID });
  assert.equal(result.tracking.id, outcome.shipment.id);
  assert.equal(result.tracking.status, COURIER_STATUSES.ACTIVE);
  assert.equal(result.tracking.consignmentId, outcome.shipment.consignmentId);
});

test('getCustomerTracking for another customer resolves as ORDER_NOT_FOUND (no leak)', async () => {
  const { service } = build({ orders: [orderDoc()] });
  await assert.rejects(
    service.getCustomerTracking({ customerId: OTHER_CUSTOMER_ID, orderId: ORDER_ID }),
    (err) => err.code === ERROR_CODES.ORDER_NOT_FOUND && err.statusCode === 404
  );
});

test('getCustomerTracking with no shipment returns tracking null', async () => {
  const { service } = build({ orders: [orderDoc()] });
  const result = await service.getCustomerTracking({ customerId: CUSTOMER_ID, orderId: ORDER_ID });
  assert.deepEqual(result, { tracking: null });
});

test('listShipments rejects unknown statuses and paginates otherwise', async () => {
  const provider = createMockCourierProvider();
  const { service } = build({ orders: [orderDoc()], provider });
  await service.dispatchForOrder({ orderId: ORDER_ID, performedBy: STAFF_ID });

  await assert.rejects(
    service.listShipments({ status: 'BOGUS' }),
    (err) => err.code === ERROR_CODES.INVALID_COURIER_REQUEST
  );

  const result = await service.listShipments({ status: COURIER_STATUSES.ACTIVE, page: 1, limit: 10 });
  assert.equal(result.shipments.length, 1);
  assert.equal(result.pagination.total, 1);
});

test('getShipment on a missing shipment is 404', async () => {
  const { service } = build({ orders: [orderDoc()] });
  await assert.rejects(
    service.getShipment({ shipmentId: '507f1f77bcf86cd7994390ff' }),
    (err) => err.code === ERROR_CODES.COURIER_SHIPMENT_NOT_FOUND && err.statusCode === 404
  );
});

test('cancelForOrder with no shipment returns null', async () => {
  const { service } = build({ orders: [orderDoc()] });
  const result = await service.cancelForOrder({ orderId: ORDER_ID, performedBy: STAFF_ID });
  assert.equal(result, null);
});

test('cancelForOrder cancels an ACTIVE shipment (order-cancel hook)', async () => {
  const provider = createMockCourierProvider();
  const { service } = build({ orders: [orderDoc()], provider });
  await service.dispatchForOrder({ orderId: ORDER_ID, performedBy: STAFF_ID });

  const result = await service.cancelForOrder({ orderId: ORDER_ID, performedBy: STAFF_ID });
  assert.equal(result.shipment.status, COURIER_STATUSES.CANCELLED);
});

test('webhook signature validation fails closed', async () => {
  const { service } = build({ orders: [orderDoc()] });
  assert.equal(service.isValidWebhookSignature('webhook-secret'), true);
  assert.equal(service.isValidWebhookSignature('wrong-secret'), false);
  assert.equal(service.isValidWebhookSignature(null), false);
});

test('onOrderDispatched handler fires after a successful dispatch', async () => {
  const provider = createMockCourierProvider();
  const { service } = build({ orders: [orderDoc()], provider });
  const dispatched = [];
  service.onOrderDispatched(({ orderId, note }) => dispatched.push({ orderId, note }));

  await service.dispatchForOrder({ orderId: ORDER_ID, performedBy: STAFF_ID });

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].orderId, ORDER_ID);
  assert.match(dispatched[0].note, /[Dd]ispatch/);
});

test('onOrderDispatched handler does not fire on a failed dispatch', async () => {
  const provider = createMockCourierProvider();
  provider._harness.failNextSubmitWith(
    new CourierProviderError(COURIER_PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE, 'timeout')
  );
  const { service } = build({ orders: [orderDoc()], provider });
  let calls = 0;
  service.onOrderDispatched(() => {
    calls += 1;
  });

  await assert.rejects(
    service.dispatchForOrder({ orderId: ORDER_ID, performedBy: STAFF_ID }),
    (err) => err.code === ERROR_CODES.COURIER_PROVIDER_UNAVAILABLE
  );
  assert.equal(calls, 0);
});

test('shipment DELIVERED/CANCELLED events never invoke the order hook (order status is decoupled)', async () => {
  const provider = createMockCourierProvider();
  const { service } = build({ orders: [orderDoc()], provider });
  const calls = [];
  service.onOrderDispatched(({ orderId }) => calls.push(orderId));

  const outcome = await service.dispatchForOrder({ orderId: ORDER_ID, performedBy: STAFF_ID });
  assert.deepEqual(calls, [ORDER_ID], 'dispatch fires exactly once');

  await service.handleProviderStatusUpdate({
    consignmentId: outcome.shipment.consignmentId,
    providerStatus: 'Delivered',
  });
  await service.handleProviderStatusUpdate({
    consignmentId: outcome.shipment.consignmentId,
    providerStatus: 'Cancelled',
  });
  assert.deepEqual(calls, [ORDER_ID], 'webhook DELIVERED/CANCELLED do not fire the order hook');
});
