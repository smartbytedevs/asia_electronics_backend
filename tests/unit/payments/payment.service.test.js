'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { PaymentService } = require('../../../src/modules/payments/payment.service');
const { ERROR_CODES } = require('../../../src/constants');
const { PAYMENT_STATUSES } = require('../../../src/modules/payments/payment.constants');
const { ORDER_STATUSES } = require('../../../src/modules/orders/order.constants');
const {
  createMemoryPaymentRepository,
  createMemoryPaymentMethodRepository,
  duplicateKeyError,
} = require('../../helpers/payment-stubs');

const CUSTOMER = '507f1f77bcf86cd799439111';
const OTHER_CUSTOMER = '507f1f77bcf86cd799439112';
const STAFF = '507f1f77bcf86cd799439113';
const ORDER_ID = '507f1f77bcf86cd799439201';
const OTHER_ORDER_ID = '507f1f77bcf86cd799439202';
const METHOD_ID = '507f1f77bcf86cd799439301';
const OTHER_METHOD_ID = '507f1f77bcf86cd799439302';

function makeOrder(overrides = {}) {
  return {
    _id: ORDER_ID,
    customerId: CUSTOMER,
    orderNumber: 'TAQ-20260808-000001',
    status: ORDER_STATUSES.PENDING,
    paymentMethod: 'MANUAL',
    totals: { grandTotalMinorUnits: 248000 },
    ...overrides,
  };
}

function makeMethod(overrides = {}) {
  return {
    _id: METHOD_ID,
    code: 'BANK_TRANSFER',
    displayName: 'Bank Transfer',
    type: 'MANUAL',
    isActive: true,
    metadata: {
      accountName: 'Taqwa Trading',
      accountNumber: '0123456789',
      instructions: 'Reference: order number',
    },
    ...overrides,
  };
}

function submission(overrides = {}) {
  return {
    customerId: CUSTOMER,
    orderId: ORDER_ID,
    idempotencyKey: 'key-1',
    value: {
      paymentMethodId: METHOD_ID,
      submittedAmountMinorUnits: 248000,
      transactionReference: 'REF-1',
      notes: null,
    },
    proof: { fieldName: 'proof', originalName: 'receipt.png', contentType: 'image/png', buffer: Buffer.from('png') },
    ...overrides,
  };
}

/**
 * Captures every maybeNotify call so tests can assert the Phase 11
 * notification wiring without a real NotificationService.
 */
function createCapturingNotificationService(events = []) {
  return {
    events,
    async notify({ userId, eventType, data }) {
      events.push({ userId, eventType, data });
      return { _id: `n-${events.length}` };
    },
  };
}

function createHarness({ orders = [], paymentMethods = [], payments = [], failUploads = false, notifications = [] } = {}) {
  const uploads = [];
  const deleted = [];
  const orderCalls = [];
  const paymentRepo = createMemoryPaymentRepository(payments);
  const paymentMethodRepo = createMemoryPaymentMethodRepository(paymentMethods);
  const orderRepository = {
    findOne: async (filter) => {
      orderCalls.push(filter);
      return (
        orders.find((o) =>
          Object.keys(filter).every((key) => String(o[key]) === String(filter[key]))
        ) || null
      );
    },
  };
  const mediaService = {
    uploadFile: async (input) => {
      if (failUploads) throw new Error('upload boom');
      uploads.push(input);
      return {
        provider: 'mock',
        publicId: `payments/mock-${uploads.length}`,
        secureUrl: `https://mock.local/${uploads.length}`,
        resourceType: 'image',
        format: 'png',
      };
    },
    deleteFile: async (media) => {
      if (media) deleted.push(media.publicId);
    },
  };
  const service = new PaymentService({
    paymentRepository: paymentRepo,
    paymentMethodRepository: paymentMethodRepo,
    orderRepository,
    mediaService,
    notificationService: createCapturingNotificationService(notifications),
    runTransaction: async (fn) => fn({}),
  });
  return { service, paymentRepo, paymentMethodRepo, orderCalls, uploads, deleted, notifications };
}

