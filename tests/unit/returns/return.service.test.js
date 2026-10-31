'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ReturnService } = require('../../../src/modules/returns/return.service');
const { ERROR_CODES } = require('../../../src/constants');
const {
  RETURN_STATUSES,
  RETURN_LIMITS,
} = require('../../../src/modules/returns/return.constants');
const { ORDER_STATUSES } = require('../../../src/modules/orders/order.constants');
const { createMemoryReturnRepository } = require('../../helpers/return-stubs');

const CUSTOMER = '507f1f77bcf86cd799439711';
const OTHER_CUSTOMER = '507f1f77bcf86cd799439712';
const STAFF = '507f1f77bcf86cd799439713';
const ORDER_ID = '507f1f77bcf86cd799439714';
const OTHER_ORDER_ID = '507f1f77bcf86cd799439715';
const RETURN_ID = '507f1f77bcf86cd799439716';
const ORDER_ITEM_A = '507f1f77bcf86cd799439717';
const ORDER_ITEM_B = '507f1f77bcf86cd799439718';
const PRODUCT_A = '507f1f77bcf86cd799439719';
const PRODUCT_B = '507f1f77bcf86cd799439720';
const VARIANT_A = '507f1f77bcf86cd799439721';
const VARIANT_B = '507f1f77bcf86cd799439722';
const REFUND_ID = '507f1f77bcf86cd799439723';

const S = RETURN_STATUSES;

function makeOrder(overrides = {}) {
  return {
    _id: ORDER_ID,
    customerId: CUSTOMER,
    orderNumber: 'TAQ-20260808-000001',
    status: ORDER_STATUSES.CONFIRMED,
    createdAt: new Date(),
    items: [
      {
        _id: ORDER_ITEM_A,
        productId: PRODUCT_A,
        productVariantId: VARIANT_A,
        productName: 'Thobe',
        sku: 'THB-L',
        quantity: 2,
        unitPriceMinorUnits: 100000,
        discountMinorUnits: 5000,
      },
      {
        _id: ORDER_ITEM_B,
        productId: PRODUCT_B,
        productVariantId: VARIANT_B,
        productName: 'Shalwar',
        sku: 'SHW-M',
        quantity: 1,
        unitPriceMinorUnits: 5000,
        discountMinorUnits: 0,
      },
    ],
    ...overrides,
  };
}

