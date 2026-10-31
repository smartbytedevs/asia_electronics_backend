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

const METHOD_ID = '507f1f77bcf86cd799439301';
const BKASH_METHOD_ID = '507f1f77bcf86cd799439303';
const BOUNDARY = '----taqwaIntegrationBoundary';

function paymentMethodDoc(overrides = {}) {
  return {
    _id: METHOD_ID,
    code: 'BANK_TRANSFER',
    displayName: 'Bank Transfer',
    type: 'MANUAL',
    metadata: {
      accountName: 'Taqwa Trading',
      accountNumber: '0123456789',
      bankName: 'DBBL',
      instructions: 'Use your order number as reference.',
    },
    isActive: true,
    sortOrder: 1,
    ...overrides,
  };
}

function withPayments(methods = [paymentMethodDoc()]) {
  return buildApp({ users: seedUsers(), paymentMethods: methods });
}

function bkashMethodDoc(overrides = {}) {
  return paymentMethodDoc({
    _id: BKASH_METHOD_ID,
    code: 'BKASH',
    displayName: 'bKash',
    metadata: {
      accountName: 'Taqwa Trading',
      accountNumber: '01712345678',
      instructions: 'Use your order number as reference.',
    },
    ...overrides,
  });
}

function pngBytes(size = 64) {
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const rest = Buffer.alloc(Math.max(0, size - magic.length), 0);
  return Buffer.concat([magic, rest]);
}

function jpegBytes() {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16, 0)]);
}

