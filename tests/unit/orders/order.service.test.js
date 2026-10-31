'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { OrderService } = require('../../../src/modules/orders/order.service');
const { ReservationService } = require('../../../src/modules/inventory/reservation.service');
const { ERROR_CODES, ROLES, ACCOUNT_STATUSES } = require('../../../src/constants');
const { ORDER_STATUSES, ORDER_LIMITS } = require('../../../src/modules/orders/order.constants');
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

const CUSTOMER_ID = '507f1f77bcf86cd799439011';
const OTHER_CUSTOMER_ID = '507f1f77bcf86cd799439022';

const P1 = '507f1f77bcf86cd799439031';
const P2 = '507f1f77bcf86cd799439032';
const V1 = '507f1f77bcf86cd799439041';
const V2 = '507f1f77bcf86cd799439042';

function product(id, overrides = {}) {
  return {
    _id: id,
    name: id === P1 ? 'Abaya' : 'Kurta',
    slug: id === P1 ? 'abaya' : 'kurta',
    sellingPrice: 100000,
    discount: id === P2 ? { type: 'percentage', value: 10 } : null,
    isActive: true,
    ...overrides,
  };
}

function variant(id, overrides = {}) {
  return {
    _id: id,
    productId: id === V1 ? P1 : P2,
    sku: id === V1 ? 'ABAYA-52' : 'KURTA-L',
    attributes: { size: id === V1 ? '52' : 'L' },
    isActive: true,
    ...(id === V2 ? { sellingPriceOverride: 60000 } : {}),
    ...overrides,
  };
}

const VALID_ADDRESS = {
  fullName: 'Amina Rahman',
  phone: '+8801712345678',
  line1: 'House 12',
  line2: null,
  city: 'Chattogram',
  area: 'GEC',
  district: 'Chattogram',
  postalCode: '4000',
  country: 'BD',
};

function buildContext({ inventory = true, products, variants } = {}) {
  const productsList = products || [product(P1), product(P2)];
  const variantsList = variants || [variant(V1), variant(V2)];

  const orderRepo = createMemoryOrderRepository();
  const cartRepo = createMemoryCartRepository();
  const productRepo = createMemoryProductRepository(productsList);
  const variantRepo = createMemoryVariantRepository(variantsList);
  const invRepo = createMemoryInventoryRepository();
  const movRepo = createMemoryMovementRepository();
  const resRepo = createMemoryReservationRepository();

  if (inventory) {
    invRepo.docs.push(
      { _id: '507f1f77bcf86cd7994390a1', productVariantId: V1, onlineQuantity: 20, offlineQuantity: 5, reservedQuantity: 0, lowStockThreshold: 2 },
      { _id: '507f1f77bcf86cd7994390a2', productVariantId: V2, onlineQuantity: 10, offlineQuantity: 0, reservedQuantity: 0, lowStockThreshold: 2 }
    );
  }

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

  return { orderService, orderRepo, cartRepo, productRepo, variantRepo, invRepo, resRepo, movRepo };
}

async function seedCart(cartRepo, items) {
  await cartRepo.create({ customerId: CUSTOMER_ID, items });
}

function checkoutBody(overrides = {}) {
  return {
    delivery: { address: { ...VALID_ADDRESS } },
    notes: null,
    paymentMethod: 'COD',
    ...overrides,
  };
}

async function doCheckout(ctx, overrides = {}) {
  return ctx.orderService.checkout({
    customerId: CUSTOMER_ID,
    ...checkoutBody(overrides.body),
    idempotencyKey: overrides.idempotencyKey || 'order-key-1',
  });
}

test('OrderService constructor validates its dependencies', () => {
  assert.throws(() => new OrderService({}), /orderRepository/);
  const ctx = buildContext();
  assert.throws(
    () => new OrderService({ ...ctx, orderRepository: null }),
    /orderRepository/
  );
});

test('computeFingerprint is stable for equal requests and sensitive to changes', () => {
  const ctx = buildContext();
  const a = ctx.orderService.computeFingerprint({ delivery: { address: VALID_ADDRESS }, notes: null, paymentMethod: 'COD' });
  const b = ctx.orderService.computeFingerprint({ delivery: { address: VALID_ADDRESS }, notes: null, paymentMethod: 'COD' });
  assert.equal(a, b);
  const different = ctx.orderService.computeFingerprint({ delivery: { address: { ...VALID_ADDRESS, line1: 'Other' } }, notes: null, paymentMethod: 'COD' });
  assert.notEqual(a, different);
});