test('constructor requires a conforming media service and repositories', () => {
  assert.throws(
    () => new PaymentService({ paymentRepository: {}, paymentMethodRepository: {}, orderRepository: {}, mediaService: {}, runTransaction: async () => {} }),
    /paymentRepository/
  );
  const goodRepos = {
    paymentRepository: { conditionalTransition: async () => {} },
    paymentMethodRepository: { findById: async () => {} },
    orderRepository: { findOne: async () => {} },
  };
  assert.throws(
    () => new PaymentService({ ...goodRepos, mediaService: {}, runTransaction: async () => {} }),
    /media service/
  );
});

test('happy path: creates a SUBMITTED payment with safe proof and does not mutate the order', async () => {
  const order = makeOrder();
  const { service, paymentRepo, uploads, orderCalls } = createHarness({
    orders: [order],
    paymentMethods: [makeMethod()],
  });
  const orderSnapshot = { status: order.status, paymentMethod: order.paymentMethod, totals: order.totals };

  const { payment, created } = await service.submitPayment(submission());

  assert.equal(created, true);
  assert.equal(payment.status, PAYMENT_STATUSES.SUBMITTED);
  assert.equal(payment.orderId, ORDER_ID);
  assert.equal(payment.customerId, CUSTOMER);
  assert.equal(payment.expectedAmountMinorUnits, 248000);
  assert.equal(payment.submittedAmountMinorUnits, 248000);
  assert.equal(payment.transactionReference, 'REF-1');
  assert.equal(payment.paymentMethod.code, 'BANK_TRANSFER');
  assert.equal(payment.paymentMethod.accountNumber, '0123456789');
  assert.equal(payment.proof.provider, 'mock');
  assert.match(payment.proof.publicId, /^payments\/mock-/);
  assert.equal(payment.statusHistory.length, 1);
  assert.equal(payment.statusHistory[0].status, PAYMENT_STATUSES.SUBMITTED);
  assert.equal(payment.statusHistory[0].by, CUSTOMER);
  assert.equal(typeof payment.verifiedBy, 'undefined', 'customer view hides reviewer ids');
  assert.equal(typeof payment.rejectedBy, 'undefined', 'customer view hides reviewer ids');

  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].mimeType, 'image/png');
  assert.equal(uploads[0].originalName, 'receipt.png');

  const persisted = paymentRepo.docs[0];
  assert.equal(persisted.status, PAYMENT_STATUSES.SUBMITTED);
  assert.equal(order.status, orderSnapshot.status, 'order status unchanged');
  assert.equal(order.paymentMethod, orderSnapshot.paymentMethod, 'order payment method unchanged');
  assert.deepEqual(order.totals, orderSnapshot.totals, 'order totals unchanged');
  assert.ok(orderCalls.every((f) => f._id === ORDER_ID && f.customerId === CUSTOMER));
});

test('exact amount enforced: mismatch → INVALID_PAYMENT_AMOUNT and no upload', async () => {
  const { service, uploads } = createHarness({ orders: [makeOrder()], paymentMethods: [makeMethod()] });
  await assert.rejects(
    () => service.submitPayment(submission({ value: { ...submission().value, submittedAmountMinorUnits: 248001 } })),
    (err) => err.statusCode === 400 && err.code === ERROR_CODES.INVALID_PAYMENT_AMOUNT
  );
  assert.equal(uploads.length, 0);
});

test('order not eligible when COD, cancelled, rejected, or past confirmation', async () => {
  for (const [label, order] of [
    ['COD', makeOrder({ paymentMethod: 'COD' })],
    ['CANCELLED', makeOrder({ status: ORDER_STATUSES.CANCELLED })],
    ['REJECTED', makeOrder({ status: ORDER_STATUSES.REJECTED })],
    ['PROCESSING', makeOrder({ status: ORDER_STATUSES.PROCESSING })],
  ]) {
    const { service, uploads } = createHarness({ orders: [order], paymentMethods: [makeMethod()] });
    await assert.rejects(
      () => service.submitPayment(submission()),
      (err) => err.statusCode === 409 && err.code === ERROR_CODES.PAYMENT_ORDER_NOT_ELIGIBLE,
      `${label} order must be rejected`
    );
    assert.equal(uploads.length, 0, `${label}: no upload should happen`);
  }
});

