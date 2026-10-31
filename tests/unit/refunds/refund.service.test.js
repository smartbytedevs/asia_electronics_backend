'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { RefundService } = require('../../../src/modules/refunds/refund.service');
const { ERROR_CODES } = require('../../../src/constants');
const { REFUND_STATUSES, REFUND_LIMITS } = require('../../../src/modules/refunds/refund.constants');
const { PAYMENT_STATUSES } = require('../../../src/modules/payments/payment.constants');
const { PAYMENT_METHODS } = require('../../../src/modules/orders/order.constants');
const { createMemoryRefundRepository } = require('../../helpers/refund-stubs');
const { duplicateKeyError } = require('../../helpers/payment-stubs');

const CUSTOMER = '507f1f77bcf86cd799439611';
const STAFF = '507f1f77bcf86cd799439612';
const ORDER_ID = '507f1f77bcf86cd799439613';
const RETURN_ID = '507f1f77bcf86cd799439614';
const PAYMENT_ID = '507f1f77bcf86cd799439615';

const S = REFUND_STATUSES;

function makeOrder(overrides = {}) {
  return {
    _id: ORDER_ID,
    customerId: CUSTOMER,
    paymentMethod: PAYMENT_METHODS.COD,
    ...overrides,
  };
}

function makeReturn(items = []) {
  return {
    _id: RETURN_ID,
    items,
  };
}