test('generateOrderNumber produces the TAQ-YYYYMMDD-XXXXXX format', () => {
  const ctx = buildContext();
  const number = ctx.orderService.generateOrderNumber(new Date('2026-08-08T10:00:00Z'));
  assert.match(number, /^TAQ-20260808-\d{6}$/);
});

test('checkout creates a PENDING order with server-derived money, zone, and reservations', async () => {
  const ctx = buildContext();
  await seedCart(ctx.cartRepo, [
    { productVariantId: V1, productId: P1, quantity: 2 },
    { productVariantId: V2, productId: P2, quantity: 1 },
  ]);

  const outcome = await doCheckout(ctx);

  assert.equal(outcome.isRetry, false);
  const order = outcome.order;
  assert.equal(order.status, ORDER_STATUSES.PENDING);
  assert.match(order.orderNumber, /^TAQ-\d{8}-\d{6}$/);
  assert.equal(order.delivery.zone, 'INSIDE_CHITTAGONG');
  assert.equal(order.totals.itemsSubtotalMinorUnits, 254000);
  assert.equal(order.totals.totalDiscountMinorUnits, 6000);
  assert.equal(order.totals.deliveryFeeMinorUnits, 8000);
  assert.equal(order.totals.grandTotalMinorUnits, 256000);
  assert.equal(order.items[0].unitPriceMinorUnits, 100000);
  assert.equal(order.items[0].discountMinorUnits, 0);
  assert.equal(order.items[1].unitPriceMinorUnits, 54000, 'percentage discount applied on top of override price');
  assert.equal(order.items[1].discountMinorUnits, 6000);
  assert.equal(order.reservationReference, undefined, 'customers never see reservation internals');

  assert.equal(ctx.orderRepo.docs.length, 1);
  assert.equal(ctx.resRepo.docs.length, 2, 'one reservation per order line');
  for (const reservation of ctx.resRepo.docs) {
    assert.equal(reservation.referenceType, 'ORDER');
    assert.equal(reservation.referenceId, ctx.orderRepo.docs[0]._id);
  }
  assert.equal(ctx.resRepo.docs[0].metadata.orderId, ctx.orderRepo.docs[0]._id);
  assert.equal(ctx.invRepo.docs[0].reservedQuantity, 2);
  assert.equal(ctx.invRepo.docs[1].reservedQuantity, 1);
  assert.equal(ctx.cartRepo.docs[0].isCheckedOut, true, 'cart is atomically checked out + cleared');
  assert.equal(ctx.cartRepo.docs[0].items.length, 0);

  const stored = ctx.orderRepo.docs[0];
  assert.deepEqual(stored.reservationReference.reservationIds.map(String), ctx.resRepo.docs.map((r) => String(r._id)));
});

test('checkout snapshots the selected size on each order line', async () => {
  const ctx = buildContext({
    variants: [
      variant(V1, { attributes: { size: 'S, M, L' } }),
      variant(V2, { attributes: { size: '52' } }),
    ],
  });
  await seedCart(ctx.cartRepo, [
    { productVariantId: V1, productId: P1, quantity: 1, selectedSize: 'M' },
    { productVariantId: V2, productId: P2, quantity: 1 },
  ]);

  const outcome = await doCheckout(ctx);

  assert.deepEqual(
    outcome.order.items[0].variantAttributes,
    { size: 'M' },
    'the embedded item records the picked size, not the packed size list'
  );
  assert.deepEqual(
    outcome.order.items[1].variantAttributes,
    { size: '52' },
    'variants without a chosen size snapshot their full attribute set'
  );
  assert.equal(ctx.orderRepo.docs[0].items[0].variantAttributes.size, 'M');
});

test('checkout inside-Chittagong vs outside zone derivation', async () => {
  const ctx = buildContext();
  await seedCart(ctx.cartRepo, [{ productVariantId: V1, productId: P1, quantity: 1 }]);
  const inside = await doCheckout(ctx);
  assert.equal(inside.order.delivery.zone, 'INSIDE_CHITTAGONG');

  const ctx2 = buildContext();
  await seedCart(ctx2.cartRepo, [{ productVariantId: V1, productId: P1, quantity: 1 }]);
  const outside = await ctx2.orderService.checkout({
    customerId: CUSTOMER_ID,
    delivery: { address: { ...VALID_ADDRESS, city: 'Dhaka', district: 'Dhaka' } },
    notes: null,
    paymentMethod: 'COD',
    idempotencyKey: 'order-key-2',
  });
  assert.equal(outside.order.delivery.zone, 'OUTSIDE_CHITTAGONG');
});