test('CONFIRMED orders are eligible for manual payment', async () => {
  const { service } = createHarness({ orders: [makeOrder({ status: ORDER_STATUSES.CONFIRMED })], paymentMethods: [makeMethod()] });
  const { created } = await service.submitPayment(submission());
  assert.equal(created, true);
});

test('BKASH and BANK_TRANSFER orders are eligible for manual payment; CARD is not', async () => {
  for (const method of ['BKASH', 'BANK_TRANSFER']) {
    const { service } = createHarness({
      orders: [makeOrder({ paymentMethod: method })],
      paymentMethods: [makeMethod()],
    });
    const { created } = await service.submitPayment(submission());
    assert.equal(created, true, `${method} order must be eligible`);
  }

  const card = createHarness({
    orders: [makeOrder({ paymentMethod: 'CARD' })],
    paymentMethods: [makeMethod()],
  });
  await assert.rejects(
    () => card.service.submitPayment(submission()),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.PAYMENT_ORDER_NOT_ELIGIBLE
  );
  assert.equal(card.uploads.length, 0, 'CARD: no upload should happen');
});

test('a CARD-typed payment method cannot receive a manual proof', async () => {
  const { service, uploads } = createHarness({
    orders: [makeOrder()],
    paymentMethods: [makeMethod({ type: 'CARD' })],
  });
  await assert.rejects(
    () => service.submitPayment(submission()),
    (err) => err.statusCode === 400 && err.code === ERROR_CODES.PAYMENT_METHOD_NOT_MANUAL
  );
  assert.equal(uploads.length, 0);
});

test('cross-customer order lookup resolves as 404 PAYMENT_NOT_FOUND (IDOR-safe)', async () => {
  const { service } = createHarness({ orders: [makeOrder()], paymentMethods: [makeMethod()] });
  await assert.rejects(
    () => service.submitPayment(submission({ customerId: OTHER_CUSTOMER })),
    (err) => err.statusCode === 404 && err.code === ERROR_CODES.PAYMENT_NOT_FOUND
  );
});

test('missing or inactive payment method is rejected before any upload', async () => {
  const missing = createHarness({ orders: [makeOrder()] });
  await assert.rejects(
    () => missing.service.submitPayment(submission()),
    (err) => err.statusCode === 404 && err.code === ERROR_CODES.PAYMENT_METHOD_NOT_FOUND
  );
  assert.equal(missing.uploads.length, 0);

  const inactive = createHarness({ orders: [makeOrder()], paymentMethods: [makeMethod({ isActive: false })] });
  await assert.rejects(
    () => inactive.service.submitPayment(submission()),
    (err) => err.statusCode === 400 && err.code === ERROR_CODES.PAYMENT_METHOD_INACTIVE
  );
  assert.equal(inactive.uploads.length, 0);
});

test('idempotent retry (same key + same body) returns the existing SUBMITTED payment without re-uploading', async () => {
  const { service, uploads } = createHarness({ orders: [makeOrder()], paymentMethods: [makeMethod()] });
  const first = await service.submitPayment(submission());
  assert.equal(first.created, true);

  const retry = await service.submitPayment(submission());
  assert.equal(retry.created, false);
  assert.equal(retry.payment.id, first.payment.id);
  assert.equal(retry.payment.status, PAYMENT_STATUSES.SUBMITTED);
  assert.equal(uploads.length, 1, 'no second upload on retry');
});

