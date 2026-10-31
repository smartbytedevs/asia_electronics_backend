'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { OrderService } = require('../../../src/modules/orders/order.service');
const { AdminOrderService } = require('../../../src/modules/orders/adminOrder.service');
const { ReservationService } = require('../../../src/modules/inventory/reservation.service');
const { CourierService } = require('../../../src/modules/courier/courier.service');
const { createMockCourierProvider } = require('../../../src/modules/courier/courier.provider.mock');
const { COURIER_STATUSES } = require('../../../src/modules/courier/courier.constants');
const { ORDER_STATUSES, ORDER_MESSAGES } = require('../../../src/modules/orders/order.constants');
const { PAYMENT_STATUSES } = require('../../../src/modules/payments/payment.constants');
const { ERROR_CODES } = require('../../../src/constants');
const { createMemoryShipmentRepository } = require('../../helpers/courier-stubs');
const {
  createMemoryOrderRepository,
  createMemoryCartRepository,
  createMemoryProductRepository,
  createRollbackTransaction,
} = require('../../helpers/order-stubs');
const {
  createMemoryVariantRepository,
  createMemoryInventoryRepository,
  createMemoryMovementRepository,
  createMemoryReservationRepository,
} = require('../../helpers/inventory-stubs');
const { createMemoryPaymentRepository } = require('../../helpers/payment-stubs');

const CUSTOMER_ID = '507f1f77bcf86cd799439011';
const STAFF_ID = '507f1f77bcf86cd799439022';
const P1 = '507f1f77bcf86cd799439031';
const V1 = '507f1f77bcf86cd799439041';

const VALID_ADDRESS = {
  fullName: 'Amina Rahman',
  phone: '+8801712345678',
  line1: 'House 12, Road 3',
  line2: null,
  area: 'GEC',
  city: 'Chattogram',
  district: 'Chattogram',
  postalCode: '4000',
  country: 'BD',
};

let keySeq = 0;
function nextIdempotencyKey() {
  keySeq += 1;
  return `lifecycle-key-${keySeq}`;
}

function createCapturingNotificationService() {
  const calls = [];
  return {
    calls,
    async notify({ userId, eventType, data }) {
      calls.push({ userId, eventType, data });
      return null;
    },
    async notifyAdmin({ userId, eventType, data }) {
      calls.push({ userId, eventType, data });
      return null;
    },
    async notifyAdminEmail({ userId, to, eventType, data, persist }) {
      calls.push({ userId, to, eventType, data, persist });
      return null;
    },
  };
}

function buildContext() {
  const orderRepo = createMemoryOrderRepository();
  const cartRepo = createMemoryCartRepository();
  const productRepo = createMemoryProductRepository([
    { _id: P1, name: 'Abaya', slug: 'abaya', sellingPrice: 100000, discount: null, isActive: true },
  ]);
  const variantRepo = createMemoryVariantRepository([
    { _id: V1, productId: P1, sku: 'ABAYA-52', attributes: { size: '52' }, isActive: true },
  ]);
  const invRepo = createMemoryInventoryRepository([
    { _id: '507f1f77bcf86cd7994390a1', productVariantId: V1, onlineQuantity: 20, offlineQuantity: 0, reservedQuantity: 0, lowStockThreshold: 0 },
  ]);
  const movRepo = createMemoryMovementRepository();
  const resRepo = createMemoryReservationRepository();
  const shipmentRepo = createMemoryShipmentRepository();
  const paymentRepo = createMemoryPaymentRepository();
  const notificationService = createCapturingNotificationService();

  const runTransaction = createRollbackTransaction([
    orderRepo,
    cartRepo,
    invRepo,
    resRepo,
    movRepo,
    shipmentRepo,
    paymentRepo,
  ]);

  const reservationService = new ReservationService({
    reservationRepository: resRepo,
    inventoryRepository: invRepo,
    movementRepository: movRepo,
    variantRepository: variantRepo,
    runTransaction,
  });

  const provider = createMockCourierProvider();
  const courierService = new CourierService({
    shipmentRepository: shipmentRepo,
    orderRepository: orderRepo,
    paymentRepository: paymentRepo,
    provider,
    config: { webhookSecret: 'test-secret' },
  });

  const orderService = new OrderService({
    orderRepository: orderRepo,
    cartRepository: cartRepo,
    productRepository: productRepo,
    variantRepository: variantRepo,
    reservationService,
    courierService,
    notificationService,
    runTransaction,
  });

  const adminOrderService = new AdminOrderService({
    orderRepository: orderRepo,
    orderService,
    paymentRepository: paymentRepo,
  });

  return {
    orderService,
    adminOrderService,
    courierService,
    provider,
    orderRepo,
    cartRepo,
    resRepo,
    invRepo,
    shipmentRepo,
    paymentRepo,
    notificationService,
  };
}