test('checkout honors the customer-selected zone and charges its fee', async () => {
  const ctx = buildContext();
  await seedCart(ctx.cartRepo, [{ productVariantId: V1, productId: P1, quantity: 1 }]);

  // Chattogram address would derive INSIDE, but the customer's selection wins.
  const inside = await doCheckout(ctx, {
    body: { delivery: { address: { ...VALID_ADDRESS }, zone: 'INSIDE_CHITTAGONG' } },
  });
  assert.equal(inside.order.delivery.zone, 'INSIDE_CHITTAGONG');
  assert.equal(inside.order.delivery.deliveryFeeMinorUnits, 8000);
  assert.equal(inside.order.totals.deliveryFeeMinorUnits, 8000);

  const ctx2 = buildContext();
  await seedCart(ctx2.cartRepo, [{ productVariantId: V1, productId: P1, quantity: 1 }]);
  const outside = await ctx2.orderService.checkout({
    customerId: CUSTOMER_ID,
    delivery: { address: { ...VALID_ADDRESS }, zone: 'OUTSIDE_CHITTAGONG' },
    notes: null,
    paymentMethod: 'COD',
    idempotencyKey: 'order-key-zone',
  });
  assert.equal(outside.order.delivery.zone, 'OUTSIDE_CHITTAGONG');
  assert.equal(outside.order.delivery.deliveryFeeMinorUnits, 15000);
  assert.equal(outside.order.totals.deliveryFeeMinorUnits, 15000);
});

test('checkout retry with the same key + body returns the original order (idempotent)', async () => {
  const ctx = buildContext();
  await seedCart(ctx.cartRepo, [{ productVariantId: V1, productId: P1, quantity: 1 }]);

  const first = await doCheckout(ctx);
  const second = await doCheckout(ctx);

  assert.equal(second.isRetry, true);
  assert.equal(second.order.id, first.order.id);
  assert.equal(ctx.orderRepo.docs.length, 1, 'no second order is created');
  assert.equal(ctx.resRepo.docs.length, 1, 'no second reservation is created');
  assert.equal(ctx.invRepo.docs[0].reservedQuantity, 1, 'stock is not double-reserved');
});