test('same key + different body while SUBMITTED → PAYMENT_ALREADY_SUBMITTED', async () => {
  const { service, uploads } = createHarness({ orders: [makeOrder()], paymentMethods: [makeMethod()] });
  await service.submitPayment(submission());
  await assert.rejects(
    () => service.submitPayment(submission({ value: { ...submission().value, notes: 'different' } })),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.PAYMENT_ALREADY_SUBMITTED
  );
  assert.equal(uploads.length, 1);
});

test('submission while VERIFIED → PAYMENT_ALREADY_VERIFIED', async () => {
  const initial = createHarness({ orders: [makeOrder()], paymentMethods: [makeMethod()] });
  await initial.service.submitPayment(submission());
  await initial.service.verifyPayment({ paymentId: initial.paymentRepo.docs[0]._id, performedBy: STAFF });

  const { service, uploads } = createHarness({ orders: [makeOrder()], paymentMethods: [makeMethod()], payments: initial.paymentRepo.docs });
  await assert.rejects(
    () => service.submitPayment(submission()),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.PAYMENT_ALREADY_VERIFIED
  );
  assert.equal(uploads.length, 0);
});

test('retry of the same key + body on a REJECTED payment is a no-op (created:false)', async () => {
  const { service, paymentRepo, uploads } = createHarness({ orders: [makeOrder()], paymentMethods: [makeMethod()] });
  await service.submitPayment(submission());
  const id = paymentRepo.docs[0]._id;
  await service.rejectPayment({ paymentId: id, performedBy: STAFF });

  const retry = await service.submitPayment(submission());
  assert.equal(retry.created, false);
  assert.equal(retry.payment.status, PAYMENT_STATUSES.REJECTED, 'retry must not resurrect the payment');
  assert.equal(uploads.length, 1);
});

test('resubmission of a REJECTED payment replaces proof and clears reviewer fields', async () => {
  const { service, paymentRepo, uploads, deleted } = createHarness({ orders: [makeOrder()], paymentMethods: [makeMethod()] });
  await service.submitPayment(submission());
  const id = paymentRepo.docs[0]._id;
  await service.rejectPayment({ paymentId: id, performedBy: STAFF });
  const oldProof = paymentRepo.docs[0].proof.publicId;

  const resub = await service.submitPayment(submission({ idempotencyKey: 'key-2' }));
  assert.equal(resub.created, false);
  assert.equal(resub.payment.status, PAYMENT_STATUSES.SUBMITTED);
  assert.equal(resub.payment.proof.publicId, `payments/mock-${uploads.length}`);
  assert.equal(resub.payment.verifiedBy, undefined);
  assert.equal(resub.payment.rejectedBy, undefined);

  const persisted = paymentRepo.docs[0];
  assert.equal(persisted.verifiedBy, undefined);
  assert.equal(persisted.verifiedAt, undefined);
  assert.equal(persisted.rejectedBy, undefined);
  assert.equal(persisted.rejectedAt, undefined);
  assert.equal(persisted.statusHistory.length, 3, 'SUBMITTED, REJECTED, SUBMITTED');
  assert.equal(persisted.statusHistory[2].status, PAYMENT_STATUSES.SUBMITTED);
  assert.ok(deleted.includes(oldProof), 'old proof is best-effort deleted after resubmission');
});

test('reference reuse across a different active payment → PAYMENT_IDEMPOTENCY_CONFLICT', async () => {
  const existing = {
    _id: '507f1f77bcf86cd799439401',
    orderId: OTHER_ORDER_ID,
    customerId: OTHER_CUSTOMER,
    paymentMethodId: METHOD_ID,
    transactionReference: 'REF-1',
    status: PAYMENT_STATUSES.SUBMITTED,
    statusHistory: [],
  };
  const { service, uploads, deleted } = createHarness({
    orders: [makeOrder()],
    paymentMethods: [makeMethod()],
    payments: [existing],
  });
  await assert.rejects(
    () => service.submitPayment(submission()),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.PAYMENT_IDEMPOTENCY_CONFLICT
  );
  assert.ok(deleted.some((id) => id.startsWith('payments/mock-')), 'uploaded proof cleaned up on conflict');
  assert.equal(uploads.length, 1);
});

