'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Reservation = require('../../../src/modules/inventory/reservation.model');
const {
  RESERVATION_STATUS_VALUES,
} = require('../../../src/modules/inventory/inventory.constants');

const VARIANT_ID = '507f1f77bcf86cd799439031';
const USER_ID = '507f1f77bcf86cd799439090';

function validReservationData(overrides = {}) {
  return {
    productVariantId: VARIANT_ID,
    quantity: 3,
    status: 'ACTIVE',
    expiresAt: null,
    referenceType: 'ORDER',
    referenceId: 'order-123',
    metadata: {},
    createdBy: USER_ID,
    ...overrides,
  };
}

test('creates a valid reservation', async () => {
  const reservation = new Reservation(validReservationData());
  await reservation.validate();
  assert.equal(String(reservation.productVariantId), VARIANT_ID);
  assert.equal(reservation.quantity, 3);
  assert.equal(reservation.status, 'ACTIVE');
  assert.equal(reservation.referenceType, 'ORDER');
  assert.equal(reservation.referenceId, 'order-123');
  assert.equal(String(reservation.createdBy), USER_ID);
});

test('requires a stock subject, quantity, reference fields, and createdBy', async () => {
  const reservation = new Reservation({});
  await assert.rejects(reservation.validate(), (err) => {
    assert.ok(err.errors.productVariantId, 'productId/productVariantId subject validation error');
    assert.ok(err.errors.quantity, 'quantity validation error');
    assert.ok(err.errors.referenceType, 'referenceType validation error');
    assert.ok(err.errors.referenceId, 'referenceId validation error');
    assert.ok(err.errors.createdBy, 'createdBy validation error');
    return true;
  });

  const simple = new Reservation(
    validReservationData({ productVariantId: undefined, productId: '507f1f77bcf86cd799439032' })
  );
  await simple.validate();
  assert.equal(simple.productVariantId, null);
  assert.equal(String(simple.productId), '507f1f77bcf86cd799439032');
});

test('accepts every reservation status (terminal states included)', async () => {
  for (const status of RESERVATION_STATUS_VALUES) {
    const reservation = new Reservation(validReservationData({ status }));
    await reservation.validate();
  }
});

test('rejects an unknown status', async () => {
  const reservation = new Reservation(validReservationData({ status: 'HELD' }));
  await assert.rejects(reservation.validate(), (err) => {
    assert.ok(err.errors.status, 'status enum validation error');
    return true;
  });
});

test('rejects non-positive or fractional quantities', async () => {
  const zero = new Reservation(validReservationData({ quantity: 0 }));
  await assert.rejects(zero.validate(), (err) => {
    assert.ok(err.errors.quantity, 'zero quantity rejected');
    return true;
  });
  const fractional = new Reservation(validReservationData({ quantity: 1.5 }));
  await assert.rejects(fractional.validate(), (err) => {
    assert.ok(err.errors.quantity, 'fractional quantity rejected');
    return true;
  });
});

test('trims reference fields', async () => {
  const reservation = new Reservation(
    validReservationData({ referenceType: ' ORDER ', referenceId: ' order-123 ' })
  );
  await reservation.validate();
  assert.equal(reservation.referenceType, 'ORDER');
  assert.equal(reservation.referenceId, 'order-123');
});

test('declares the reservation indexes', () => {
  const indexes = Reservation.schema.indexes();
  const variantStatus = indexes.find(
    ([key]) => key.productVariantId === 1 && key.status === 1
  );
  const reference = indexes.find(
    ([key]) => key.referenceType === 1 && key.referenceId === 1
  );
  const expiry = indexes.find(([key]) => key.status === 1 && key.expiresAt === 1);
  assert.ok(variantStatus, 'productVariantId+status index exists');
  assert.ok(reference, 'reference index exists');
  assert.ok(expiry, 'status+expiresAt index exists');
});
