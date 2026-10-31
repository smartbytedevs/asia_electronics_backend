'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateCheckoutInput,
  validateIdempotencyKey,
  validateTransitionInput,
  assertObjectId,
} = require('../../../src/modules/orders/order.validation');
const { ERROR_CODES } = require('../../../src/constants');
const { PAYMENT_METHODS, ORDER_LIMITS, DELIVERY_ZONES } = require('../../../src/modules/orders/order.constants');

const VALID_ADDRESS = {
  fullName: 'Amina Rahman',
  phone: '+8801712345678',
  line1: 'House 12, Road 5',
  line2: 'Banani',
  city: 'Chattogram',
  area: 'GEC Circle',
  district: 'Chattogram',
  postalCode: '4000',
  country: 'BD',
};

function validBody(overrides = {}) {
  return {
    delivery: { address: { ...VALID_ADDRESS } },
    notes: null,
    paymentMethod: PAYMENT_METHODS.COD,
    ...overrides,
  };
}

test('a well-formed checkout body validates and normalizes', () => {
  const { value } = validateCheckoutInput(validBody());
  assert.equal(value.delivery.address.country, 'BD');
  assert.equal(value.paymentMethod, PAYMENT_METHODS.COD);
  assert.equal(value.notes, null);
  assert.equal(value.delivery.zone, null, 'zone defaults to null (address-derived) when not supplied');
});

test('country is uppercased and must be BD', () => {
  const { value } = validateCheckoutInput(validBody({ delivery: { address: { ...VALID_ADDRESS, country: 'bd' } } }));
  assert.equal(value.delivery.address.country, 'BD');
  assert.throws(
    () => validateCheckoutInput(validBody({ delivery: { address: { ...VALID_ADDRESS, country: 'US' } } })),
    (err) => err.code === ERROR_CODES.INVALID_DELIVERY_ADDRESS
  );
});

test('the customer-selected delivery zone is accepted and normalized', () => {
  for (const zone of Object.values(DELIVERY_ZONES)) {
    const { value } = validateCheckoutInput(
      validBody({ delivery: { address: { ...VALID_ADDRESS }, zone } })
    );
    assert.equal(value.delivery.zone, zone, `${zone} is preserved`);
  }
  const { value: lower } = validateCheckoutInput(
    validBody({ delivery: { address: { ...VALID_ADDRESS }, zone: 'inside_chittagong' } })
  );
  assert.equal(lower.delivery.zone, DELIVERY_ZONES.INSIDE_CHITTAGONG, 'zone is uppercased');
  const { value: blank } = validateCheckoutInput(
    validBody({ delivery: { address: { ...VALID_ADDRESS }, zone: '  ' } })
  );
  assert.equal(blank.delivery.zone, null, 'blank zone normalizes to null (address-derived)');
});

test('an invalid delivery zone and a client-supplied delivery fee are rejected', () => {
  for (const bad of [
    { delivery: { address: { ...VALID_ADDRESS }, zone: 'DHAKA' } },
    { delivery: { address: { ...VALID_ADDRESS }, zone: 42 } },
    { delivery: { address: { ...VALID_ADDRESS }, deliveryFeeMinorUnits: 5000 } },
  ]) {
    assert.throws(
      () => validateCheckoutInput(validBody(bad)),
      (err) => err.code === ERROR_CODES.INVALID_ORDER
    );
  }
});

test('an optional delivery email is accepted and normalized (trim + lowercase)', () => {
  const { value } = validateCheckoutInput(
    validBody({ delivery: { address: { ...VALID_ADDRESS, email: '  Guest@Example.COM ' } } })
  );
  assert.equal(value.delivery.address.email, 'guest@example.com');
});

test('a missing / null / blank delivery email is treated as absent', () => {
  const absent = validateCheckoutInput(validBody()).value.delivery.address.email;
  assert.equal(absent, null, 'absent email normalizes to null');
  for (const email of [null, '', '   ']) {
    const { value } = validateCheckoutInput(
      validBody({ delivery: { address: { ...VALID_ADDRESS, email } } })
    );
    assert.equal(value.delivery.address.email, null, `blank email ${JSON.stringify(email)} normalizes to null`);
  }
});

test('an invalid or oversized delivery email is rejected', () => {
  const bad = ['not-an-email', 'a@b', '@example.com', 'guest@', 42, `${'a'.repeat(250)}@example.com`];
  for (const email of bad) {
    assert.throws(
      () => validateCheckoutInput(validBody({ delivery: { address: { ...VALID_ADDRESS, email } } })),
      (err) => err.code === ERROR_CODES.INVALID_DELIVERY_ADDRESS,
      `email ${String(email).slice(0, 40)} must be rejected`
    );
  }
});