test('reusing a reference previously used by a REJECTED payment is allowed', async () => {
  const { service, paymentRepo } = createHarness({ orders: [makeOrder()], paymentMethods: [makeMethod()] });
  await service.submitPayment(submission());
  const id = paymentRepo.docs[0]._id;
  await service.rejectPayment({ paymentId: id, performedBy: STAFF });
  const resub = await service.submitPayment(submission({ idempotencyKey: 'key-2' }));
  assert.equal(resub.payment.status, PAYMENT_STATUSES.SUBMITTED);
});

test('assertNoReferenceReuse excludes the payment being resubmitted by its own _id', async () => {
  const existing = {
    _id: '507f1f77bcf86cd799439430',
    orderId: ORDER_ID,
    customerId: CUSTOMER,
    paymentMethodId: METHOD_ID,
    transactionReference: 'REF-1',
    status: PAYMENT_STATUSES.SUBMITTED,
    statusHistory: [],
  };
  const { service } = createHarness({ payments: [existing] });
  await service.assertNoReferenceReuse(existing._id, makeMethod(), { transactionReference: 'REF-1' }, {});
});

test('assertNoReferenceReuse still blocks a DIFFERENT order reusing the reference', async () => {
  const otherOrder = {
    _id: '507f1f77bcf86cd799439431',
    orderId: OTHER_ORDER_ID,
    customerId: OTHER_CUSTOMER,
    paymentMethodId: METHOD_ID,
    transactionReference: 'REF-1',
    status: PAYMENT_STATUSES.SUBMITTED,
    statusHistory: [],
  };
  const mine = {
    _id: '507f1f77bcf86cd799439432',
    orderId: ORDER_ID,
    customerId: CUSTOMER,
    paymentMethodId: METHOD_ID,
    transactionReference: 'REF-1',
    status: PAYMENT_STATUSES.REJECTED,
    statusHistory: [],
  };
  const { service } = createHarness({ payments: [otherOrder, mine] });
  await assert.rejects(
    () => service.assertNoReferenceReuse(mine._id, makeMethod(), { transactionReference: 'REF-1' }, {}),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.PAYMENT_IDEMPOTENCY_CONFLICT
  );
});

test('DB failure during create triggers best-effort media cleanup', async () => {
  const { service, paymentRepo, deleted } = createHarness({ orders: [makeOrder()], paymentMethods: [makeMethod()] });
  const originalCreate = paymentRepo.create;
  paymentRepo.create = async () => {
    throw new Error('db down');
  };
  await assert.rejects(() => service.submitPayment(submission()), /db down/);
  assert.ok(deleted.some((id) => id.startsWith('payments/mock-')));
  originalCreate; // keep reference for clarity
});

test('duplicate-orderId race: winner with matching key returns created:false', async () => {
  const { service, paymentRepo } = createHarness({ orders: [makeOrder()], paymentMethods: [makeMethod()] });
  const winner = {
    _id: '507f1f77bcf86cd799439402',
    orderId: ORDER_ID,
    customerId: CUSTOMER,
    paymentMethodId: METHOD_ID,
    status: PAYMENT_STATUSES.SUBMITTED,
    statusHistory: [],
    idempotencyKey: 'key-1',
    idempotencyFingerprint: service.computeFingerprint(submission().value),
  };
  paymentRepo.create = async () => {
    paymentRepo.docs.push(winner);
    throw duplicateKeyError({ orderId: 1 });
  };
  const result = await service.submitPayment(submission());
  assert.equal(result.created, false);
  assert.equal(result.payment.id, winner._id);
});

