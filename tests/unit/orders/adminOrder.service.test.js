'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { AdminOrderService } = require('../../../src/modules/orders/adminOrder.service');
const { OrderService } = require('../../../src/modules/orders/order.service');
const { ReservationService } = require('../../../src/modules/inventory/reservation.service');
const { ERROR_CODES } = require('../../../src/constants');
const { ORDER_STATUSES, ORDER_MESSAGES } = require('../../../src/modules/orders/order.constants');
const { PAYMENT_STATUSES } = require('../../../src/modules/payments/payment.constants');
const { createMemoryVariantRepository } = require('../../helpers/inventory-stubs');
const {
  createMemoryInventoryRepository,
  createMemoryMovementRepository,
  createMemoryReservationRepository,
  noopTransaction,
} = require('../../helpers/inventory-stubs');
const {
  createMemoryOrderRepository,
  createMemoryCartRepository,
  createMemoryProductRepository,
  createRollbackTransaction,
} = require('../../helpers/order-stubs');
const { createMemoryPaymentRepository } = require('../../helpers/payment-stubs');

const CUSTOMER_ID = '507f1f77bcf86cd799439011';
const STAFF_ID = '507f1f77bcf86cd799439022';
const P1 = '507f1f77bcf86cd799439031';
const V1 = '507f1f77bcf86cd799439041';

function buildContext(initialOrders = []) {
  const orderRepo = createMemoryOrderRepository(initialOrders);
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
  const paymentRepo = createMemoryPaymentRepository();

  const reservationService = new ReservationService({
    reservationRepository: resRepo,
    inventoryRepository: invRepo,
    movementRepository: movRepo,
    variantRepository: variantRepo,
    runTransaction: noopTransaction,
  });
  const orderService = new OrderService({
    orderRepository: orderRepo,
    cartRepository: cartRepo,
    productRepository: productRepo,
    variantRepository: variantRepo,
    reservationService,
    runTransaction: createRollbackTransaction([orderRepo, cartRepo, invRepo, resRepo, movRepo]),
  });
  const adminOrderService = new AdminOrderService({
    orderRepository: orderRepo,
    orderService,
    paymentRepository: paymentRepo,
  });

  return { adminOrderService, orderService, orderRepo, resRepo, invRepo, paymentRepo };
}