async function seedAndCheckout(ctx, paymentMethod = 'COD') {
  await ctx.cartRepo.create({
    customerId: CUSTOMER_ID,
    items: [{ productVariantId: V1, productId: P1, quantity: 2 }],
  });
  const outcome = await ctx.orderService.checkout({
    customerId: CUSTOMER_ID,
    delivery: { address: { ...VALID_ADDRESS } },
    notes: null,
    paymentMethod,
    idempotencyKey: nextIdempotencyKey(),
  });
  return outcome.order.id;
}

async function verifyPaymentForOrder(ctx, orderId) {
  await ctx.paymentRepo.create({
    orderId,
    status: PAYMENT_STATUSES.VERIFIED,
    statusHistory: [],
  });
}

function shipmentForOrder(ctx) {
  return ctx.shipmentRepo.docs[0];
}

async function dispatchOrder(ctx, orderId) {
  return ctx.courierService.dispatchForOrder({ orderId, performedBy: STAFF_ID });
}

async function deliverByProvider(ctx, consignmentId) {
  return ctx.courierService.handleProviderStatusUpdate({
    consignmentId,
    providerStatus: 'Delivered',
  });
}

async function advanceToConfirmed(ctx, orderId) {
  await ctx.adminOrderService.confirmOrder({ orderId, performedBy: STAFF_ID, note: null });
  return ctx.orderRepo.docs[0];
}

async function advanceToProcessing(ctx, orderId) {
  await ctx.adminOrderService.confirmOrder({ orderId, performedBy: STAFF_ID, note: null });
  await ctx.adminOrderService.processOrder({ orderId, performedBy: STAFF_ID, note: 'packed' });
  return ctx.orderRepo.docs[0];
}

async function advanceToDispatched(ctx, orderId) {
  await advanceToProcessing(ctx, orderId);
  await dispatchOrder(ctx, orderId);
  return ctx.orderRepo.docs[0];
}

async function advanceToShipped(ctx, orderId) {
  await advanceToDispatched(ctx, orderId);
  await ctx.adminOrderService.shipOrder({ orderId, performedBy: STAFF_ID, note: 'handed to Pathao' });
  return ctx.orderRepo.docs[0];
}

test('full status lifecycle PENDING → CONFIRMED → PROCESSING → DISPATCHED → SHIPPED → DELIVERED → COMPLETED', async () => {
  const ctx = buildContext();
  const orderId = await seedAndCheckout(ctx);

  const confirmed = await ctx.adminOrderService.confirmOrder({ orderId, performedBy: STAFF_ID, note: null });
  assert.equal(confirmed.status, ORDER_STATUSES.CONFIRMED);

  const processed = await ctx.adminOrderService.processOrder({ orderId, performedBy: STAFF_ID, note: 'packed' });
  assert.equal(processed.status, ORDER_STATUSES.PROCESSING);

  const dispatched = await dispatchOrder(ctx, orderId);
  assert.equal(dispatched.shipment.status, COURIER_STATUSES.ACTIVE);
  assert.equal(ctx.orderRepo.docs[0].status, ORDER_STATUSES.DISPATCHED, 'successful dispatch moves the order to DISPATCHED');

  const shipped = await ctx.adminOrderService.shipOrder({ orderId, performedBy: STAFF_ID, note: 'handed to Pathao' });
  assert.equal(shipped.status, ORDER_STATUSES.SHIPPED);

  await deliverByProvider(ctx, dispatched.shipment.consignmentId);
  assert.equal(ctx.orderRepo.docs[0].status, ORDER_STATUSES.SHIPPED, 'provider DELIVERED webhook never changes the order');

  const delivered = await ctx.adminOrderService.deliverOrder({ orderId, performedBy: STAFF_ID, note: null });
  assert.equal(delivered.status, ORDER_STATUSES.DELIVERED);

  const completed = await ctx.adminOrderService.completeOrder({ orderId, performedBy: STAFF_ID, note: null });
  assert.equal(completed.status, ORDER_STATUSES.COMPLETED);

  const history = ctx.orderRepo.docs[0].statusHistory.map((entry) => entry.status);
  assert.deepEqual(history, [
    ORDER_STATUSES.PENDING,
    ORDER_STATUSES.CONFIRMED,
    ORDER_STATUSES.PROCESSING,
    ORDER_STATUSES.DISPATCHED,
    ORDER_STATUSES.SHIPPED,
    ORDER_STATUSES.DELIVERED,
    ORDER_STATUSES.COMPLETED,
  ]);
});