test('duplicate-orderId race: winner with different body → PAYMENT_ALREADY_SUBMITTED', async () => {
  const { service, paymentRepo } = createHarness({ orders: [makeOrder()], paymentMethods: [makeMethod()] });
  const winner = {
    _id: '507f1f77bcf86cd799439403',
    orderId: ORDER_ID,
    customerId: CUSTOMER,
    paymentMethodId: METHOD_ID,
    status: PAYMENT_STATUSES.SUBMITTED,
    statusHistory: [],
    idempotencyKey: 'other-key',
    idempotencyFingerprint: service.computeFingerprint({ ...submission().value, notes: 'other' }),
  };
  paymentRepo.create = async () => {
    paymentRepo.docs.push(winner);
    throw duplicateKeyError({ orderId: 1 });
  };
  await assert.rejects(
    () => service.submitPayment(submission()),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.PAYMENT_ALREADY_SUBMITTED
  );
});

test('media upload failure surfaces as PAYMENT_PROOF_UPLOAD_FAILED and creates nothing', async () => {
  const { createMemoryMediaService } = require('../../../src/integrations/media/media.mock');
  const paymentRepo = createMemoryPaymentRepository();
  const paymentMethodRepo = createMemoryPaymentMethodRepository([makeMethod()]);
  const orders = [makeOrder()];
  const service = new PaymentService({
    paymentRepository: paymentRepo,
    paymentMethodRepository: paymentMethodRepo,
    orderRepository: { findOne: async (f) => orders.find((o) => Object.keys(f).every((k) => String(o[k]) === String(f[k]))) || null },
    mediaService: createMemoryMediaService({ failUploads: true }),
    runTransaction: async (fn) => fn({}),
  });
  await assert.rejects(
    () => service.submitPayment(submission()),
    (err) => err.statusCode === 502 && err.code === ERROR_CODES.PAYMENT_PROOF_UPLOAD_FAILED
  );
  assert.equal(paymentRepo.docs.length, 0);
});

test('verifyPayment: SUBMITTED → VERIFIED, records actor, does not touch the order', async () => {
  const { service, paymentRepo, orderCalls } = createHarness({ orders: [makeOrder()], paymentMethods: [makeMethod()] });
  await service.submitPayment(submission());
  const id = paymentRepo.docs[0]._id;

  const callsBefore = orderCalls.length;
  const verified = await service.verifyPayment({ paymentId: id, performedBy: STAFF, note: 'looks good' });
  assert.equal(verified.status, PAYMENT_STATUSES.VERIFIED);
  assert.equal(verified.verifiedBy, STAFF);
  assert.ok(verified.verifiedAt);
  assert.equal(verified.statusHistory.length, 2);
  assert.equal(verified.statusHistory[1].status, PAYMENT_STATUSES.VERIFIED);
  assert.equal(verified.statusHistory[1].by, STAFF);
  assert.equal(verified.statusHistory[1].note, 'looks good');
  assert.equal(orderCalls.length, callsBefore, 'verification must not query the order');

  assert.equal(paymentRepo.docs[0].status, PAYMENT_STATUSES.VERIFIED);
});

test('verifyPayment is idempotent when already verified', async () => {
  const { service, paymentRepo } = createHarness({ orders: [makeOrder()], paymentMethods: [makeMethod()] });
  await service.submitPayment(submission());
  const id = paymentRepo.docs[0]._id;
  await service.verifyPayment({ paymentId: id, performedBy: STAFF });
  const again = await service.verifyPayment({ paymentId: id, performedBy: STAFF });
  assert.equal(again.status, PAYMENT_STATUSES.VERIFIED);
  assert.equal(paymentRepo.docs[0].statusHistory.length, 2, 'no duplicate history entry');
});