test('client money / totals / status / identity are rejected as unknown fields', () => {
  const badFields = {
    totals: { grandTotalMinorUnits: 1 },
    status: 'CONFIRMED',
    orderNumber: 'TAQ-99999999-000000',
    customerId: '507f1f77bcf86cd799439011',
    performedBy: '507f1f77bcf86cd799439011',
    items: [],
  };
  for (const [key, value] of Object.entries(badFields)) {
    assert.throws(
      () => validateCheckoutInput(validBody({ [key]: value })),
      (err) => err.code === ERROR_CODES.INVALID_ORDER,
      `field "${key}" must be rejected`
    );
  }
});

test('MongoDB operator injection is rejected at every nesting level', () => {
  assert.throws(
    () => validateCheckoutInput(validBody({ $set: { status: 'CONFIRMED' } })),
    (err) => err.code === ERROR_CODES.INVALID_ORDER
  );
  assert.throws(
    () => validateCheckoutInput(validBody({ delivery: { $inc: { quantity: 1 }, address: { ...VALID_ADDRESS } } })),
    (err) => err.code === ERROR_CODES.INVALID_DELIVERY_ADDRESS
  );
  assert.throws(
    () =>
      validateCheckoutInput(
        validBody({ delivery: { address: { ...VALID_ADDRESS, $set: {} } } })
      ),
    (err) => err.code === ERROR_CODES.INVALID_DELIVERY_ADDRESS
  );
});

test('paymentMethod defaults to COD and accepts COD, MANUAL, BKASH, BANK_TRANSFER and CARD', () => {
  assert.equal(validateCheckoutInput(validBody({ paymentMethod: undefined })).value.paymentMethod, PAYMENT_METHODS.COD);
  for (const method of [
    PAYMENT_METHODS.COD,
    PAYMENT_METHODS.MANUAL,
    PAYMENT_METHODS.BKASH,
    PAYMENT_METHODS.BANK_TRANSFER,
    PAYMENT_METHODS.CARD,
  ]) {
    assert.equal(
      validateCheckoutInput(validBody({ paymentMethod: method })).value.paymentMethod,
      method
    );
  }
  assert.throws(
    () => validateCheckoutInput(validBody({ paymentMethod: 'UPI' })),
    (err) => err.code === ERROR_CODES.INVALID_ORDER
  );
});

test('required address fields and length limits are enforced', () => {
  for (const field of ['fullName', 'phone', 'line1', 'city', 'area', 'district', 'postalCode', 'country']) {
    const address = { ...VALID_ADDRESS, [field]: undefined };
    assert.throws(
      () => validateCheckoutInput(validBody({ delivery: { address } })),
      (err) => err.code === ERROR_CODES.INVALID_DELIVERY_ADDRESS,
      `missing ${field} must be rejected`
    );
  }
  assert.throws(
    () => validateCheckoutInput(validBody({ delivery: { address: { ...VALID_ADDRESS, fullName: 'x'.repeat(ORDER_LIMITS.FULL_NAME_MAX + 1) } } })),
    (err) => err.code === ERROR_CODES.INVALID_DELIVERY_ADDRESS
  );
  assert.throws(
    () => validateCheckoutInput(validBody({ notes: 'x'.repeat(ORDER_LIMITS.NOTES_MAX + 1) })),
    (err) => err.code === ERROR_CODES.INVALID_ORDER
  );
});

test('idempotency key is required, trimmed, and length-limited', () => {
  assert.throws(() => validateIdempotencyKey(undefined), (err) => err.code === ERROR_CODES.INVALID_ORDER);
  assert.throws(() => validateIdempotencyKey('   '), (err) => err.code === ERROR_CODES.INVALID_ORDER);
  assert.equal(validateIdempotencyKey('  key-123  '), 'key-123');
  assert.throws(
    () => validateIdempotencyKey('k'.repeat(ORDER_LIMITS.IDEMPOTENCY_KEY_MAX + 1)),
    (err) => err.code === ERROR_CODES.INVALID_ORDER
  );
});

test('transition body only allows an optional short note', () => {
  assert.deepEqual(validateTransitionInput({}).value, { note: null });
  assert.equal(validateTransitionInput({ note: 'Verified by phone' }).value.note, 'Verified by phone');
  assert.throws(
    () => validateTransitionInput({ status: 'CONFIRMED' }),
    (err) => err.code === ERROR_CODES.INVALID_ORDER
  );
  assert.throws(
    () => validateTransitionInput({ note: 'x'.repeat(ORDER_LIMITS.NOTE_MAX + 1) }),
    (err) => err.code === ERROR_CODES.INVALID_ORDER
  );
});

test('assertObjectId enforces the 24-hex shape', () => {
  assert.equal(assertObjectId('507f1f77bcf86cd799439011', 'id'), '507f1f77bcf86cd799439011');
  assert.throws(() => assertObjectId('not-an-id', 'id'), (err) => err.code === ERROR_CODES.INVALID_ORDER);
  assert.throws(() => assertObjectId(null, 'id'), (err) => err.code === ERROR_CODES.INVALID_ORDER);
});