test('checkout retry with the same key but a different body → ORDER_IDEMPOTENCY_CONFLICT', async () => {
  const ctx = buildContext();
  await seedCart(ctx.cartRepo, [{ productVariantId: V1, productId: P1, quantity: 1 }]);

  await doCheckout(ctx);
  await assert.rejects(
    doCheckout(ctx, { body: { notes: 'changed' } }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.ORDER_IDEMPOTENCY_CONFLICT
  );
});

test('checkout of an empty or missing cart fails cleanly', async () => {
  const ctx = buildContext();
  await assert.rejects(
    doCheckout(ctx),
    (err) => err.statusCode === 404 && err.code === ERROR_CODES.CART_NOT_FOUND
  );

  const ctx2 = buildContext();
  await seedCart(ctx2.cartRepo, []);
  await assert.rejects(
    doCheckout(ctx2),
    (err) => err.statusCode === 400 && err.code === ERROR_CODES.CART_EMPTY
  );

  const ctx3 = buildContext();
  await seedCart(ctx3.cartRepo, [{ productVariantId: V1, productId: P1, quantity: 1 }]);
  await doCheckout(ctx3);
  await assert.rejects(
    ctx3.orderService.checkout({
      customerId: CUSTOMER_ID,
      ...checkoutBody(),
      idempotencyKey: 'order-key-2',
    }),
    (err) => err.statusCode === 400 && err.code === ERROR_CODES.CART_EMPTY,
    'a checked-out cart is treated as empty (fresh key)'
  );
});

test('checkout rejects inactive or unknown catalog lines', async () => {
  const ctx = buildContext({ variants: [variant(V1, { isActive: false })] });
  await seedCart(ctx.cartRepo, [{ productVariantId: V1, productId: P1, quantity: 1 }]);
  await assert.rejects(
    doCheckout(ctx),
    (err) => err.statusCode === 404 && err.code === ERROR_CODES.INVALID_CART_ITEM
  );
});

test('checkout with insufficient online stock fails and rolls back the whole transaction', async () => {
  const ctx = buildContext();
  await seedCart(ctx.cartRepo, [
    { productVariantId: V1, productId: P1, quantity: 2 },
    { productVariantId: V2, productId: P2, quantity: 99 },
  ]);

  await assert.rejects(
    doCheckout(ctx),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.INSUFFICIENT_AVAILABLE_STOCK
  );

  assert.equal(ctx.orderRepo.docs.length, 0, 'no order survives a failed checkout');
  assert.equal(ctx.resRepo.docs.length, 0, 'no reservations survive a failed checkout');
  assert.equal(ctx.invRepo.docs[0].reservedQuantity, 0, 'no stock is left reserved');
  assert.equal(ctx.cartRepo.docs[0].isCheckedOut, false, 'cart is not cleared on failure');
});

test('order-number collisions are retried and eventually succeed', async () => {
  const ctx = buildContext();
  await seedCart(ctx.cartRepo, [{ productVariantId: V1, productId: P1, quantity: 1 }]);
  await ctx.orderRepo.create({
    customerId: OTHER_CUSTOMER_ID,
    orderNumber: 'TAQ-20260808-111111',
    idempotencyKey: 'other-key',
    idempotencyFingerprint: 'x',
    status: ORDER_STATUSES.PENDING,
    statusHistory: [],
    delivery: {},
    totals: {},
    items: [],
  });

  let calls = 0;
  ctx.orderService.generateOrderNumber = () => {
    calls += 1;
    return calls === 1 ? 'TAQ-20260808-111111' : 'TAQ-20260808-222222';
  };

  const outcome = await doCheckout(ctx);
  assert.equal(outcome.order.orderNumber, 'TAQ-20260808-222222');
  assert.equal(calls, 2);
});

test('order-number collision exhaustion → ORDER_NUMBER_GENERATION_FAILED', async () => {
  const ctx = buildContext();
  await seedCart(ctx.cartRepo, [{ productVariantId: V1, productId: P1, quantity: 1 }]);
  await ctx.orderRepo.create({
    customerId: OTHER_CUSTOMER_ID,
    orderNumber: 'TAQ-20260808-111111',
    idempotencyKey: 'other-key',
    idempotencyFingerprint: 'x',
    status: ORDER_STATUSES.PENDING,
    statusHistory: [],
    delivery: {},
    totals: {},
    items: [],
  });
  ctx.orderService.generateOrderNumber = () => 'TAQ-20260808-111111';

  await assert.rejects(
    doCheckout(ctx),
    (err) => err.statusCode === 500 && err.code === ERROR_CODES.ORDER_NUMBER_GENERATION_FAILED
  );
});

test('performTransition moves state and releases reservations on terminal cancel', async () => {
  const ctx = buildContext();
  await seedCart(ctx.cartRepo, [
    { productVariantId: V1, productId: P1, quantity: 2 },
    { productVariantId: V2, productId: P2, quantity: 1 },
  ]);
  const { order } = await doCheckout(ctx);
  const orderId = order.id;

  const updated = await ctx.orderService.performTransition({
    orderId,
    fromStatus: ORDER_STATUSES.PENDING,
    toStatus: ORDER_STATUSES.CANCELLED,
    performedBy: CUSTOMER_ID,
    note: 'customer changed mind',
    notAllowedError: ctx.orderService.cancellationNotAllowed(),
  });

  assert.equal(updated.status, ORDER_STATUSES.CANCELLED);
  const lastEntry = updated.statusHistory[updated.statusHistory.length - 1];
  assert.equal(lastEntry.status, ORDER_STATUSES.CANCELLED);
  assert.equal(lastEntry.by, CUSTOMER_ID);
  assert.equal(lastEntry.note, 'customer changed mind');
  assert.equal(ctx.resRepo.docs.every((r) => r.status === 'RELEASED'), true, 'reservations are released in the same transaction');
  assert.equal(ctx.invRepo.docs[0].reservedQuantity, 0);
  assert.equal(ctx.invRepo.docs[1].reservedQuantity, 0);
});

test('performTransition rejects a stale/incorrect fromStatus with the caller error', async () => {
  const ctx = buildContext();
  await seedCart(ctx.cartRepo, [{ productVariantId: V1, productId: P1, quantity: 1 }]);
  const { order } = await doCheckout(ctx);

  await assert.rejects(
    ctx.orderService.performTransition({
      orderId: order.id,
      fromStatus: ORDER_STATUSES.CONFIRMED,
      toStatus: ORDER_STATUSES.PROCESSING,
      performedBy: CUSTOMER_ID,
      note: null,
      notAllowedError: ctx.orderService.processingNotAllowed(),
    }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.ORDER_PROCESSING_NOT_ALLOWED
  );
  assert.equal(ctx.orderRepo.docs[0].status, ORDER_STATUSES.PENDING, 'status is unchanged');
});

test('performTransition on a missing order → ORDER_NOT_FOUND', async () => {
  const ctx = buildContext();
  await assert.rejects(
    ctx.orderService.performTransition({
      orderId: '507f1f77bcf86cd799439999',
      fromStatus: ORDER_STATUSES.PENDING,
      toStatus: ORDER_STATUSES.CANCELLED,
      performedBy: CUSTOMER_ID,
      note: null,
      notAllowedError: ctx.orderService.cancellationNotAllowed(),
    }),
    (err) => err.statusCode === 404 && err.code === ERROR_CODES.ORDER_NOT_FOUND
  );
});

test('customer cancel is scoped to own orders (cross-customer → 404)', async () => {
  const ctx = buildContext();
  await seedCart(ctx.cartRepo, [{ productVariantId: V1, productId: P1, quantity: 1 }]);
  const { order } = await doCheckout(ctx);

  await assert.rejects(
    ctx.orderService.cancelCustomerOrder({
      customerId: OTHER_CUSTOMER_ID,
      orderId: order.id,
      performedBy: OTHER_CUSTOMER_ID,
    }),
    (err) => err.statusCode === 404 && err.code === ERROR_CODES.ORDER_NOT_FOUND
  );
  assert.equal(ctx.orderRepo.docs[0].status, ORDER_STATUSES.PENDING, 'status untouched by a cross-customer attempt');
});

test('customer cancel is allowed throughout the pre-delivery lifecycle (PROCESSING/SHIPPED)', async () => {
  const ctx = buildContext();
  await seedCart(ctx.cartRepo, [{ productVariantId: V1, productId: P1, quantity: 1 }]);
  const { order } = await doCheckout(ctx);
  const staffId = '507f1f77bcf86cd799439099';

  await ctx.orderService.performTransition({
    orderId: order.id,
    fromStatus: ORDER_STATUSES.PENDING,
    toStatus: ORDER_STATUSES.CONFIRMED,
    performedBy: staffId,
    note: null,
    notAllowedError: ctx.orderService.confirmationNotAllowed(),
  });
  await ctx.orderService.performTransition({
    orderId: order.id,
    fromStatus: ORDER_STATUSES.CONFIRMED,
    toStatus: ORDER_STATUSES.PROCESSING,
    performedBy: staffId,
    note: null,
    notAllowedError: ctx.orderService.processingNotAllowed(),
  });
  await ctx.orderService.performTransition({
    orderId: order.id,
    fromStatus: ORDER_STATUSES.PROCESSING,
    toStatus: ORDER_STATUSES.SHIPPED,
    performedBy: staffId,
    note: null,
    notAllowedError: ctx.orderService.shippingNotAllowed(),
  });

  const cancelled = await ctx.orderService.cancelCustomerOrder({
    customerId: CUSTOMER_ID,
    orderId: order.id,
    performedBy: CUSTOMER_ID,
  });
  assert.equal(cancelled.status, ORDER_STATUSES.CANCELLED);
  assert.equal(ctx.orderRepo.docs[0].status, ORDER_STATUSES.CANCELLED);
});

test('customer order detail and history are strictly customer-scoped', async () => {
  const ctx = buildContext();
  await seedCart(ctx.cartRepo, [{ productVariantId: V1, productId: P1, quantity: 1 }]);
  const { order } = await doCheckout(ctx);

  const detail = await ctx.orderService.getCustomerOrder({ customerId: CUSTOMER_ID, orderId: order.id });
  assert.equal(detail.id, order.id);
  await assert.rejects(
    ctx.orderService.getCustomerOrder({ customerId: OTHER_CUSTOMER_ID, orderId: order.id }),
    (err) => err.statusCode === 404 && err.code === ERROR_CODES.ORDER_NOT_FOUND
  );

  const history = await ctx.orderService.listCustomerOrders({ customerId: CUSTOMER_ID, page: 1, limit: 10 });
  assert.equal(history.orders.length, 1);
  assert.equal(history.pagination.total, 1);
  const empty = await ctx.orderService.listCustomerOrders({ customerId: OTHER_CUSTOMER_ID, page: 1, limit: 10 });
  assert.equal(empty.orders.length, 0, 'history never leaks another customers orders');
});

test('customer detail of an unknown order → 404', async () => {
  const ctx = buildContext();
  await assert.rejects(
    ctx.orderService.getCustomerOrder({ customerId: CUSTOMER_ID, orderId: '507f1f77bcf86cd799439999' }),
    (err) => err.statusCode === 404 && err.code === ERROR_CODES.ORDER_NOT_FOUND
  );
});