function orderDoc(overrides = {}) {
  return {
    _id: '507f1f77bcf86cd7994390b1',
    customerId: CUSTOMER_ID,
    orderNumber: 'TAQ-20260808-123456',
    idempotencyKey: 'key-1',
    idempotencyFingerprint: 'f',
    status: ORDER_STATUSES.PENDING,
    statusHistory: [{ status: ORDER_STATUSES.PENDING, at: new Date(), by: CUSTOMER_ID, note: null }],
    delivery: { address: { city: 'Chattogram', district: 'Chattogram' }, zone: 'INSIDE_CHITTAGONG', deliveryFeeMinorUnits: 0 },
    totals: { itemsSubtotalMinorUnits: 100000, totalDiscountMinorUnits: 0, deliveryFeeMinorUnits: 0, grandTotalMinorUnits: 100000 },
    items: [],
    reservationReference: null,
    paymentMethod: 'COD',
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

test('confirm moves PENDING → CONFIRMED', async () => {
  const ctx = buildContext([orderDoc()]);
  const updated = await ctx.adminOrderService.confirmOrder({ orderId: '507f1f77bcf86cd7994390b1', performedBy: STAFF_ID, note: null });
  assert.equal(updated.status, ORDER_STATUSES.CONFIRMED);
  const last = updated.statusHistory[updated.statusHistory.length - 1];
  assert.equal(last.status, ORDER_STATUSES.CONFIRMED);
  assert.equal(last.by, STAFF_ID);
});

test('confirm of a non-PENDING order → ORDER_CONFIRMATION_NOT_ALLOWED', async () => {
  const ctx = buildContext([orderDoc({ status: ORDER_STATUSES.CONFIRMED })]);
  await assert.rejects(
    ctx.adminOrderService.confirmOrder({ orderId: '507f1f77bcf86cd7994390b1', performedBy: STAFF_ID, note: null }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.ORDER_CONFIRMATION_NOT_ALLOWED
  );
});

test('confirm of a manual-method order requires a VERIFIED payment', async () => {
  const ctx = buildContext([orderDoc({ paymentMethod: 'BKASH' })]);
  await assert.rejects(
    ctx.adminOrderService.confirmOrder({ orderId: '507f1f77bcf86cd7994390b1', performedBy: STAFF_ID, note: null }),
    (err) =>
      err.statusCode === 409 &&
      err.code === ERROR_CODES.ORDER_CONFIRMATION_NOT_ALLOWED &&
      err.message === ORDER_MESSAGES.PAYMENT_VERIFICATION_REQUIRED
  );

  await ctx.paymentRepo.create({
    orderId: '507f1f77bcf86cd7994390b1',
    status: PAYMENT_STATUSES.VERIFIED,
    statusHistory: [],
  });
  const updated = await ctx.adminOrderService.confirmOrder({ orderId: '507f1f77bcf86cd7994390b1', performedBy: STAFF_ID, note: null });
  assert.equal(updated.status, ORDER_STATUSES.CONFIRMED);
});

test('confirm of a manual-method order with a non-VERIFIED payment is blocked', async () => {
  const ctx = buildContext([orderDoc({ paymentMethod: 'BANK_TRANSFER' })]);
  await ctx.paymentRepo.create({
    orderId: '507f1f77bcf86cd7994390b1',
    status: PAYMENT_STATUSES.SUBMITTED,
    statusHistory: [],
  });
  await assert.rejects(
    ctx.adminOrderService.confirmOrder({ orderId: '507f1f77bcf86cd7994390b1', performedBy: STAFF_ID, note: null }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.ORDER_CONFIRMATION_NOT_ALLOWED
  );
});

test('process moves CONFIRMED → PROCESSING', async () => {
  const ctx = buildContext([orderDoc({ status: ORDER_STATUSES.CONFIRMED })]);
  const updated = await ctx.adminOrderService.processOrder({ orderId: '507f1f77bcf86cd7994390b1', performedBy: STAFF_ID, note: 'packing' });
  assert.equal(updated.status, ORDER_STATUSES.PROCESSING);
  assert.equal(updated.statusHistory[updated.statusHistory.length - 1].note, 'packing');
});

test('process of a non-CONFIRMED order → ORDER_PROCESSING_NOT_ALLOWED', async () => {
  const ctx = buildContext([orderDoc()]);
  await assert.rejects(
    ctx.adminOrderService.processOrder({ orderId: '507f1f77bcf86cd7994390b1', performedBy: STAFF_ID, note: null }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.ORDER_PROCESSING_NOT_ALLOWED
  );
});

test('ship moves DISPATCHED → SHIPPED', async () => {
  const ctx = buildContext([orderDoc({ status: ORDER_STATUSES.DISPATCHED })]);
  const updated = await ctx.adminOrderService.shipOrder({ orderId: '507f1f77bcf86cd7994390b1', performedBy: STAFF_ID, note: 'handed to Pathao' });
  assert.equal(updated.status, ORDER_STATUSES.SHIPPED);
  const last = updated.statusHistory[updated.statusHistory.length - 1];
  assert.equal(last.status, ORDER_STATUSES.SHIPPED);
  assert.equal(last.by, STAFF_ID);
  assert.equal(last.note, 'handed to Pathao');
});

test('ship of a non-DISPATCHED order → ORDER_INVALID_STATE', async () => {
  const ctx = buildContext([orderDoc()]);
  await assert.rejects(
    ctx.adminOrderService.shipOrder({ orderId: '507f1f77bcf86cd7994390b1', performedBy: STAFF_ID, note: null }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.ORDER_INVALID_STATE
  );
});

test('deliver moves SHIPPED → DELIVERED', async () => {
  const ctx = buildContext([orderDoc({ status: ORDER_STATUSES.SHIPPED })]);
  const updated = await ctx.adminOrderService.deliverOrder({ orderId: '507f1f77bcf86cd7994390b1', performedBy: STAFF_ID, note: 'received' });
  assert.equal(updated.status, ORDER_STATUSES.DELIVERED);
  const last = updated.statusHistory[updated.statusHistory.length - 1];
  assert.equal(last.status, ORDER_STATUSES.DELIVERED);
  assert.equal(last.by, STAFF_ID);
  assert.equal(last.note, 'received');
});

test('deliver of a non-SHIPPED order → ORDER_INVALID_STATE', async () => {
  const ctx = buildContext([orderDoc({ status: ORDER_STATUSES.DISPATCHED })]);
  await assert.rejects(
    ctx.adminOrderService.deliverOrder({ orderId: '507f1f77bcf86cd7994390b1', performedBy: STAFF_ID, note: null }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.ORDER_INVALID_STATE
  );
});

test('return moves SHIPPED → RETURNED and releases reservations', async () => {
  const ctx = buildContext([
    orderDoc({
      status: ORDER_STATUSES.SHIPPED,
      reservationReference: { reservationIds: ['507f1f77bcf86cd7994390c3'], referenceType: 'ORDER' },
    }),
  ]);
  const resDoc = await ctx.resRepo.create({
    _id: '507f1f77bcf86cd7994390c3',
    productVariantId: V1,
    quantity: 2,
    status: 'ACTIVE',
    referenceType: 'ORDER',
    referenceId: '507f1f77bcf86cd7994390b1',
  });
  await ctx.invRepo.reserveOnline(V1, 2);

  const updated = await ctx.adminOrderService.returnOrder({ orderId: '507f1f77bcf86cd7994390b1', performedBy: STAFF_ID, note: 'customer refused' });
  assert.equal(updated.status, ORDER_STATUSES.RETURNED);
  assert.equal(resDoc.status, 'RELEASED');
  assert.equal(ctx.invRepo.docs[0].reservedQuantity, 0, 'returned order stock is returned to availability');
});

test('return of a non-SHIPPED order → ORDER_INVALID_STATE', async () => {
  const ctx = buildContext([orderDoc({ status: ORDER_STATUSES.DELIVERED })]);
  await assert.rejects(
    ctx.adminOrderService.returnOrder({ orderId: '507f1f77bcf86cd7994390b1', performedBy: STAFF_ID, note: null }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.ORDER_INVALID_STATE
  );
});

test('complete moves DELIVERED → COMPLETED', async () => {
  const ctx = buildContext([orderDoc({ status: ORDER_STATUSES.DELIVERED })]);
  const updated = await ctx.adminOrderService.completeOrder({ orderId: '507f1f77bcf86cd7994390b1', performedBy: STAFF_ID, note: null });
  assert.equal(updated.status, ORDER_STATUSES.COMPLETED);
  assert.equal(updated.statusHistory[updated.statusHistory.length - 1].status, ORDER_STATUSES.COMPLETED);
});

test('complete of a non-DELIVERED order → ORDER_INVALID_STATE', async () => {
  const ctx = buildContext([orderDoc({ status: ORDER_STATUSES.SHIPPED })]);
  await assert.rejects(
    ctx.adminOrderService.completeOrder({ orderId: '507f1f77bcf86cd7994390b1', performedBy: STAFF_ID, note: null }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.ORDER_INVALID_STATE
  );
});

test('reject moves PENDING → REJECTED and releases reservations', async () => {
  const ctx = buildContext([
    orderDoc({
      reservationReference: { reservationIds: ['507f1f77bcf86cd7994390c1'], referenceType: 'ORDER' },
    }),
  ]);
  const resDoc = await ctx.resRepo.create({
    _id: '507f1f77bcf86cd7994390c1',
    productVariantId: V1,
    quantity: 2,
    status: 'ACTIVE',
    referenceType: 'ORDER',
    referenceId: '507f1f77bcf86cd7994390b1',
  });
  await ctx.invRepo.reserveOnline(V1, 2);

  const updated = await ctx.adminOrderService.rejectOrder({ orderId: '507f1f77bcf86cd7994390b1', performedBy: STAFF_ID, note: 'no stock' });
  assert.equal(updated.status, ORDER_STATUSES.REJECTED);
  assert.equal(resDoc.status, 'RELEASED');
  assert.equal(ctx.invRepo.docs[0].reservedQuantity, 0, 'rejected order stock is returned to availability');
});

test('reject of a non-PENDING order → ORDER_REJECTION_NOT_ALLOWED', async () => {
  const ctx = buildContext([orderDoc({ status: ORDER_STATUSES.PROCESSING })]);
  await assert.rejects(
    ctx.adminOrderService.rejectOrder({ orderId: '507f1f77bcf86cd7994390b1', performedBy: STAFF_ID, note: null }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.ORDER_REJECTION_NOT_ALLOWED
  );
});

test('getOrder returns the admin representation and 404s on missing orders', async () => {
  const ctx = buildContext([
    orderDoc({ reservationReference: { reservationIds: ['507f1f77bcf86cd7994390c2'], referenceType: 'ORDER' } }),
  ]);
  const order = await ctx.adminOrderService.getOrder('507f1f77bcf86cd7994390b1');
  assert.ok(order.reservationReference, 'admin detail exposes reservation ids');
  await assert.rejects(
    ctx.adminOrderService.getOrder('507f1f77bcf86cd799439999'),
    (err) => err.statusCode === 404 && err.code === ERROR_CODES.ORDER_NOT_FOUND
  );
});

test('listOrders filters by status/customerId and paginates', async () => {
  const ctx = buildContext([
    orderDoc(),
    orderDoc({ _id: '507f1f77bcf86cd7994390b2', customerId: '507f1f77bcf86cd799439033', orderNumber: 'TAQ-20260808-654321', status: ORDER_STATUSES.CONFIRMED }),
    orderDoc({ _id: '507f1f77bcf86cd7994390b3', customerId: '507f1f77bcf86cd799439044', orderNumber: 'TAQ-20260808-000001', status: ORDER_STATUSES.CONFIRMED }),
  ]);

  const all = await ctx.adminOrderService.listOrders({});
  assert.equal(all.orders.length, 3);
  assert.equal(all.pagination.total, 3);

  const confirmed = await ctx.adminOrderService.listOrders({ status: ORDER_STATUSES.CONFIRMED });
  assert.equal(confirmed.orders.length, 2);
  assert.ok(confirmed.orders.every((o) => o.status === ORDER_STATUSES.CONFIRMED));

  const byCustomer = await ctx.adminOrderService.listOrders({ customerId: CUSTOMER_ID });
  assert.equal(byCustomer.orders.length, 1);

  const paged = await ctx.adminOrderService.listOrders({ page: 2, limit: 2 });
  assert.equal(paged.orders.length, 1);
  assert.equal(paged.pagination.totalPages, 2);
});

test('listOrders rejects an invalid status filter', async () => {
  const ctx = buildContext();
  await assert.rejects(
    ctx.adminOrderService.listOrders({ status: 'RETURN_REQUESTED' }),
    (err) => err.statusCode === 400 && err.code === ERROR_CODES.INVALID_ORDER
  );
});