function makeRefund(overrides = {}) {
  return {
    _id: '507f1f77bcf86cd799439620',
    refundNumber: 'RFD-20260808-000001',
    return: RETURN_ID,
    order: ORDER_ID,
    customer: CUSTOMER,
    paymentMethod: PAYMENT_METHODS.COD,
    paymentId: null,
    amount: 95000,
    status: S.PENDING,
    note: '',
    processedBy: null,
    processedAt: null,
    voidedBy: null,
    voidedAt: null,
    statusHistory: [{ status: S.PENDING, at: new Date(), by: CUSTOMER, note: '' }],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createHarness({ refunds = [], payments = [], fail = null } = {}) {
  const refundRepo = createMemoryRefundRepository(refunds);
  const paymentCalls = [];
  const paymentRepository = {
    findOne: async (filter) => {
      paymentCalls.push(filter);
      return payments.find(
        (p) =>
          String(p.orderId) === String(filter.orderId) &&
          p.status === filter.status
      ) || null;
    },
  };
  const service = new RefundService({
    refundRepository: refundRepo,
    paymentRepository,
    runTransaction: async (fn) => fn({}),
  });
  if (fail) {
    refundRepo.create = async () => {
      throw fail;
    };
  }
  return { service, refundRepo, paymentCalls };
}

test('constructor requires a refund repository and a payment repository', () => {
  assert.throws(() => new RefundService({}), /refundRepository/);
  assert.throws(
    () => new RefundService({ refundRepository: { create: async () => {} } }),
    /paymentRepository/
  );
});

test('generateRefundNumber emits the RFD-YYYYMMDD-XXXXXX format', () => {
  const { service } = createHarness();
  const n = service.generateRefundNumber(new Date('2026-08-08T10:00:00Z'));
  assert.match(n, new RegExp(`^${REFUND_LIMITS.REFUND_NUMBER_PREFIX}\\d{8}-\\d{6}$`));
  assert.ok(n.startsWith('RFD-20260808-'), 'includes the yyyymmdd date portion');
});

test('computeRefundAmount sums (unitPrice - discount) x quantity, never fees', () => {
  const { service } = createHarness();
  const items = [
    { unitPriceMinorUnits: 100000, discountMinorUnits: 5000, quantity: 2 },
    { unitPriceMinorUnits: 5000, discountMinorUnits: 0, quantity: 1 },
  ];
  assert.equal(service.computeRefundAmount(items), 195000);
  assert.equal(service.computeRefundAmount([]), 0);
});

test('createRefundInTransaction: COD order -> informational refund with paymentId null', async () => {
  const { service, refundRepo } = createHarness();
  const refund = await service.createRefundInTransaction({
    return: makeReturn([
      { unitPriceMinorUnits: 100000, discountMinorUnits: 5000, quantity: 1 },
    ]),
    order: makeOrder(),
    performedBy: STAFF,
    session: { id: 's1' },
  });
  assert.equal(refund.paymentMethod, PAYMENT_METHODS.COD);
  assert.equal(refund.paymentId, null);
  assert.equal(refund.amount, 95000);
  assert.equal(refund.status, S.PENDING);
  assert.equal(refund.return, RETURN_ID);
  assert.equal(refund.order, ORDER_ID);
  assert.equal(refund.customer, CUSTOMER);
  assert.equal(refund.statusHistory[0].by, STAFF);
});

test('createRefundInTransaction: MANUAL order links the verified payment', async () => {
  const verified = { _id: PAYMENT_ID, orderId: ORDER_ID, status: PAYMENT_STATUSES.VERIFIED };
  const { service, refundRepo, paymentCalls } = createHarness({
    payments: [verified],
  });
  const refund = await service.createRefundInTransaction({
    return: makeReturn([{ unitPriceMinorUnits: 100000, discountMinorUnits: 0, quantity: 1 }]),
    order: makeOrder({ paymentMethod: PAYMENT_METHODS.MANUAL }),
    performedBy: STAFF,
    session: { id: 's1' },
  });
  assert.equal(refund.paymentMethod, PAYMENT_METHODS.MANUAL);
  assert.equal(refund.paymentId, PAYMENT_ID);
  assert.deepEqual(paymentCalls[0], {
    orderId: ORDER_ID,
    status: PAYMENT_STATUSES.VERIFIED,
  });
});

test('createRefundInTransaction: BKASH/BANK_TRANSFER orders are manual and link the verified payment', async () => {
  for (const method of [PAYMENT_METHODS.BKASH, PAYMENT_METHODS.BANK_TRANSFER]) {
    const verified = { _id: PAYMENT_ID, orderId: ORDER_ID, status: PAYMENT_STATUSES.VERIFIED };
    const { service } = createHarness({ payments: [verified] });
    const refund = await service.createRefundInTransaction({
      return: makeReturn([{ unitPriceMinorUnits: 100000, discountMinorUnits: 0, quantity: 1 }]),
      order: makeOrder({ paymentMethod: method }),
      performedBy: STAFF,
      session: { id: 's1' },
    });
    assert.equal(refund.paymentMethod, PAYMENT_METHODS.MANUAL, `${method}: refund is manual, not COD`);
    assert.equal(refund.paymentId, PAYMENT_ID, `${method}: verified payment is linked`);
  }
});

test('createRefundInTransaction: MANUAL order without a verified payment keeps paymentId null', async () => {
  const { service } = createHarness();
  const refund = await service.createRefundInTransaction({
    return: makeReturn([{ unitPriceMinorUnits: 1000, discountMinorUnits: 0, quantity: 1 }]),
    order: makeOrder({ paymentMethod: PAYMENT_METHODS.MANUAL }),
    performedBy: STAFF,
    session: { id: 's1' },
  });
  assert.equal(refund.paymentId, null);
});

test('refund-number collision retries until a unique number succeeds', async () => {
  const { service, refundRepo } = createHarness();
  const originalCreate = refundRepo.create;
  let attempts = 0;
  refundRepo.create = async (data) => {
    attempts += 1;
    if (attempts === 1) {
      throw duplicateKeyError({ refundNumber: 1 });
    }
    return originalCreate(data);
  };
  const created = await service.createRefundWithRetry({
    data: {
      refundNumber: null,
      return: RETURN_ID,
      order: ORDER_ID,
      customer: CUSTOMER,
      paymentMethod: PAYMENT_METHODS.COD,
      amount: 100,
      status: S.PENDING,
      statusHistory: [],
    },
  });
  assert.equal(attempts, 2);
  assert.ok(created.refundNumber && created.refundNumber !== null);
});

test('refund-number collisions beyond the retry budget raise REFUND_NUMBER_GENERATION_FAILED', async () => {
  const { service, refundRepo } = createHarness();
  refundRepo.create = async () => {
    throw duplicateKeyError({ refundNumber: 1 });
  };
  await assert.rejects(
    () => service.createRefundWithRetry({ data: { refundNumber: null } }),
    (err) => err.statusCode === 500 && err.code === ERROR_CODES.REFUND_NUMBER_GENERATION_FAILED
  );
});

test('a non-duplicate-key error propagates unchanged (no silent retry)', async () => {
  const { service } = createHarness();
  const refundRepo = { create: async () => { throw new Error('db down'); } };
  const svc = new RefundService({
    refundRepository: refundRepo,
    paymentRepository: { findOne: async () => null },
  });
  await assert.rejects(() => svc.createRefundWithRetry({ data: { refundNumber: null } }), /db down/);
});

test('listRefunds applies OPT-IN filters, paginates, and serializes', async () => {
  const pending = makeRefund({ refundNumber: 'RFD-20260808-000001', status: S.PENDING, amount: 100 });
  const processed = makeRefund({
    _id: '507f1f77bcf86cd799439621',
    refundNumber: 'RFD-20260808-000002',
    status: S.PROCESSED,
    amount: 200,
    processedBy: STAFF,
    processedAt: new Date('2026-08-03T10:00:00Z'),
  });
  const { service } = createHarness({ refunds: [pending, processed] });

  const all = await service.listRefunds({ page: 1, limit: 10 });
  assert.equal(all.pagination.total, 2);

  const filtered = await service.listRefunds({ status: S.PROCESSED, page: 1, limit: 10 });
  assert.equal(filtered.refunds.length, 1);
  assert.equal(filtered.refunds[0].status, S.PROCESSED);
  assert.equal(filtered.refunds[0].amount, 200);
  assert.equal(filtered.pagination.total, 1);
  assert.equal(filtered.refunds[0].processedAt, '2026-08-03T10:00:00.000Z');
});

test('listRefunds: dateFrom returns only refunds created on/after that date', async () => {
  const early = makeRefund({
    _id: '507f1f77bcf86cd799439622',
    refundNumber: 'RFD-20260808-000011',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
  });
  const late = makeRefund({
    _id: '507f1f77bcf86cd799439623',
    refundNumber: 'RFD-20260808-000012',
    createdAt: new Date('2026-08-09T00:00:00.000Z'),
  });
  const { service } = createHarness({ refunds: [early, late] });

  const out = await service.listRefunds({ dateFrom: new Date('2026-08-05T00:00:00.000Z'), page: 1, limit: 10 });
  assert.equal(out.pagination.total, 1);
  assert.equal(out.refunds[0].refundNumber, 'RFD-20260808-000012');
});

test('listRefunds: dateTo returns only refunds created on/before that date', async () => {
  const early = makeRefund({
    _id: '507f1f77bcf86cd799439624',
    refundNumber: 'RFD-20260808-000021',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
  });
  const late = makeRefund({
    _id: '507f1f77bcf86cd799439625',
    refundNumber: 'RFD-20260808-000022',
    createdAt: new Date('2026-08-09T00:00:00.000Z'),
  });
  const { service } = createHarness({ refunds: [early, late] });

  const out = await service.listRefunds({ dateTo: new Date('2026-08-05T00:00:00.000Z'), page: 1, limit: 10 });
  assert.equal(out.pagination.total, 1);
  assert.equal(out.refunds[0].refundNumber, 'RFD-20260808-000021');
});

test('listRefunds: dateFrom + dateTo returns only refunds within the window', async () => {
  const before = makeRefund({
    _id: '507f1f77bcf86cd799439626',
    refundNumber: 'RFD-20260808-000031',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
  });
  const inside = makeRefund({
    _id: '507f1f77bcf86cd799439627',
    refundNumber: 'RFD-20260808-000032',
    createdAt: new Date('2026-08-06T00:00:00.000Z'),
  });
  const after = makeRefund({
    _id: '507f1f77bcf86cd799439628',
    refundNumber: 'RFD-20260808-000033',
    createdAt: new Date('2026-08-12T00:00:00.000Z'),
  });
  const { service } = createHarness({ refunds: [before, inside, after] });

  const out = await service.listRefunds({
    dateFrom: new Date('2026-08-05T00:00:00.000Z'),
    dateTo: new Date('2026-08-10T00:00:00.000Z'),
    page: 1,
    limit: 10,
  });
  assert.equal(out.pagination.total, 1);
  assert.equal(out.refunds[0].refundNumber, 'RFD-20260808-000032');
});

test('listRefunds: omitting date filters preserves existing behavior (returns everything)', async () => {
  const one = makeRefund({ _id: '507f1f77bcf86cd799439629', refundNumber: 'RFD-20260808-000041' });
  const two = makeRefund({
    _id: '507f1f77bcf86cd799439630',
    refundNumber: 'RFD-20260808-000042',
    createdAt: new Date('2026-08-09T00:00:00.000Z'),
  });
  const { service } = createHarness({ refunds: [one, two] });

  const out = await service.listRefunds({ page: 1, limit: 10 });
  assert.equal(out.pagination.total, 2);
});

test('getRefund returns the serialized refund or 404 REFUND_NOT_FOUND', async () => {
  const doc = makeRefund();
  const { service } = createHarness({ refunds: [doc] });
  const out = await service.getRefund(doc._id);
  assert.equal(out.refundNumber, 'RFD-20260808-000001');
  await assert.rejects(
    () => service.getRefund('507f1f77bcf86cd799439999'),
    (err) => err.statusCode === 404 && err.code === ERROR_CODES.REFUND_NOT_FOUND
  );
});

test('processRefund: PENDING -> PROCESSED, records the actor and is idempotent', async () => {
  const doc = makeRefund();
  const { service, refundRepo } = createHarness({ refunds: [doc] });
  const id = doc._id;

  const processed = await service.processRefund({ refundId: id, performedBy: STAFF, note: 'paid' });
  assert.equal(processed.status, S.PROCESSED);
  assert.deepEqual(processed.processedBy, { id: STAFF });
  assert.ok(processed.processedAt);
  assert.equal(processed.statusHistory[1].status, S.PROCESSED);
  assert.deepEqual(processed.statusHistory[1].by, { id: STAFF });
  assert.equal(processed.statusHistory[1].note, 'paid');

  const again = await service.processRefund({ refundId: id, performedBy: STAFF });
  assert.equal(again.status, S.PROCESSED);
  assert.equal(refundRepo.docs[0].statusHistory.length, 2, 'no duplicate history entry');
});

test('processRefund on a VOIDED refund -> REFUND_INVALID_STATE', async () => {
  const doc = makeRefund({ status: S.VOIDED });
  const { service } = createHarness({ refunds: [doc] });
  await assert.rejects(
    () => service.processRefund({ refundId: doc._id, performedBy: STAFF }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.REFUND_INVALID_STATE
  );
});

test('processRefund on a missing refund -> 404 REFUND_NOT_FOUND', async () => {
  const { service } = createHarness();
  await assert.rejects(
    () => service.processRefund({ refundId: '507f1f77bcf86cd799439999', performedBy: STAFF }),
    (err) => err.statusCode === 404 && err.code === ERROR_CODES.REFUND_NOT_FOUND
  );
});

test('processRefund on a lost race (conditional transition returns null) -> REFUND_INVALID_STATE', async () => {
  const doc = makeRefund();
  const { service, refundRepo } = createHarness({ refunds: [doc] });
  refundRepo.conditionalTransition = async () => null;
  await assert.rejects(
    () => service.processRefund({ refundId: doc._id, performedBy: STAFF }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.REFUND_INVALID_STATE
  );
});

test('voidRefund: PENDING -> VOIDED, idempotent when already VOIDED, terminal vs PROCESSED', async () => {
  const doc = makeRefund();
  const { service, refundRepo } = createHarness({ refunds: [doc] });
  const id = doc._id;

  const voided = await service.voidRefund({ refundId: id, performedBy: STAFF, note: 'wrong amount' });
  assert.equal(voided.status, S.VOIDED);
  assert.deepEqual(voided.voidedBy, { id: STAFF });
  assert.ok(voided.voidedAt);
  assert.equal(voided.statusHistory[1].note, 'wrong amount');

  const again = await service.voidRefund({ refundId: id, performedBy: STAFF });
  assert.equal(again.status, S.VOIDED);
  assert.equal(refundRepo.docs[0].statusHistory.length, 2, 'idempotent: no extra history');

  await assert.rejects(
    () => service.processRefund({ refundId: id, performedBy: STAFF }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.REFUND_INVALID_STATE,
    'a VOIDED refund can never be PROCESSED'
  );
});
