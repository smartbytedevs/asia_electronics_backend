'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateSubmitMultipart,
  validateIdempotencyKey,
  validateReviewInput,
  validatePaymentListQuery,
  validateProofFile,
} = require('../../../src/modules/payments/payment.validation');
const { ERROR_CODES } = require('../../../src/constants');

const METHOD_ID = '507f1f77bcf86cd799439061';

function pngBuffer() {
  // 8-byte PNG magic + padding; only magic matters to the validator.
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
}

function jpegBuffer() {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16)]);
}

function webpBuffer() {
  return Buffer.concat([
    Buffer.from([0x52, 0x49, 0x46, 0x46]),
    Buffer.alloc(4),
    Buffer.from([0x57, 0x45, 0x42, 0x50]),
    Buffer.alloc(8),
  ]);
}

function validSubmission(overrides = {}) {
  return {
    fields: {
      paymentMethodId: METHOD_ID,
      submittedAmountMinorUnits: '248000',
      transactionReference: 'BANK-REF-1',
      ...(overrides.fields || {}),
    },
    files: [
      {
        fieldName: 'proof',
        originalName: 'receipt.png',
        contentType: 'image/png',
        buffer: pngBuffer(),
      },
    ],
  };
}

test('a valid multipart submission validates and normalizes', () => {
  const { value, proof } = validateSubmitMultipart(validSubmission());
  assert.equal(value.paymentMethodId, METHOD_ID);
  assert.equal(value.submittedAmountMinorUnits, 248000);
  assert.equal(value.transactionReference, 'BANK-REF-1');
  assert.equal(value.notes, null);
  assert.equal(proof.fieldName, 'proof');
});

test('submitted amount must be a non-negative integer string', () => {
  for (const bad of ['12.5', '-5', 'abc', '1e3', '']) {
    assert.throws(
      () => validateSubmitMultipart(validSubmission({ fields: { submittedAmountMinorUnits: bad } })),
      (err) => err.code === ERROR_CODES.INVALID_PAYMENT,
      `amount "${bad}" must be rejected`
    );
  }
});

test('missing/invalid paymentMethodId and transactionReference are rejected', () => {
  assert.throws(
    () => validateSubmitMultipart(validSubmission({ fields: { paymentMethodId: 'nope' } })),
    (err) => err.code === ERROR_CODES.INVALID_PAYMENT
  );
  assert.throws(
    () => validateSubmitMultipart(validSubmission({ fields: { transactionReference: '' } })),
    (err) => err.code === ERROR_CODES.INVALID_PAYMENT
  );
});

test('unknown / operator / server-derived fields are rejected', () => {
  assert.throws(
    () => validateSubmitMultipart(validSubmission({ fields: { status: 'VERIFIED' } })),
    (err) => err.code === ERROR_CODES.INVALID_PAYMENT
  );
  assert.throws(
    () => validateSubmitMultipart(validSubmission({ fields: { verifiedBy: METHOD_ID } })),
    (err) => err.code === ERROR_CODES.INVALID_PAYMENT
  );
  assert.throws(
    () => validateSubmitMultipart(validSubmission({ fields: { expectedAmountMinorUnits: '1' } })),
    (err) => err.code === ERROR_CODES.INVALID_PAYMENT
  );
  assert.throws(
    () => validateSubmitMultipart(validSubmission({ fields: { $set: '{}' } })),
    (err) => err.code === ERROR_CODES.INVALID_PAYMENT
  );
});

test('proof is required and limited to a single file', () => {
  assert.throws(
    () => validateSubmitMultipart({ ...validSubmission(), files: [] }),
    (err) => err.code === ERROR_CODES.PAYMENT_PROOF_REQUIRED
  );
  assert.throws(
    () =>
      validateSubmitMultipart({
        ...validSubmission(),
        files: [
          ...validSubmission().files,
          { fieldName: 'proof', originalName: 'b.png', contentType: 'image/png', buffer: pngBuffer() },
        ],
      }),
    (err) => err.code === ERROR_CODES.INVALID_PAYMENT_PROOF
  );
});

test('proof MIME allowlist rejects everything that is not JPEG/PNG/WEBP', () => {
  for (const contentType of ['image/svg+xml', 'text/html', 'application/pdf', 'application/javascript']) {
    assert.throws(
      () =>
        validateSubmitMultipart({
          ...validSubmission(),
          files: [{ fieldName: 'proof', originalName: 'bad.bin', contentType, buffer: Buffer.from('x'.repeat(16)) }],
        }),
      (err) => err.code === ERROR_CODES.INVALID_PAYMENT_PROOF,
      `${contentType} must be rejected`
    );
  }
});