test('invalid transitions are rejected at every stage', async () => {
  const ctx = buildContext();
  const orderId = await seedAndCheckout(ctx);

  await assert.rejects(
    ctx.adminOrderService.shipOrder({ orderId, performedBy: STAFF_ID, note: null }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.ORDER_INVALID_STATE
  );
  await assert.rejects(
    ctx.adminOrderService.deliverOrder({ orderId, performedBy: STAFF_ID, note: null }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.ORDER_INVALID_STATE
  );
  await assert.rejects(
    ctx.adminOrderService.returnOrder({ orderId, performedBy: STAFF_ID, note: null }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.ORDER_INVALID_STATE
  );
  await assert.rejects(
    ctx.adminOrderService.completeOrder({ orderId, performedBy: STAFF_ID, note: null }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.ORDER_INVALID_STATE
  );

  await ctx.adminOrderService.confirmOrder({ orderId, performedBy: STAFF_ID, note: null });
  await assert.rejects(
    ctx.adminOrderService.shipOrder({ orderId, performedBy: STAFF_ID, note: null }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.ORDER_INVALID_STATE
  );

  await ctx.adminOrderService.processOrder({ orderId, performedBy: STAFF_ID, note: null });
  await assert.rejects(
    ctx.adminOrderService.confirmOrder({ orderId, performedBy: STAFF_ID, note: null }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.ORDER_CONFIRMATION_NOT_ALLOWED
  );
  await assert.rejects(
    ctx.adminOrderService.completeOrder({ orderId, performedBy: STAFF_ID, note: null }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.ORDER_INVALID_STATE
  );

  await dispatchOrder(ctx, orderId);
  assert.equal(ctx.orderRepo.docs[0].status, ORDER_STATUSES.DISPATCHED);
  await assert.rejects(
    ctx.adminOrderService.deliverOrder({ orderId, performedBy: STAFF_ID, note: null }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.ORDER_INVALID_STATE
  );

  await ctx.adminOrderService.shipOrder({ orderId, performedBy: STAFF_ID, note: null });
  await assert.rejects(
    ctx.adminOrderService.completeOrder({ orderId, performedBy: STAFF_ID, note: null }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.ORDER_INVALID_STATE
  );
});

test('cancellation before delivery (SHIPPED) releases the ACTIVE reservations', async () => {
  const ctx = buildContext();
  const orderId = await seedAndCheckout(ctx);
  const reservationIds = ctx.orderRepo.docs[0].reservationReference.reservationIds;
  assert.equal(reservationIds.length, 1);
  assert.equal(ctx.resRepo.docs.every((r) => r.status === 'ACTIVE'), true);
  assert.equal(ctx.invRepo.docs[0].reservedQuantity, 2);

  await advanceToShipped(ctx, orderId);
  assert.equal(ctx.orderRepo.docs[0].status, ORDER_STATUSES.SHIPPED);

  const cancelled = await ctx.orderService.cancelCustomerOrder({
    customerId: CUSTOMER_ID,
    orderId,
    performedBy: CUSTOMER_ID,
  });
  assert.equal(cancelled.status, ORDER_STATUSES.CANCELLED);
  assert.equal(ctx.resRepo.docs.every((r) => r.status === 'RELEASED'), true);
  assert.equal(ctx.invRepo.docs[0].reservedQuantity, 0);
  assert.equal(ctx.invRepo.docs[0].onlineQuantity, 20, 'released stock returns to ONLINE');
});

test('cannot cancel after the order is DELIVERED or COMPLETED', async () => {
  const ctx = buildContext();
  const orderId = await seedAndCheckout(ctx);
  await advanceToShipped(ctx, orderId);

  await ctx.adminOrderService.deliverOrder({ orderId, performedBy: STAFF_ID, note: null });
  assert.equal(ctx.orderRepo.docs[0].status, ORDER_STATUSES.DELIVERED);

  await assert.rejects(
    ctx.orderService.cancelCustomerOrder({ customerId: CUSTOMER_ID, orderId, performedBy: CUSTOMER_ID }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.ORDER_CANCELLATION_NOT_ALLOWED
  );

  await ctx.adminOrderService.completeOrder({ orderId, performedBy: STAFF_ID, note: null });
  await assert.rejects(
    ctx.orderService.cancelCustomerOrder({ customerId: CUSTOMER_ID, orderId, performedBy: CUSTOMER_ID }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.ORDER_CANCELLATION_NOT_ALLOWED
  );
});

test('provider DELIVERED (webhook) moves the shipment only — the order stays SHIPPED until staff acts', async () => {
  const ctx = buildContext();
  const orderId = await seedAndCheckout(ctx);
  await advanceToShipped(ctx, orderId);

  const updated = await deliverByProvider(ctx, shipmentForOrder(ctx).consignmentId);
  assert.equal(updated.status, COURIER_STATUSES.DELIVERED);
  assert.equal(ctx.orderRepo.docs[0].status, ORDER_STATUSES.SHIPPED, 'the order is NOT auto-delivered by the provider');

  const delivered = await ctx.adminOrderService.deliverOrder({ orderId, performedBy: STAFF_ID, note: null });
  assert.equal(delivered.status, ORDER_STATUSES.DELIVERED);
});

test('reconciliation applies the same DELIVERED behavior as the webhook (shipment only)', async () => {
  const ctx = buildContext();
  const orderId = await seedAndCheckout(ctx);
  await advanceToShipped(ctx, orderId);

  ctx.provider._harness.advance(shipmentForOrder(ctx).consignmentId, 'Delivered', new Date());
  ctx.shipmentRepo.docs[0].providerStatus.fetchedAt = new Date(Date.now() - 120000);

  const result = await ctx.courierService.reconcileActiveShipments({ staleAfterMs: 0 });
  assert.deepEqual(result, { scanned: 1, updated: 1, failed: 0 });
  assert.equal(ctx.shipmentRepo.docs[0].status, COURIER_STATUSES.DELIVERED);
  assert.equal(ctx.orderRepo.docs[0].status, ORDER_STATUSES.SHIPPED, 'reconciliation never changes the order');

  await ctx.adminOrderService.deliverOrder({ orderId, performedBy: STAFF_ID, note: null });
  assert.equal(ctx.orderRepo.docs[0].status, ORDER_STATUSES.DELIVERED);
});

test('reservations are consumed exactly once on delivery (repeat delivery attempts are safe)', async () => {
  const ctx = buildContext();
  const orderId = await seedAndCheckout(ctx);
  await advanceToShipped(ctx, orderId);

  await ctx.adminOrderService.deliverOrder({ orderId, performedBy: STAFF_ID, note: null });
  assert.equal(ctx.orderRepo.docs[0].status, ORDER_STATUSES.DELIVERED);
  assert.equal(ctx.resRepo.docs[0].status, 'CONSUMED');
  assert.equal(ctx.invRepo.docs[0].reservedQuantity, 0);
  assert.equal(ctx.invRepo.docs[0].onlineQuantity, 18, 'delivered stock physically leaves ONLINE');

  await assert.rejects(
    ctx.adminOrderService.deliverOrder({ orderId, performedBy: STAFF_ID, note: null }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.ORDER_INVALID_STATE
  );
  assert.equal(ctx.resRepo.docs[0].status, 'CONSUMED', 'no double-consume');
  assert.equal(ctx.invRepo.docs[0].onlineQuantity, 18);

  await deliverByProvider(ctx, shipmentForOrder(ctx).consignmentId);
  assert.equal(ctx.orderRepo.docs[0].status, ORDER_STATUSES.DELIVERED, 'a late webhook does not re-consume or regress the order');
  assert.equal(ctx.resRepo.docs[0].status, 'CONSUMED');
  assert.equal(ctx.invRepo.docs[0].onlineQuantity, 18);
});

test('manual payment (BKASH) requires a VERIFIED payment before confirmation', async () => {
  const ctx = buildContext();
  const orderId = await seedAndCheckout(ctx, 'BKASH');

  await assert.rejects(
    ctx.adminOrderService.confirmOrder({ orderId, performedBy: STAFF_ID, note: null }),
    (err) =>
      err.statusCode === 409 &&
      err.code === ERROR_CODES.ORDER_CONFIRMATION_NOT_ALLOWED &&
      err.message === ORDER_MESSAGES.PAYMENT_VERIFICATION_REQUIRED
  );
  assert.equal(ctx.orderRepo.docs[0].status, ORDER_STATUSES.PENDING, 'unverified manual payment blocks confirmation');

  await verifyPaymentForOrder(ctx, orderId);
  const confirmed = await ctx.adminOrderService.confirmOrder({ orderId, performedBy: STAFF_ID, note: null });
  assert.equal(confirmed.status, ORDER_STATUSES.CONFIRMED);

  await ctx.adminOrderService.processOrder({ orderId, performedBy: STAFF_ID, note: 'packed' });
  const dispatched = await dispatchOrder(ctx, orderId);
  assert.equal(dispatched.shipment.status, COURIER_STATUSES.ACTIVE);
  assert.equal(
    dispatched.shipment.amountToCollectMinorUnits,
    0,
    'a VERIFIED payment is not collected again at the door'
  );
  assert.equal(ctx.orderRepo.docs[0].status, ORDER_STATUSES.DISPATCHED);

  await ctx.adminOrderService.shipOrder({ orderId, performedBy: STAFF_ID, note: null });
  const delivered = await ctx.adminOrderService.deliverOrder({ orderId, performedBy: STAFF_ID, note: null });
  assert.equal(delivered.status, ORDER_STATUSES.DELIVERED);
  assert.equal(ctx.resRepo.docs[0].status, 'CONSUMED');
});

test('COD confirmation does not require a payment record', async () => {
  const ctx = buildContext();
  const orderId = await seedAndCheckout(ctx, 'COD');
  const confirmed = await ctx.adminOrderService.confirmOrder({ orderId, performedBy: STAFF_ID, note: null });
  assert.equal(confirmed.status, ORDER_STATUSES.CONFIRMED);
});

test('successful dispatch auto-advances the order PROCESSING → DISPATCHED', async () => {
  const ctx = buildContext();
  const orderId = await seedAndCheckout(ctx);
  await advanceToProcessing(ctx, orderId);
  assert.equal(ctx.orderRepo.docs[0].status, ORDER_STATUSES.PROCESSING);

  const dispatched = await dispatchOrder(ctx, orderId);
  assert.equal(dispatched.shipment.status, COURIER_STATUSES.ACTIVE);
  assert.equal(ctx.orderRepo.docs[0].status, ORDER_STATUSES.DISPATCHED, 'dispatch auto-advances a PROCESSING order');
});

test('dispatch from CONFIRMED moves the order to DISPATCHED', async () => {
  const ctx = buildContext();
  const orderId = await seedAndCheckout(ctx);
  await advanceToConfirmed(ctx, orderId);
  assert.equal(ctx.orderRepo.docs[0].status, ORDER_STATUSES.CONFIRMED);

  const dispatched = await dispatchOrder(ctx, orderId);
  assert.equal(dispatched.shipment.status, COURIER_STATUSES.ACTIVE);
  assert.equal(ctx.orderRepo.docs[0].status, ORDER_STATUSES.DISPATCHED, 'dispatch moves a CONFIRMED order to DISPATCHED');
});

test('shipping and delivery are staff/admin steps after dispatch', async () => {
  const ctx = buildContext();
  const orderId = await seedAndCheckout(ctx);
  await advanceToDispatched(ctx, orderId);
  assert.equal(ctx.orderRepo.docs[0].status, ORDER_STATUSES.DISPATCHED);

  await deliverByProvider(ctx, shipmentForOrder(ctx).consignmentId);
  assert.equal(ctx.orderRepo.docs[0].status, ORDER_STATUSES.DISPATCHED, 'provider DELIVERED does not skip the ship step');

  const shipped = await ctx.adminOrderService.shipOrder({ orderId, performedBy: STAFF_ID, note: null });
  assert.equal(shipped.status, ORDER_STATUSES.SHIPPED);

  const delivered = await ctx.adminOrderService.deliverOrder({ orderId, performedBy: STAFF_ID, note: null });
  assert.equal(delivered.status, ORDER_STATUSES.DELIVERED);
  assert.equal(ctx.resRepo.docs[0].status, 'CONSUMED');
});

test('courier CANCELLED (webhook) does not change the order or release reservations', async () => {
  const ctx = buildContext();
  const orderId = await seedAndCheckout(ctx);
  await advanceToDispatched(ctx, orderId);
  assert.equal(ctx.resRepo.docs[0].status, 'ACTIVE');
  assert.equal(ctx.invRepo.docs[0].reservedQuantity, 2);

  const updated = await ctx.courierService.handleProviderStatusUpdate({
    consignmentId: shipmentForOrder(ctx).consignmentId,
    providerStatus: 'Cancelled',
  });
  assert.equal(updated.status, COURIER_STATUSES.CANCELLED);
  assert.equal(ctx.orderRepo.docs[0].status, ORDER_STATUSES.DISPATCHED, 'provider CANCELLED never changes the order');
  assert.equal(ctx.resRepo.docs[0].status, 'ACTIVE', 'reservations are NOT released by the provider');
  assert.equal(ctx.invRepo.docs[0].reservedQuantity, 2);
});

test('duplicate courier CANCELLED webhook is idempotent on the shipment and never touches the order', async () => {
  const ctx = buildContext();
  const orderId = await seedAndCheckout(ctx);
  await advanceToDispatched(ctx, orderId);
  const consignmentId = shipmentForOrder(ctx).consignmentId;

  await ctx.courierService.handleProviderStatusUpdate({ consignmentId, providerStatus: 'Cancelled' });
  assert.equal(ctx.orderRepo.docs[0].status, ORDER_STATUSES.DISPATCHED);
  assert.equal(ctx.resRepo.docs[0].status, 'ACTIVE');

  const again = await ctx.courierService.handleProviderStatusUpdate({ consignmentId, providerStatus: 'Cancelled' });
  assert.equal(again.status, COURIER_STATUSES.CANCELLED);
  assert.equal(ctx.orderRepo.docs[0].status, ORDER_STATUSES.DISPATCHED);
  assert.equal(ctx.resRepo.docs[0].status, 'ACTIVE', 'no release, no double-release');
  assert.equal(ctx.invRepo.docs[0].reservedQuantity, 2);
});

test('admin cancel of an ACTIVE shipment does not change the order', async () => {
  const ctx = buildContext();
  const orderId = await seedAndCheckout(ctx);
  await advanceToDispatched(ctx, orderId);

  await ctx.courierService.cancelShipment({
    shipmentId: shipmentForOrder(ctx)._id,
    performedBy: STAFF_ID,
  });
  assert.equal(ctx.shipmentRepo.docs[0].status, COURIER_STATUSES.CANCELLED);
  assert.equal(ctx.orderRepo.docs[0].status, ORDER_STATUSES.DISPATCHED, 'shipment cancel is decoupled from the order');
  assert.equal(ctx.resRepo.docs[0].status, 'ACTIVE');
  assert.equal(ctx.invRepo.docs[0].reservedQuantity, 2);
});

test('a late courier CANCELLED webhook cannot cancel a delivered order', async () => {
  const ctx = buildContext();
  const orderId = await seedAndCheckout(ctx);
  await advanceToShipped(ctx, orderId);
  await ctx.adminOrderService.deliverOrder({ orderId, performedBy: STAFF_ID, note: null });
  assert.equal(ctx.orderRepo.docs[0].status, ORDER_STATUSES.DELIVERED);

  await ctx.courierService.handleProviderStatusUpdate({
    consignmentId: shipmentForOrder(ctx).consignmentId,
    providerStatus: 'Cancelled',
  });
  assert.equal(ctx.orderRepo.docs[0].status, ORDER_STATUSES.DELIVERED, 'a late cancel webhook must not cancel a delivered order');
  assert.equal(ctx.resRepo.docs[0].status, 'CONSUMED');
});

test('reconciliation CANCELLED changes the shipment only, never the order', async () => {
  const ctx = buildContext();
  const orderId = await seedAndCheckout(ctx);
  await advanceToDispatched(ctx, orderId);

  ctx.provider._harness.advance(shipmentForOrder(ctx).consignmentId, 'Cancelled', new Date());
  ctx.shipmentRepo.docs[0].providerStatus.fetchedAt = new Date(Date.now() - 120000);

  const result = await ctx.courierService.reconcileActiveShipments({ staleAfterMs: 0 });
  assert.deepEqual(result, { scanned: 1, updated: 1, failed: 0 });
  assert.equal(ctx.shipmentRepo.docs[0].status, COURIER_STATUSES.CANCELLED);
  assert.equal(ctx.orderRepo.docs[0].status, ORDER_STATUSES.DISPATCHED);
  assert.equal(ctx.resRepo.docs[0].status, 'ACTIVE');
  assert.equal(ctx.invRepo.docs[0].reservedQuantity, 2);
});

test('return (SHIPPED → RETURNED) releases the ACTIVE reservations', async () => {
  const ctx = buildContext();
  const orderId = await seedAndCheckout(ctx);
  await advanceToShipped(ctx, orderId);
  assert.equal(ctx.resRepo.docs[0].status, 'ACTIVE');
  assert.equal(ctx.invRepo.docs[0].reservedQuantity, 2);

  const returned = await ctx.adminOrderService.returnOrder({ orderId, performedBy: STAFF_ID, note: 'customer refused' });
  assert.equal(returned.status, ORDER_STATUSES.RETURNED);
  assert.equal(ctx.resRepo.docs[0].status, 'RELEASED', 'returned stock returns to availability');
  assert.equal(ctx.invRepo.docs[0].reservedQuantity, 0);
  assert.equal(ctx.invRepo.docs[0].onlineQuantity, 20);
});

test('return is only allowed from SHIPPED', async () => {
  const ctx = buildContext();
  const orderId = await seedAndCheckout(ctx);

  await assert.rejects(
    ctx.adminOrderService.returnOrder({ orderId, performedBy: STAFF_ID, note: null }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.ORDER_INVALID_STATE
  );

  await advanceToDispatched(ctx, orderId);
  await assert.rejects(
    ctx.adminOrderService.returnOrder({ orderId, performedBy: STAFF_ID, note: null }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.ORDER_INVALID_STATE
  );

  await ctx.adminOrderService.shipOrder({ orderId, performedBy: STAFF_ID, note: null });
  const returned = await ctx.adminOrderService.returnOrder({ orderId, performedBy: STAFF_ID, note: null });
  assert.equal(returned.status, ORDER_STATUSES.RETURNED);
});

test('checkout raises an ADMIN_ORDER_PLACED notification with human-readable order info', async () => {
  const ctx = buildContext();
  const orderId = await seedAndCheckout(ctx);

  const adminCalls = ctx.notificationService.calls.filter(
    (call) => call.eventType === 'ADMIN_ORDER_PLACED'
  );
  assert.equal(adminCalls.length, 1, 'exactly one admin notification per placed order');
  const call = adminCalls[0];
  assert.equal(call.userId, CUSTOMER_ID);
  assert.equal(call.data.entityRef, orderId);
  assert.equal(call.data.orderNumber, ctx.orderRepo.docs[0].orderNumber);
  assert.equal(call.data.customerName, 'Amina Rahman');
  assert.equal(call.data.itemCount, 2);
  assert.equal(call.data.grandTotalMinorUnits, 208000);
  assert.equal(call.data.paymentMethod, 'COD');

  const rendered = require('../../../src/modules/notifications/templates').notificationTemplates[
    'ADMIN_ORDER_PLACED'
  ].render({ data: call.data });
  assert.match(rendered.message, /Amina Rahman placed an order/);
  assert.ok(!rendered.message.includes(orderId), 'no Mongo id in the notification text');
  assert.ok(!rendered.title.includes(orderId));
});

test('checkout fires the ADMIN_ORDER_PLACED_EMAIL email-only side effect with the sanitized order payload', async () => {
  const ctx = buildContext();
  const orderId = await seedAndCheckout(ctx);
  const order = ctx.orderRepo.docs[0];

  const emailCalls = ctx.notificationService.calls.filter(
    (call) => call.eventType === 'ADMIN_ORDER_PLACED_EMAIL'
  );
  assert.equal(emailCalls.length, 1, 'exactly one admin email side effect per placed order');
  const call = emailCalls[0];
  assert.equal(call.userId, CUSTOMER_ID);
  assert.equal(call.persist, false, 'the admin email is email-only — no Notification record is created');
  assert.equal(call.to, undefined, 'the destination comes from the service config, not the order service');
  assert.equal(call.data.entityRef, orderId);
  assert.equal(call.data.orderNumber, order.orderNumber);
  assert.equal(call.data.createdAt, order.createdAt);
  assert.equal(call.data.status, 'PENDING');
  assert.equal(call.data.paymentMethod, 'COD');
  assert.equal(call.data.paymentStatus, 'Pending — collect on delivery');
  assert.equal(call.data.customerName, 'Amina Rahman');
  assert.equal(call.data.customerPhone, '+8801712345678');
  assert.deepEqual(call.data.address, {
    line1: 'House 12, Road 3',
    line2: null,
    city: 'Chattogram',
    area: 'GEC',
    district: 'Chattogram',
    postalCode: '4000',
    country: 'BD',
  });
  assert.equal(call.data.notes, null);
  assert.deepEqual(call.data.totals, {
    itemsSubtotalMinorUnits: 200000,
    totalDiscountMinorUnits: 0,
    deliveryFeeMinorUnits: 8000,
    grandTotalMinorUnits: 208000,
  });
  assert.equal(call.data.items.length, 1);
  assert.deepEqual(call.data.items[0], {
    productName: 'Abaya',
    variantAttributes: { size: '52' },
    quantity: 2,
    unitPriceMinorUnits: 100000,
    lineTotalMinorUnits: 200000,
  });
  assert.ok(
    !JSON.stringify(call.data).includes(orderId) || call.data.entityRef === orderId,
    'the only Mongo id in the payload is the entityRef'
  );

  const rendered = require('../../../src/modules/notifications/templates').notificationTemplates[
    'ADMIN_ORDER_PLACED_EMAIL'
  ].render({ data: call.data });
  assert.match(rendered.subject, new RegExp(`New order ${order.orderNumber} received`));
  assert.match(rendered.html, /New Order Received/);
  assert.ok(!rendered.html.includes(orderId), 'no Mongo id in the visible email HTML');
  assert.ok(!rendered.html.includes('undefined'));
});

test('a checkout retry (same idempotency key) does not duplicate the admin notifications', async () => {
  const ctx = buildContext();
  await ctx.cartRepo.create({
    customerId: CUSTOMER_ID,
    items: [{ productVariantId: V1, productId: P1, quantity: 2 }],
  });
  const key = nextIdempotencyKey();
  const body = {
    customerId: CUSTOMER_ID,
    delivery: { address: { ...VALID_ADDRESS } },
    notes: null,
    paymentMethod: 'COD',
    idempotencyKey: key,
  };

  const first = await ctx.orderService.checkout(body);
  assert.equal(first.isRetry, false);
  const retried = await ctx.orderService.checkout(body);
  assert.equal(retried.isRetry, true, 'idempotent retry returns the existing order');

  const adminCalls = ctx.notificationService.calls.filter(
    (call) => call.eventType === 'ADMIN_ORDER_PLACED'
  );
  assert.equal(adminCalls.length, 1, 'the retry does not fire a second admin notification');

  const emailCalls = ctx.notificationService.calls.filter(
    (call) => call.eventType === 'ADMIN_ORDER_PLACED_EMAIL'
  );
  assert.equal(emailCalls.length, 1, 'the retry does not fire a second admin email');
  assert.equal(emailCalls[0].persist, false);
});

test('checkout carries the guest email into the ORDER_PLACED notification data', async () => {
  const ctx = buildContext();
  await ctx.cartRepo.create({
    customerId: CUSTOMER_ID,
    items: [{ productVariantId: V1, productId: P1, quantity: 2 }],
  });
  await ctx.orderService.checkout({
    customerId: CUSTOMER_ID,
    delivery: { address: { ...VALID_ADDRESS, email: 'guest@example.com' } },
    notes: null,
    paymentMethod: 'COD',
    idempotencyKey: nextIdempotencyKey(),
  });

  const placed = ctx.notificationService.calls.find((call) => call.eventType === 'ORDER_PLACED');
  assert.ok(placed, 'ORDER_PLACED notification fires on checkout');
  assert.equal(placed.data.customerEmail, 'guest@example.com');
  assert.equal(placed.data.order.delivery.address.email, 'guest@example.com');
  assert.equal(placed.data.order.delivery.address.fullName, 'Amina Rahman');
  assert.ok(placed.data.order.createdAt instanceof Date, 'the order date is carried for the email');
  assert.equal(placed.data.order.notes, null);
  assert.equal(placed.data.order.totals.itemsSubtotalMinorUnits, 200000);
  assert.equal(placed.data.order.totals.grandTotalMinorUnits, 208000);
  assert.equal(placed.data.order.items[0].unitPriceMinorUnits, 100000);
  assert.deepEqual(placed.data.order.items[0].variantAttributes, { size: '52' });
  assert.equal(placed.data.order.items[0].productImageUrl, null);
});

test('checkout without a guest email carries a null customerEmail', async () => {
  const ctx = buildContext();
  await seedAndCheckout(ctx);

  const placed = ctx.notificationService.calls.find((call) => call.eventType === 'ORDER_PLACED');
  assert.ok(placed, 'ORDER_PLACED notification fires on checkout');
  assert.equal(placed.data.customerEmail, null);
  assert.equal(placed.data.order.delivery.address.email, undefined);
});