test('verifyPayment on a non-SUBMITTED state → PAYMENT_INVALID_STATE', async () => {
  const { service, paymentRepo } = createHarness({ orders: [makeOrder()], paymentMethods: [makeMethod()] });
  await service.submitPayment(submission());
  const id = paymentRepo.docs[0]._id;
  await service.rejectPayment({ paymentId: id, performedBy: STAFF });
  await assert.rejects(
    () => service.verifyPayment({ paymentId: id, performedBy: STAFF }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.PAYMENT_INVALID_STATE
  );
});

test('rejectPayment: SUBMITTED → REJECTED and is idempotent when already rejected', async () => {
  const { service, paymentRepo } = createHarness({ orders: [makeOrder()], paymentMethods: [makeMethod()] });
  await service.submitPayment(submission());
  const id = paymentRepo.docs[0]._id;

  const rejected = await service.rejectPayment({ paymentId: id, performedBy: STAFF, note: 'unclear proof' });
  assert.equal(rejected.status, PAYMENT_STATUSES.REJECTED);
  assert.equal(rejected.rejectedBy, STAFF);
  assert.equal(rejected.statusHistory[1].note, 'unclear proof');

  const again = await service.rejectPayment({ paymentId: id, performedBy: STAFF });
  assert.equal(again.status, PAYMENT_STATUSES.REJECTED);
  assert.equal(paymentRepo.docs[0].statusHistory.length, 2, 'no duplicate history entry');
});

test('rejecting an already-verified payment → PAYMENT_INVALID_STATE', async () => {
  const { service, paymentRepo } = createHarness({ orders: [makeOrder()], paymentMethods: [makeMethod()] });
  await service.submitPayment(submission());
  const id = paymentRepo.docs[0]._id;
  await service.verifyPayment({ paymentId: id, performedBy: STAFF });
  await assert.rejects(
    () => service.rejectPayment({ paymentId: id, performedBy: STAFF }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.PAYMENT_INVALID_STATE
  );
});

test('getCustomerPayment is customer-scoped: other customer sees 404', async () => {
  const { service, paymentRepo } = createHarness({ orders: [makeOrder()], paymentMethods: [makeMethod()] });
  await service.submitPayment(submission());
  const id = paymentRepo.docs[0]._id;

  const mine = await service.getCustomerPayment({ customerId: CUSTOMER, orderId: ORDER_ID });
  assert.equal(mine.id, id);

  await assert.rejects(
    () => service.getCustomerPayment({ customerId: OTHER_CUSTOMER, orderId: ORDER_ID }),
    (err) => err.statusCode === 404 && err.code === ERROR_CODES.PAYMENT_NOT_FOUND
  );
});

test('listPayments supports status filter, orderNumber lookup, and pagination', async () => {
  const { service, paymentRepo } = createHarness({ orders: [makeOrder()], paymentMethods: [makeMethod()] });
  await service.submitPayment(submission());
  const id = paymentRepo.docs[0]._id;
  await service.verifyPayment({ paymentId: id, performedBy: STAFF });

  const all = await service.listPayments({ status: PAYMENT_STATUSES.VERIFIED, page: 1, limit: 10 });
  assert.equal(all.payments.length, 1);
  assert.equal(all.payments[0].status, PAYMENT_STATUSES.VERIFIED);
  assert.equal(all.payments[0].verifiedBy, STAFF, 'admin list includes reviewer ids');
  assert.equal(all.pagination.total, 1);

  const byNumber = await service.listPayments({ orderNumber: 'TAQ-20260808-000001' });
  assert.equal(byNumber.payments.length, 1);

  const missingNumber = await service.listPayments({ orderNumber: 'NOPE' });
  assert.equal(missingNumber.payments.length, 0);
  assert.equal(missingNumber.pagination.total, 0);
});

test('invalid state transitions from the repository return PAYMENT_INVALID_STATE', async () => {
  const { service, paymentRepo } = createHarness({ orders: [makeOrder()], paymentMethods: [makeMethod()] });
  await service.submitPayment(submission());
  const id = paymentRepo.docs[0]._id;
  paymentRepo.conditionalTransition = async () => null; // simulate a lost race
  await assert.rejects(
    () => service.verifyPayment({ paymentId: id, performedBy: STAFF }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.PAYMENT_INVALID_STATE
  );
});

test('submitPayment emits PAYMENT_SUBMITTED with a sanitized payload', async () => {
  const { service, notifications, paymentRepo } = createHarness({
    orders: [makeOrder()],
    paymentMethods: [makeMethod()],
  });
  await service.submitPayment(submission());
  assert.equal(notifications.length, 1);
  const n = notifications[0];
  assert.equal(n.userId, CUSTOMER);
  assert.equal(n.eventType, 'PAYMENT_SUBMITTED');
  assert.equal(n.data.entityRef, String(paymentRepo.docs[0]._id));
  assert.deepEqual(n.data.order, { orderNumber: 'TAQ-20260808-000001' });
  assert.equal(n.data.payment.transactionReference, 'REF-1');
  assert.equal(n.data.payment.amountMinorUnits, 248000);
  assert.ok(!Object.prototype.hasOwnProperty.call(n.data, 'notes'), 'payload is sanitized');
});

test('resubmission after a rejection emits PAYMENT_SUBMITTED with the updated reference', async () => {
  const { service, notifications, paymentRepo } = createHarness({
    orders: [makeOrder()],
    paymentMethods: [makeMethod()],
  });
  await service.submitPayment(submission());
  await service.rejectPayment({ paymentId: paymentRepo.docs[0]._id, performedBy: STAFF });
  await service.submitPayment(
    submission({
      idempotencyKey: 'key-2',
      value: { ...submission().value, transactionReference: 'REF-2' },
    })
  );

  assert.equal(notifications.length, 3, 'SUBMITTED + REJECTED + SUBMITTED');
  assert.equal(notifications[1].eventType, 'PAYMENT_REJECTED');
  assert.equal(notifications[2].eventType, 'PAYMENT_SUBMITTED');
  assert.equal(notifications[2].data.payment.transactionReference, 'REF-2');
  assert.equal(
    notifications[2].data.entityRef,
    notifications[0].data.entityRef,
    'resubmission reuses the same payment document'
  );
});

test('verifyPayment emits PAYMENT_VERIFIED with the staff note, without querying the order', async () => {
  const { service, notifications, paymentRepo, orderCalls } = createHarness({
    orders: [makeOrder()],
    paymentMethods: [makeMethod()],
  });
  await service.submitPayment(submission());
  const id = paymentRepo.docs[0]._id;

  const callsBefore = orderCalls.length;
  await service.verifyPayment({ paymentId: id, performedBy: STAFF, note: 'looks good' });
  assert.equal(orderCalls.length, callsBefore, 'verification must not query the order');

  assert.equal(notifications.length, 2);
  const n = notifications[1];
  assert.equal(n.eventType, 'PAYMENT_VERIFIED');
  assert.equal(n.userId, CUSTOMER);
  assert.equal(n.data.note, 'looks good');
  assert.deepEqual(n.data.order, { orderNumber: 'TAQ-20260808-000001' });
  assert.equal(n.data.payment.amountMinorUnits, 248000);
});

test('rejectPayment emits PAYMENT_REJECTED with the staff note', async () => {
  const { service, notifications, paymentRepo } = createHarness({
    orders: [makeOrder()],
    paymentMethods: [makeMethod()],
  });
  await service.submitPayment(submission());
  const id = paymentRepo.docs[0]._id;
  await service.rejectPayment({ paymentId: id, performedBy: STAFF, note: 'unclear proof' });

  assert.equal(notifications.length, 2);
  const n = notifications[1];
  assert.equal(n.eventType, 'PAYMENT_REJECTED');
  assert.equal(n.userId, CUSTOMER);
  assert.equal(n.data.note, 'unclear proof');
  assert.equal(n.data.order.orderNumber, 'TAQ-20260808-000001');
});

test('idempotent verify does not re-notify on the same payment', async () => {
  const { service, notifications, paymentRepo } = createHarness({
    orders: [makeOrder()],
    paymentMethods: [makeMethod()],
  });
  await service.submitPayment(submission());
  const id = paymentRepo.docs[0]._id;
  await service.verifyPayment({ paymentId: id, performedBy: STAFF });
  await service.verifyPayment({ paymentId: id, performedBy: STAFF }); // idempotent short-circuit
  assert.equal(notifications.length, 2, 'no duplicate PAYMENT_VERIFIED');
});