function multipartBody({ fields = {}, file } = {}) {
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
    );
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.type}\r\n\r\n`
      )
    );
    parts.push(file.buffer);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(parts);
}

function submitForm(url, token, body, { idempotencyKey = 'idem-1', headers = {} } = {}) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
      'Idempotency-Key': idempotencyKey,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body,
  });
}

function submissionFields(order, overrides = {}) {
  return {
    paymentMethodId: METHOD_ID,
    submittedAmountMinorUnits: String(order.totals.grandTotalMinorUnits),
    transactionReference: 'BANK-REF-1',
    ...overrides,
  };
}

function proofFile(overrides = {}) {
  return {
    name: 'proof',
    filename: 'receipt.png',
    type: 'image/png',
    buffer: pngBytes(),
    ...overrides,
  };
}

async function seedOrder(baseUrl, token, { paymentMethod = 'MANUAL', key = 'co-key' } = {}) {
  await request('POST', `${baseUrl}/api/v1/cart/items`, token, { productVariantId: V1, quantity: 1 });
  const res = await request(
    'POST',
    `${baseUrl}/api/v1/orders/checkout`,
    token,
    checkoutBody({ paymentMethod }),
    { 'Idempotency-Key': key }
  );
  assert.equal(res.status, 201, 'checkout must succeed');
  return (await res.json()).data.order;
}

async function submitPaymentForOrder(baseUrl, token, order, overrides = {}) {
  const body = multipartBody({
    fields: submissionFields(order, overrides.fields),
    file: overrides.file || proofFile(),
  });
  return submitForm(`${baseUrl}/api/v1/orders/${order.id}/payment`, token, body, overrides);
}

test('protected payment endpoints require authentication (401)', withServer(
  () => withPayments(),
  async (baseUrl) => {
    const cases = [
      ['GET', `${baseUrl}/api/v1/orders/507f1f77bcf86cd799439099/payment`],
      ['GET', `${baseUrl}/api/v1/admin/payments`],
      ['POST', `${baseUrl}/api/v1/admin/payments/507f1f77bcf86cd799439099/verify`],
      ['POST', `${baseUrl}/api/v1/admin/payment-methods`],
    ];
    for (const [method, url] of cases) {
      const res = await request(method, url);
      assert.equal(res.status, 401, `${method} ${url}`);
      assert.equal((await res.json()).error.code, ERROR_CODES.UNAUTHORIZED);
    }
  }
));

test('GET /api/v1/payment-methods is public and lists ACTIVE methods', withServer(
  () => withPayments(),
  async (baseUrl) => {
    const anonymous = await request('GET', `${baseUrl}/api/v1/payment-methods`);
    assert.equal(anonymous.status, 200);
    assert.equal((await anonymous.json()).error, undefined);

    const list = await request('GET', `${baseUrl}/api/v1/payment-methods`);
    const body = await list.json();
    assert.equal(body.success, true);
    assert.equal(body.data.paymentMethods.length, 1);
    assert.equal(body.data.paymentMethods[0].code, 'BANK_TRANSFER');
  }
));

test('RBAC: customer routes reject staff/admin; staff cannot manage payment methods', withServer(
  () => withPayments(),
  async (baseUrl) => {
    const adminCreate = await request(
      'POST',
      `${baseUrl}/api/v1/admin/payment-methods`,
      tokens.tokenStaff,
      { code: 'NAGAD', displayName: 'Nagad', type: 'MANUAL' }
    );
    assert.equal(adminCreate.status, 403);
    assert.equal((await adminCreate.json()).error.code, ERROR_CODES.FORBIDDEN);

    for (const token of [tokens.tokenStaff, tokens.tokenAdmin]) {
      const list = await request('GET', `${baseUrl}/api/v1/payment-methods`, token);
      assert.equal(list.status, 200, 'payment-methods read is public (any role)');
    }

    for (const [method, url] of [
      ['GET', `${baseUrl}/api/v1/admin/payments`],
      ['GET', `${baseUrl}/api/v1/admin/payments/507f1f77bcf86cd799439099`],
      ['POST', `${baseUrl}/api/v1/admin/payments/507f1f77bcf86cd799439099/verify`],
      ['POST', `${baseUrl}/api/v1/admin/payments/507f1f77bcf86cd799439099/reject`],
      ['POST', `${baseUrl}/api/v1/admin/payment-methods`],
      ['PATCH', `${baseUrl}/api/v1/admin/payment-methods/507f1f77bcf86cd799439099`],
    ]) {
      const res = await request(method, url, tokens.tokenCustomer, method === 'GET' ? undefined : {});
      assert.equal(res.status, 403, `${method} ${url}`);
      assert.equal((await res.json()).error.code, ERROR_CODES.FORBIDDEN);
    }
  }
));

test('payment method lifecycle: admin creates, soft-deactivates; customers see active only', withServer(
  () => withPayments([paymentMethodDoc({ isActive: false })]),
  async (baseUrl) => {
    const listBefore = await request('GET', `${baseUrl}/api/v1/payment-methods`, tokens.tokenCustomer);
    assert.equal(listBefore.status, 200);
    const before = (await listBefore.json()).data.paymentMethods;
    assert.equal(before.length, 0, 'inactive method is hidden from customers');

    const created = await request(
      'POST',
      `${baseUrl}/api/v1/admin/payment-methods`,
      tokens.tokenAdmin,
      { code: 'nagad', displayName: 'Nagad', type: 'MANUAL', metadata: { accountNumber: '000' } }
    );
    assert.equal(created.status, 201);
    const method = (await created.json()).data.paymentMethod;
    assert.equal(method.code, 'NAGAD');
    assert.equal(method.isActive, true);

    const duplicate = await request(
      'POST',
      `${baseUrl}/api/v1/admin/payment-methods`,
      tokens.tokenAdmin,
      { code: 'BANK_TRANSFER', displayName: 'X', type: 'MANUAL' }
    );
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).error.code, ERROR_CODES.PAYMENT_METHOD_CODE_ALREADY_EXISTS);

    const deactivated = await request(
      'PATCH',
      `${baseUrl}/api/v1/admin/payment-methods/${method.id}`,
      tokens.tokenAdmin,
      { isActive: false }
    );
    assert.equal(deactivated.status, 200);
    assert.equal((await deactivated.json()).data.paymentMethod.isActive, false);

    const listAfter = await request('GET', `${baseUrl}/api/v1/payment-methods`, tokens.tokenCustomer);
    assert.equal((await listAfter.json()).data.paymentMethods.length, 0, 'deactivated method disappears');
  }
));

test('full flow: MANUAL checkout → submit proof → admin verify without auto-confirming the order', withServer(
  () => withPayments(),
  async (baseUrl, repos) => {
    const order = await seedOrder(baseUrl, tokens.tokenCustomer, { key: 'co-full' });
    assert.equal(order.paymentMethod, 'MANUAL');
    assert.equal(order.status, 'PENDING');

    const res = await submitPaymentForOrder(baseUrl, tokens.tokenCustomer, order);
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.success, true);
    const payment = body.data.payment;
    assert.equal(payment.status, 'SUBMITTED');
    assert.equal(payment.orderId, order.id);
    assert.equal(payment.expectedAmountMinorUnits, order.totals.grandTotalMinorUnits);
    assert.equal(payment.submittedAmountMinorUnits, order.totals.grandTotalMinorUnits);
    assert.equal(payment.paymentMethod.code, 'BANK_TRANSFER');
    assert.equal(payment.paymentMethod.accountNumber, '0123456789');
    assert.equal(payment.transactionReference, 'BANK-REF-1');
    assert.equal(payment.proof.provider, 'mock');
    assert.ok(repos.mediaService.store.has(payment.proof.publicId), 'proof stored in media');

    const mine = await request('GET', `${baseUrl}/api/v1/orders/${order.id}/payment`, tokens.tokenCustomer);
    assert.equal(mine.status, 200);
    assert.equal((await mine.json()).data.payment.id, payment.id);

    const list = await request('GET', `${baseUrl}/api/v1/admin/payments`, tokens.tokenStaff);
    assert.equal(list.status, 200);
    const adminList = (await list.json()).data.payments;
    assert.equal(adminList.length, 1);
    assert.equal(adminList[0].status, 'SUBMITTED');

    const verified = await request(
      'POST',
      `${baseUrl}/api/v1/admin/payments/${payment.id}/verify`,
      tokens.tokenStaff,
      { note: 'proof matches' }
    );
    assert.equal(verified.status, 200);
    const verifiedBody = await verified.json();
    assert.equal(verifiedBody.data.payment.status, 'VERIFIED');
    assert.equal(verifiedBody.data.payment.verifiedBy, '507f1f77bcf86cd799439113');

    const orderAfter = await request('GET', `${baseUrl}/api/v1/orders/${order.id}`, tokens.tokenCustomer);
    assert.equal((await orderAfter.json()).data.order.status, 'PENDING', 'verification must NOT auto-confirm the order');

    const mineAfter = await request('GET', `${baseUrl}/api/v1/orders/${order.id}/payment`, tokens.tokenCustomer);
    const customerView = (await mineAfter.json()).data.payment;
    assert.equal(customerView.status, 'VERIFIED');
    assert.equal('verifiedBy' in customerView, false, 'customer view hides reviewer id');
  }
));

test('checkout accepts BKASH, BANK_TRANSFER and CARD and creates NO payment record', withServer(
  () => withPayments(),
  async (baseUrl, repos) => {
    for (const [method, key] of [
      ['BKASH', 'co-bkash'],
      ['BANK_TRANSFER', 'co-bank'],
      ['CARD', 'co-card'],
    ]) {
      const order = await seedOrder(baseUrl, tokens.tokenCustomer, { paymentMethod: method, key });
      assert.equal(order.paymentMethod, method, `${method}: method is recorded on the order`);
      assert.equal(order.status, 'PENDING');

      const paymentRes = await request(
        'GET',
        `${baseUrl}/api/v1/orders/${order.id}/payment`,
        tokens.tokenCustomer
      );
      assert.equal(paymentRes.status, 404, `${method}: no payment exists until a proof is submitted`);
      assert.equal(
        repos.paymentRepo.docs.length,
        0,
        `${method}: selecting a manual method must not auto-create a payment`
      );
    }
  }
));

test('a BKASH order can submit a manual proof against the BKASH method', withServer(
  () => withPayments([bkashMethodDoc()]),
  async (baseUrl) => {
    const order = await seedOrder(baseUrl, tokens.tokenCustomer, {
      paymentMethod: 'BKASH',
      key: 'co-bkash-proof',
    });
    const res = await submitPaymentForOrder(baseUrl, tokens.tokenCustomer, order, {
      fields: {
        paymentMethodId: BKASH_METHOD_ID,
        submittedAmountMinorUnits: String(order.totals.grandTotalMinorUnits),
        transactionReference: 'BKASH-REF-1',
      },
      idempotencyKey: 'idem-bkash',
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.data.payment.status, 'SUBMITTED');
    assert.equal(body.data.payment.paymentMethod.code, 'BKASH');
  }
));

test('submission rejects non-multipart, missing idempotency key, wrong amount, and spoofed fields', withServer(
  () => withPayments(),
  async (baseUrl) => {
    const order = await seedOrder(baseUrl, tokens.tokenCustomer, { key: 'co-bad' });

    const jsonPost = await request('POST', `${baseUrl}/api/v1/orders/${order.id}/payment`, tokens.tokenCustomer, {
      paymentMethodId: METHOD_ID,
    });
    assert.equal(jsonPost.status, 400);
    assert.equal((await jsonPost.json()).error.code, ERROR_CODES.INVALID_PAYMENT);

    const noKey = await fetch(`${baseUrl}/api/v1/orders/${order.id}/payment`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
        Authorization: `Bearer ${tokens.tokenCustomer}`,
      },
      body: multipartBody({ fields: submissionFields(order), file: proofFile() }),
    });
    assert.equal(noKey.status, 400);
    assert.equal((await noKey.json()).error.code, ERROR_CODES.INVALID_PAYMENT);

    const wrongAmount = await submitPaymentForOrder(baseUrl, tokens.tokenCustomer, order, {
      fields: { submittedAmountMinorUnits: String(order.totals.grandTotalMinorUnits + 1) },
    });
    assert.equal(wrongAmount.status, 400);
    assert.equal((await wrongAmount.json()).error.code, ERROR_CODES.INVALID_PAYMENT_AMOUNT);

    const spoofed = [
      { status: 'VERIFIED' },
      { verifiedBy: '507f1f77bcf86cd799439113' },
      { expectedAmountMinorUnits: '1' },
      { customerId: '507f1f77bcf86cd799439999' },
      { $set: '{"status":"VERIFIED"}' },
    ];
    for (const field of spoofed) {
      const res = await submitPaymentForOrder(baseUrl, tokens.tokenCustomer, order, { fields: field, idempotencyKey: 'spoof' });
      assert.equal(res.status, 400, JSON.stringify(field));
      assert.equal((await res.json()).error.code, ERROR_CODES.INVALID_PAYMENT);
    }
  }
));

test('submission rejects invalid proof: wrong MIME, disguised magic bytes, and oversized files', withServer(
  () => withPayments(),
  async (baseUrl) => {
    const order = await seedOrder(baseUrl, tokens.tokenCustomer, { key: 'co-proof' });

    const badMime = await submitPaymentForOrder(baseUrl, tokens.tokenCustomer, order, {
      idempotencyKey: 'proof-mime',
      file: proofFile({ type: 'text/html', filename: 'payload.html', buffer: Buffer.from('<html>') }),
    });
    assert.equal(badMime.status, 400);
    assert.equal((await badMime.json()).error.code, ERROR_CODES.INVALID_PAYMENT_PROOF);

    const disguised = await submitPaymentForOrder(baseUrl, tokens.tokenCustomer, order, {
      idempotencyKey: 'proof-magic',
      file: proofFile({ buffer: jpegBytes() }),
    });
    assert.equal(disguised.status, 400);
    assert.equal((await disguised.json()).error.code, ERROR_CODES.INVALID_PAYMENT_PROOF);

    const oversized = await submitPaymentForOrder(baseUrl, tokens.tokenCustomer, order, {
      idempotencyKey: 'proof-size',
      file: proofFile({ buffer: Buffer.alloc(2 * 1024 * 1024 + 1, 0) }),
    });
    assert.equal(oversized.status, 400);

    const missingProof = await submitForm(`${baseUrl}/api/v1/orders/${order.id}/payment`, tokens.tokenCustomer, multipartBody({
      fields: submissionFields(order),
    }));
    assert.equal(missingProof.status, 400);
    assert.equal((await missingProof.json()).error.code, ERROR_CODES.PAYMENT_PROOF_REQUIRED);
  }
));

test('submission idempotency: retry returns the same payment; conflict when body changes', withServer(
  () => withPayments(),
  async (baseUrl, repos) => {
    const order = await seedOrder(baseUrl, tokens.tokenCustomer, { key: 'co-idem' });

    const first = await submitPaymentForOrder(baseUrl, tokens.tokenCustomer, order);
    assert.equal(first.status, 201);
    const firstPayment = (await first.json()).data.payment;

    const retry = await submitPaymentForOrder(baseUrl, tokens.tokenCustomer, order);
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).data.payment.id, firstPayment.id);
    assert.equal(repos.mediaService.calls.uploads.length, 1, 'retry must not re-upload');

    const changedBody = await submitPaymentForOrder(baseUrl, tokens.tokenCustomer, order, {
      fields: { notes: 'different body' },
    });
    assert.equal(changedBody.status, 409);
    assert.equal((await changedBody.json()).error.code, ERROR_CODES.PAYMENT_ALREADY_SUBMITTED);

    const newKey = await submitPaymentForOrder(baseUrl, tokens.tokenCustomer, order, { idempotencyKey: 'other-key' });
    assert.equal(newKey.status, 409);
    assert.equal((await newKey.json()).error.code, ERROR_CODES.PAYMENT_ALREADY_SUBMITTED);
  }
));

test('rejection → resubmission clears reviewer fields, uploads a fresh proof, and deletes the old one', withServer(
  () => withPayments(),
  async (baseUrl, repos) => {
    const order = await seedOrder(baseUrl, tokens.tokenCustomer, { key: 'co-resub' });

    const first = await submitPaymentForOrder(baseUrl, tokens.tokenCustomer, order);
    const payment = (await first.json()).data.payment;

    const rejected = await request(
      'POST',
      `${baseUrl}/api/v1/admin/payments/${payment.id}/reject`,
      tokens.tokenAdmin,
      { note: 'unclear photo' }
    );
    assert.equal(rejected.status, 200);
    assert.equal((await rejected.json()).data.payment.status, 'REJECTED');

    const resub = await submitPaymentForOrder(baseUrl, tokens.tokenCustomer, order, { idempotencyKey: 'resub-key' });
    assert.equal(resub.status, 200);
    const resubPayment = (await resub.json()).data.payment;
    assert.equal(resubPayment.status, 'SUBMITTED');
    assert.equal(resubPayment.id, payment.id, 'resubmission mutates the same record');
    assert.notEqual(resubPayment.proof.publicId, payment.proof.publicId);
    assert.equal('rejectedBy' in resubPayment, false, 'rejection actor hidden from customer view');
    assert.equal(resubPayment.rejectedAt, null, 'rejection timestamp cleared');
    assert.equal(resubPayment.verifiedAt, null, 'verification timestamp cleared');
    assert.ok(!repos.mediaService.store.has(payment.proof.publicId), 'old proof cleaned up');
    assert.ok(repos.mediaService.store.has(resubPayment.proof.publicId), 'new proof stored');
  }
));

test('cross-customer isolation and reference reuse are enforced', withServer(
  () => withPayments(),
  async (baseUrl, repos) => {
    const orderA = await seedOrder(baseUrl, tokens.tokenCustomer, { key: 'co-a' });
    await submitPaymentForOrder(baseUrl, tokens.tokenCustomer, orderA);

    const otherRead = await request('GET', `${baseUrl}/api/v1/orders/${orderA.id}/payment`, tokens.tokenCustomer2);
    assert.equal(otherRead.status, 404);
    assert.equal((await otherRead.json()).error.code, ERROR_CODES.PAYMENT_NOT_FOUND);

    const otherSubmit = await submitPaymentForOrder(baseUrl, tokens.tokenCustomer2, orderA);
    assert.equal(otherSubmit.status, 404);
    assert.equal((await otherSubmit.json()).error.code, ERROR_CODES.PAYMENT_NOT_FOUND);

    const orderB = await seedOrder(baseUrl, tokens.tokenCustomer2, { key: 'co-b' });
    const reused = await submitPaymentForOrder(baseUrl, tokens.tokenCustomer2, orderB, {
      fields: { transactionReference: 'BANK-REF-1' },
    });
    assert.equal(reused.status, 409);
    assert.equal((await reused.json()).error.code, ERROR_CODES.PAYMENT_IDEMPOTENCY_CONFLICT);
    assert.equal(repos.mediaService.store.size, 1, 'conflicting upload is cleaned up');
  }
));

test('admin review state machine: verify/reject idempotency and wrong-state guards', withServer(
  () => withPayments(),
  async (baseUrl) => {
    const order = await seedOrder(baseUrl, tokens.tokenCustomer, { key: 'co-review' });
    const payment = (await submitPaymentForOrder(baseUrl, tokens.tokenCustomer, order).then((r) => r.json())).data.payment;

    const verify = await request('POST', `${baseUrl}/api/v1/admin/payments/${payment.id}/verify`, tokens.tokenAdmin, {});
    assert.equal(verify.status, 200);
    assert.equal((await verify.json()).data.payment.status, 'VERIFIED');

    const verifyAgain = await request('POST', `${baseUrl}/api/v1/admin/payments/${payment.id}/verify`, tokens.tokenAdmin, {});
    assert.equal(verifyAgain.status, 200, 'idempotent when already verified');

    const rejectVerified = await request('POST', `${baseUrl}/api/v1/admin/payments/${payment.id}/reject`, tokens.tokenAdmin, {});
    assert.equal(rejectVerified.status, 409);
    assert.equal((await rejectVerified.json()).error.code, ERROR_CODES.PAYMENT_INVALID_STATE);

    const listFilter = await request('GET', `${baseUrl}/api/v1/admin/payments?status=VERIFIED`, tokens.tokenStaff);
    assert.equal((await listFilter.json()).data.payments.length, 1);

    const badFilter = await request('GET', `${baseUrl}/api/v1/admin/payments?status=PAID`, tokens.tokenStaff);
    assert.equal(badFilter.status, 400);
    assert.equal((await badFilter.json()).error.code, ERROR_CODES.INVALID_PAYMENT_STATUS);
  }
));