function makeReturn(overrides = {}) {
  return {
    _id: RETURN_ID,
    customerId: CUSTOMER,
    orderId: ORDER_ID,
    returnNumber: 'RET-20260808-000001',
    idempotencyKey: 'key-1',
    idempotencyFingerprint: 'fp-1',
    status: S.PENDING,
    statusHistory: [{ status: S.PENDING, at: new Date(), by: CUSTOMER, note: null }],
    items: [
      {
        _id: '507f1f77bcf86cd799439724',
        orderItemId: ORDER_ITEM_A,
        productId: PRODUCT_A,
        productVariantId: VARIANT_A,
        productName: 'Thobe',
        sku: 'THB-L',
        quantity: 1,
        unitPriceMinorUnits: 100000,
        discountMinorUnits: 5000,
      },
    ],
    reason: 'Wrong size',
    notes: null,
    refundId: null,
    approvedBy: null,
    approvedAt: null,
    rejectedBy: null,
    rejectedAt: null,
    cancelledBy: null,
    cancelledAt: null,
    completedBy: null,
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function requestBody(overrides = {}) {
  return {
    reason: 'Wrong size',
    items: [{ orderItemId: ORDER_ITEM_A, quantity: 1 }],
    notes: null,
    ...overrides,
  };
}

function createHarness({
  orders = [],
  returns = [],
  orderStatus = ORDER_STATUSES.CONFIRMED,
  orderCreatedAt,
} = {}) {
  const returnRepo = createMemoryReturnRepository(returns);
  const orderCalls = [];
  const orderRepository = {
    findOne: async (filter) => {
      orderCalls.push(filter);
      return (
        orders.find((o) =>
          Object.keys(filter).every((key) => String(o[key]) === String(filter[key]))
        ) || null
      );
    },
    findById: async (id, options = {}) => {
      orderCalls.push({ kind: 'findById', id, options });
      return orders.find((o) => String(o._id) === String(id)) || null;
    },
  };
  const restocks = [];
  const refundCalls = [];
  const inventoryService = {
    restockOnlineInTransaction: async (input) => {
      restocks.push(input);
      return { _id: 'inv-1' };
    },
  };
  const refundService = {
    createRefundInTransaction: async (input) => {
      refundCalls.push(input);
      return { _id: REFUND_ID, refundNumber: 'RFD-20260808-000001' };
    },
  };
  let txCount = 0;
  const runTransaction = async (fn) => {
    txCount += 1;
    return fn({ id: 'tx' });
  };
  const service = new ReturnService({
    returnRepository: returnRepo,
    orderRepository,
    refundService,
    inventoryService,
    runTransaction,
  });
  return {
    service,
    returnRepo,
    orderCalls,
    restocks,
    refundCalls,
    txCount: () => txCount,
  };
}

test('constructor requires repositories and an inventory/refund service', () => {
  assert.throws(() => new ReturnService({}), /returnRepository/);
  assert.throws(
    () =>
      new ReturnService({
        returnRepository: { conditionalTransition: async () => {} },
      }),
    /orderRepository/
  );
});

test('createReturn: happy path builds snapshots and a PENDING return (created: true)', async () => {
  const order = makeOrder();
  const { service, orderCalls } = createHarness({ orders: [order] });

  const { return: doc, created } = await service.createReturn({
    customerId: CUSTOMER,
    orderId: ORDER_ID,
    value: requestBody(),
    idempotencyKey: 'key-1',
  });

  assert.equal(created, true);
  assert.equal(doc.status, S.PENDING);
  assert.match(doc.returnNumber, /^RET-\d{8}-\d{6}$/);
  assert.equal(doc.items[0].orderItemId, ORDER_ITEM_A);
  assert.equal(doc.items[0].productName, 'Thobe');
  assert.equal(doc.items[0].unitPriceMinorUnits, 100000);
  assert.equal(doc.items[0].discountMinorUnits, 5000);
  assert.equal(doc.statusHistory[0].by, CUSTOMER);
  assert.deepEqual(orderCalls[0], { _id: ORDER_ID, customerId: CUSTOMER });
});

test('createReturn: same key + same body is an idempotent no-op (created: false)', async () => {
  const order = makeOrder();
  const { service } = createHarness({ orders: [order] });
  const first = await service.createReturn({
    customerId: CUSTOMER,
    orderId: ORDER_ID,
    value: requestBody(),
    idempotencyKey: 'key-1',
  });
  assert.equal(first.created, true);

  const retry = await service.createReturn({
    customerId: CUSTOMER,
    orderId: ORDER_ID,
    value: requestBody(),
    idempotencyKey: 'key-1',
  });
  assert.equal(retry.created, false);
  assert.equal(retry.return.id, first.return.id);
});

test('createReturn: same key + different body -> RETURN_IDEMPOTENCY_CONFLICT', async () => {
  const order = makeOrder();
  const { service } = createHarness({ orders: [order] });
  await service.createReturn({
    customerId: CUSTOMER,
    orderId: ORDER_ID,
    value: requestBody(),
    idempotencyKey: 'key-1',
  });
  await assert.rejects(
    () =>
      service.createReturn({
        customerId: CUSTOMER,
        orderId: ORDER_ID,
        value: requestBody({ reason: 'different reason' }),
        idempotencyKey: 'key-1',
      }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.RETURN_IDEMPOTENCY_CONFLICT
  );
});

test('createReturn: cross-customer order resolves as 404 RETURN_NOT_FOUND', async () => {
  const order = makeOrder();
  const { service } = createHarness({ orders: [order] });
  await assert.rejects(
    () =>
      service.createReturn({
        customerId: OTHER_CUSTOMER,
        orderId: ORDER_ID,
        value: requestBody(),
        idempotencyKey: 'key-1',
      }),
    (err) => err.statusCode === 404 && err.code === ERROR_CODES.RETURN_NOT_FOUND
  );
});

test('createReturn: ineligible order status -> RETURN_NOT_ELIGIBLE', async () => {
  for (const status of [ORDER_STATUSES.PENDING, ORDER_STATUSES.CANCELLED, ORDER_STATUSES.REJECTED]) {
    const order = makeOrder({ status });
    const { service } = createHarness({ orders: [order] });
    await assert.rejects(
      () =>
        service.createReturn({
          customerId: CUSTOMER,
          orderId: ORDER_ID,
          value: requestBody(),
          idempotencyKey: 'key-1',
        }),
      (err) => err.statusCode === 409 && err.code === ERROR_CODES.RETURN_NOT_ELIGIBLE,
      `order ${status} must be ineligible`
    );
  }
});

test('createReturn: window expired -> RETURN_WINDOW_EXPIRED', async () => {
  const days = RETURN_LIMITS.ELIGIBLE_DAYS + 1;
  const createdAt = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const order = makeOrder({ createdAt });
  const { service } = createHarness({ orders: [order] });
  await assert.rejects(
    () =>
      service.createReturn({
        customerId: CUSTOMER,
        orderId: ORDER_ID,
        value: requestBody(),
        idempotencyKey: 'key-1',
      }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.RETURN_WINDOW_EXPIRED
  );
});

test('createReturn: unavailable quantity (already claimed) -> RETURN_QUANTITY_EXCEEDED', async () => {
  const order = makeOrder();
  const prior = makeReturn({
    items: [
      {
        _id: '507f1f77bcf86cd799439725',
        orderItemId: ORDER_ITEM_A,
        productId: PRODUCT_A,
        productVariantId: VARIANT_A,
        productName: 'Thobe',
        sku: 'THB-L',
        quantity: 2,
        unitPriceMinorUnits: 100000,
        discountMinorUnits: 5000,
      },
    ],
  });
  const { service } = createHarness({ orders: [order], returns: [prior] });
  await assert.rejects(
    () =>
      service.createReturn({
        customerId: CUSTOMER,
        orderId: ORDER_ID,
        value: requestBody(),
        idempotencyKey: 'key-2',
      }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.RETURN_QUANTITY_EXCEEDED
  );
});

test('createReturn: item not on the order -> RETURN_ITEM_NOT_FOUND', async () => {
  const order = makeOrder();
  const { service } = createHarness({ orders: [order] });
  await assert.rejects(
    () =>
      service.createReturn({
        customerId: CUSTOMER,
        orderId: ORDER_ID,
        value: requestBody({ items: [{ orderItemId: '507f1f77bcf86cd799439999', quantity: 1 }] }),
        idempotencyKey: 'key-1',
      }),
    (err) => err.statusCode === 404 && err.code === ERROR_CODES.RETURN_ITEM_NOT_FOUND
  );
});

test('getCustomerReturn is customer-scoped: other customer sees 404', async () => {
  const doc = makeReturn();
  const order = makeOrder();
  const { service } = createHarness({ orders: [order], returns: [doc] });
  const mine = await service.getCustomerReturn({ customerId: CUSTOMER, orderId: ORDER_ID, returnId: RETURN_ID });
  assert.equal(mine.id, RETURN_ID);
  await assert.rejects(
    () =>
      service.getCustomerReturn({ customerId: OTHER_CUSTOMER, orderId: ORDER_ID, returnId: RETURN_ID }),
    (err) => err.statusCode === 404 && err.code === ERROR_CODES.RETURN_NOT_FOUND
  );
});

test('cancelCustomerReturn cancels only an own PENDING return; APPROVED needs admin', async () => {
  const pending = makeReturn();
  const order = makeOrder();
  const { service } = createHarness({ orders: [order], returns: [pending] });

  const cancelled = await service.cancelCustomerReturn({
    customerId: CUSTOMER,
    orderId: ORDER_ID,
    returnId: RETURN_ID,
    performedBy: CUSTOMER,
  });
  assert.equal(cancelled.status, S.CANCELLED);
  assert.ok(cancelled.cancelledAt, 'cancel time is recorded (customer view keeps the audit timestamp)');

  const again = await service.cancelCustomerReturn({
    customerId: CUSTOMER,
    orderId: ORDER_ID,
    returnId: RETURN_ID,
    performedBy: CUSTOMER,
  });
  assert.equal(again.status, S.CANCELLED, 'idempotent when already cancelled');

  const approved = makeReturn({ _id: '507f1f77bcf86cd799439726', status: S.APPROVED, idempotencyKey: 'key-9' });
  const harness2 = createHarness({ orders: [makeOrder()], returns: [approved] });
  await assert.rejects(
    () =>
      harness2.service.cancelCustomerReturn({
        customerId: CUSTOMER,
        orderId: ORDER_ID,
        returnId: approved._id,
        performedBy: CUSTOMER,
      }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.RETURN_INVALID_STATE
  );
});

test('approveReturn: PENDING -> APPROVED with actor; idempotent when already approved/completed', async () => {
  const doc = makeReturn();
  const { service, returnRepo } = createHarness({ returns: [doc] });
  const approved = await service.approveReturn({ returnId: RETURN_ID, performedBy: STAFF, note: 'ok' });
  assert.equal(approved.status, S.APPROVED);
  assert.equal(approved.approvedBy, STAFF);
  assert.ok(approved.approvedAt);
  assert.equal(approved.statusHistory[1].status, S.APPROVED);

  const again = await service.approveReturn({ returnId: RETURN_ID, performedBy: STAFF });
  assert.equal(again.status, S.APPROVED);
  assert.equal(returnRepo.docs[0].statusHistory.length, 2, 'no duplicate history entry');

  const rejected = makeReturn({ _id: '507f1f77bcf86cd799439727', status: S.REJECTED, idempotencyKey: 'key-10' });
  const harness2 = createHarness({ returns: [rejected] });
  await assert.rejects(
    () => harness2.service.approveReturn({ returnId: rejected._id, performedBy: STAFF }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.RETURN_INVALID_STATE
  );
});

test('rejectReturn: PENDING -> REJECTED and is terminal', async () => {
  const doc = makeReturn();
  const { service } = createHarness({ returns: [doc] });
  const rejected = await service.rejectReturn({ returnId: RETURN_ID, performedBy: STAFF });
  assert.equal(rejected.status, S.REJECTED);
  assert.equal(rejected.rejectedBy, STAFF);

  const approved = makeReturn({ _id: '507f1f77bcf86cd799439728', status: S.APPROVED, idempotencyKey: 'key-11' });
  const harness2 = createHarness({ returns: [approved] });
  await assert.rejects(
    () => harness2.service.rejectReturn({ returnId: approved._id, performedBy: STAFF }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.RETURN_INVALID_STATE
  );
});

test('completeReturn: one transaction restocks + creates refund + sets refundId', async () => {
  const order = makeOrder();
  const doc = makeReturn({
    status: S.APPROVED,
    approvedBy: STAFF,
    approvedAt: new Date(),
  });
  const { service, restocks, refundCalls, txCount, returnRepo } = createHarness({
    orders: [order],
    returns: [doc],
  });

  const completed = await service.completeReturn({ returnId: RETURN_ID, performedBy: STAFF, note: 'stock back' });

  assert.equal(txCount(), 1, 'restock + refund + transition commit together');
  assert.equal(completed.status, S.COMPLETED);
  assert.equal(completed.completedBy, STAFF);
  assert.ok(completed.completedAt, 'completedAt is recorded');
  assert.equal(completed.refundId, REFUND_ID);
  assert.equal(completed.statusHistory[1].status, S.COMPLETED);
  assert.equal(completed.statusHistory[1].note, 'stock back');

  assert.equal(restocks.length, 1, 'one restock per returned item');
  assert.deepEqual(restocks[0], {
    productId: PRODUCT_A,
    productVariantId: VARIANT_A,
    quantity: 1,
    reason: 'return-completed',
    referenceType: 'RETURN',
    referenceId: RETURN_ID,
    performedBy: STAFF,
    session: { id: 'tx' },
  });

  assert.equal(refundCalls.length, 1);
  assert.equal(refundCalls[0].return._id, RETURN_ID);
  assert.equal(refundCalls[0].order._id, ORDER_ID);
  assert.equal(refundCalls[0].performedBy, STAFF);
  assert.deepEqual(refundCalls[0].session, { id: 'tx' });

  assert.equal(returnRepo.docs[0].refundId, REFUND_ID);
});

test('completeReturn: simple-product item (null variant, no SKU) restocks by product', async () => {
  const order = makeOrder();
  const doc = makeReturn({
    status: S.APPROVED,
    approvedBy: STAFF,
    approvedAt: new Date(),
    items: [
      {
        _id: '507f1f77bcf86cd799439725',
        orderItemId: ORDER_ITEM_A,
        productId: PRODUCT_A,
        productVariantId: null,
        productName: 'Thobe',
        sku: null,
        quantity: 2,
        unitPriceMinorUnits: 100000,
        discountMinorUnits: 0,
      },
    ],
  });
  const { service, restocks } = createHarness({ orders: [order], returns: [doc] });

  const completed = await service.completeReturn({ returnId: RETURN_ID, performedBy: STAFF });

  assert.equal(completed.status, S.COMPLETED);
  assert.equal(completed.items[0].productId, PRODUCT_A);
  assert.equal(completed.items[0].productVariantId, null);
  assert.equal(completed.items[0].sku, null, 'an absent SKU serializes as null');
  assert.equal(restocks.length, 1, 'one restock per returned item');
  assert.deepEqual(restocks[0], {
    productId: PRODUCT_A,
    productVariantId: null,
    quantity: 2,
    reason: 'return-completed',
    referenceType: 'RETURN',
    referenceId: RETURN_ID,
    performedBy: STAFF,
    session: { id: 'tx' },
  });
});

test('completeReturn: idempotent when already COMPLETED (no double restock)', async () => {
  const order = makeOrder();
  const doc = makeReturn({ status: S.COMPLETED, completedBy: STAFF, completedAt: new Date(), refundId: REFUND_ID });
  const { service, restocks, txCount } = createHarness({ orders: [order], returns: [doc] });

  const out = await service.completeReturn({ returnId: RETURN_ID, performedBy: STAFF });
  assert.equal(out.status, S.COMPLETED);
  assert.equal(restocks.length, 0, 'no restock on a repeated complete');
  assert.equal(txCount(), 0, 'no transaction on a repeated complete');
});

test('completeReturn: only APPROVED may complete; PENDING -> RETURN_INVALID_STATE', async () => {
  const doc = makeReturn();
  const { service } = createHarness({ returns: [doc] });
  await assert.rejects(
    () => service.completeReturn({ returnId: RETURN_ID, performedBy: STAFF }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.RETURN_INVALID_STATE
  );
});

test('completeReturn: missing return -> 404 RETURN_NOT_FOUND', async () => {
  const { service } = createHarness();
  await assert.rejects(
    () => service.completeReturn({ returnId: '507f1f77bcf86cd799439999', performedBy: STAFF }),
    (err) => err.statusCode === 404 && err.code === ERROR_CODES.RETURN_NOT_FOUND
  );
});

test('cancelReturn (admin): PENDING or APPROVED -> CANCELLED; COMPLETED is terminal', async () => {
  const pending = makeReturn();
  const { service } = createHarness({ returns: [pending] });
  const cancelled = await service.cancelReturn({ returnId: RETURN_ID, performedBy: STAFF });
  assert.equal(cancelled.status, S.CANCELLED);

  const completed = makeReturn({ _id: '507f1f77bcf86cd799439729', status: S.COMPLETED, idempotencyKey: 'key-12' });
  const harness2 = createHarness({ returns: [completed] });
  await assert.rejects(
    () => harness2.service.cancelReturn({ returnId: completed._id, performedBy: STAFF }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.RETURN_INVALID_STATE
  );
});

test('listReturns resolves orderNumber and returns empty when the order is unknown', async () => {
  const order = makeOrder();
  const doc = makeReturn();
  const { service } = createHarness({ orders: [order], returns: [doc] });

  const byNumber = await service.listReturns({ orderNumber: 'TAQ-20260808-000001', page: 1, limit: 10 });
  assert.equal(byNumber.returns.length, 1);
  assert.equal(byNumber.returns[0].customerId, CUSTOMER, 'admin view exposes customer id');

  const unknown = await service.listReturns({ orderNumber: 'TAQ-NOPE' });
  assert.equal(unknown.returns.length, 0);
  assert.equal(unknown.pagination.total, 0);
});

test('listCustomerReturns is scoped to the customer + order', async () => {
  const order = makeOrder();
  const doc = makeReturn();
  const { service } = createHarness({ orders: [order], returns: [doc] });
  const mine = await service.listCustomerReturns({ customerId: CUSTOMER, orderId: ORDER_ID });
  assert.equal(mine.returns.length, 1);
  assert.equal(mine.returns[0].customerId, undefined, 'customer view hides the customer id');
});