test('extension must be consistent with the declared MIME (polyglot guard)', () => {
  assert.throws(
    () =>
      validateSubmitMultipart({
        ...validSubmission(),
        files: [{ fieldName: 'proof', originalName: 'receipt.svg', contentType: 'image/png', buffer: pngBuffer() }],
      }),
    (err) => err.code === ERROR_CODES.INVALID_PAYMENT_PROOF
  );
  assert.throws(
    () =>
      validateSubmitMultipart({
        ...validSubmission(),
        files: [{ fieldName: 'proof', originalName: 'receipt.html', contentType: 'image/png', buffer: pngBuffer() }],
      }),
    (err) => err.code === ERROR_CODES.INVALID_PAYMENT_PROOF
  );
});

test('magic bytes must match the declared MIME (disguised content rejected)', () => {
  assert.throws(
    () =>
      validateSubmitMultipart({
        ...validSubmission(),
        files: [{ fieldName: 'proof', originalName: 'x.png', contentType: 'image/png', buffer: Buffer.from('<svg>') }],
      }),
    (err) => err.code === ERROR_CODES.INVALID_PAYMENT_PROOF
  );
  assert.throws(
    () =>
      validateSubmitMultipart({
        ...validSubmission(),
        files: [{ fieldName: 'proof', originalName: 'x.png', contentType: 'image/png', buffer: jpegBuffer() }],
      }),
    (err) => err.code === ERROR_CODES.INVALID_PAYMENT_PROOF,
    'JPEG bytes behind a .png name must be rejected'
  );
});

test('webp is accepted only with RIFF...WEBP magic', () => {
  assert.doesNotThrow(() =>
    validateSubmitMultipart({
      ...validSubmission(),
      files: [{ fieldName: 'proof', originalName: 'x.webp', contentType: 'image/webp', buffer: webpBuffer() }],
    })
  );
  assert.throws(
    () =>
      validateSubmitMultipart({
        ...validSubmission(),
        files: [{ fieldName: 'proof', originalName: 'x.webp', contentType: 'image/webp', buffer: Buffer.from('not webp') }],
      }),
    (err) => err.code === ERROR_CODES.INVALID_PAYMENT_PROOF
  );
});

test('validateProofFile rejects oversized proof', () => {
  const big = Buffer.alloc(2 * 1024 * 1024 + 1, 0x89);
  big[0] = 0x89; big[1] = 0x50; big[2] = 0x4e; big[3] = 0x47; big[4] = 0x0d; big[5] = 0x0a; big[6] = 0x1a; big[7] = 0x0a;
  assert.throws(
    () => validateProofFile({ fieldName: 'proof', originalName: 'big.png', contentType: 'image/png', buffer: big }),
    (err) => err.code === ERROR_CODES.INVALID_PAYMENT_PROOF
  );
});

test('idempotency key is required, trimmed, and length-limited', () => {
  assert.throws(() => validateIdempotencyKey(undefined), (err) => err.code === ERROR_CODES.INVALID_PAYMENT);
  assert.equal(validateIdempotencyKey('  key-1  '), 'key-1');
  assert.throws(() => validateIdempotencyKey('x'.repeat(101)), (err) => err.code === ERROR_CODES.INVALID_PAYMENT);
});

test('review input accepts only an optional note', () => {
  assert.deepEqual(validateReviewInput({}).value, { note: null });
  assert.equal(validateReviewInput({ note: 'ok' }).value.note, 'ok');
  assert.throws(() => validateReviewInput({ status: 'VERIFIED' }), (err) => err.code === ERROR_CODES.INVALID_PAYMENT);
  assert.throws(() => validateReviewInput({ $set: {} }), (err) => err.code === ERROR_CODES.INVALID_PAYMENT);
});

test('admin list query validates known filters and ignores unknown keys', () => {
  const { filter, dateFrom, dateTo } = validatePaymentListQuery({
    status: 'SUBMITTED',
    paymentMethodId: METHOD_ID,
    customerId: '507f1f77bcf86cd799439111',
    orderNumber: 'TAQ-20260808-000001',
    dateFrom: '2026-08-01T00:00:00.000Z',
    dateTo: '2026-08-08T00:00:00.000Z',
    nope: 'ignored',
  });
  assert.equal(filter.status, 'SUBMITTED');
  assert.equal(filter.paymentMethodId, METHOD_ID);
  assert.equal(filter.customerId, '507f1f77bcf86cd799439111');
  assert.equal(filter.orderNumber, 'TAQ-20260808-000001');
  assert.ok(dateFrom instanceof Date);
  assert.ok(dateTo instanceof Date);
});

test('admin list query rejects invalid status / ids / date ranges', () => {
  assert.throws(() => validatePaymentListQuery({ status: 'PAID' }), (err) => err.code === ERROR_CODES.INVALID_PAYMENT_STATUS);
  assert.throws(() => validatePaymentListQuery({ paymentMethodId: 'bad' }), (err) => err.code === ERROR_CODES.INVALID_PAYMENT);
  assert.throws(
    () => validatePaymentListQuery({ dateFrom: '2026-08-08', dateTo: '2026-08-01' }),
    (err) => err.code === ERROR_CODES.INVALID_PAYMENT
  );
});
