'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  serializeOrder,
  serializeCustomerOrder,
  serializeAdminOrder,
} = require('../../../src/modules/orders/order.serializer');

function orderDoc(overrides = {}) {
  return {
    _id: '507f1f77bcf86cd799439011',
    orderNumber: 'TAQ-20260808-123456',
    customerId: '507f1f77bcf86cd799439022',
    status: 'PENDING',
    statusHistory: [
      { status: 'PENDING', at: new Date('2026-08-08T10:00:00Z'), by: '507f1f77bcf86cd799439022', note: null },
    ],
    totals: {
      itemsSubtotalMinorUnits: 200000,
      totalDiscountMinorUnits: 20000,
      deliveryFeeMinorUnits: 0,
      grandTotalMinorUnits: 180000,
    },
    delivery: {
      address: {
        fullName: 'Amina Rahman',
        phone: '+8801712345678',
        line1: 'House 12',
        line2: null,
        city: 'Chattogram',
        area: 'GEC',
        district: 'Chattogram',
        postalCode: '4000',
        country: 'BD',
      },
      zone: 'INSIDE_CHITTAGONG',
      deliveryFeeMinorUnits: 0,
    },
    items: [
      {
        _id: '507f1f77bcf86cd799439033',
        productId: '507f1f77bcf86cd799439044',
        productVariantId: '507f1f77bcf86cd799439055',
        productName: 'Abaya',
        variantAttributes: { size: '52' },
        sku: 'ABAYA-52',
        quantity: 2,
        unitPriceMinorUnits: 90000,
        discountMinorUnits: 10000,
        lineTotalMinorUnits: 180000,
      },
    ],
    reservationReference: {
      reservationIds: ['507f1f77bcf86cd799439066', '507f1f77bcf86cd799439077'],
      referenceType: 'ORDER',
    },
    paymentMethod: 'COD',
    notes: null,
    createdAt: new Date('2026-08-08T10:00:00Z'),
    updatedAt: new Date('2026-08-08T10:00:00Z'),
    __v: 0,
  };
}

test('customer serialization is stable and omits internals', () => {
  const out = serializeCustomerOrder(orderDoc());
  assert.equal(out.id, '507f1f77bcf86cd799439011');
  assert.equal(out.orderNumber, 'TAQ-20260808-123456');
  assert.equal(out.status, 'PENDING');
  assert.equal(out.totals.grandTotalMinorUnits, 180000);
  assert.equal(out.delivery.zone, 'INSIDE_CHITTAGONG');
  assert.equal(out.items[0].sku, 'ABAYA-52');
  assert.equal(out.reservationReference, undefined, 'reservation internals are hidden from customers');
  assert.equal(out._id, undefined);
  assert.equal(out.__v, undefined);
  assert.equal(out.customerId, '507f1f77bcf86cd799439022');
});

test('admin serialization includes reservation ids for traceability', () => {
  const out = serializeAdminOrder(orderDoc());
  assert.deepEqual(out.reservationReference.reservationIds, [
    '507f1f77bcf86cd799439066',
    '507f1f77bcf86cd799439077',
  ]);
  assert.equal(out.reservationReference.referenceType, 'ORDER');
});

test('serializeOrder includeReservations flag governs reservation exposure', () => {
  const withRes = serializeOrder(orderDoc(), { includeReservations: true });
  assert.ok(withRes.reservationReference);
  const without = serializeOrder(orderDoc(), { includeReservations: false });
  assert.equal(without.reservationReference, undefined);
});

test('statusHistory timestamps serialize as ISO strings', () => {
  const out = serializeCustomerOrder(orderDoc());
  assert.equal(out.statusHistory[0].at, '2026-08-08T10:00:00.000Z');
  assert.equal(out.statusHistory[0].by, '507f1f77bcf86cd799439022');
});

test('missing optional fields serialize defensively', () => {
  const minimal = serializeCustomerOrder({
    _id: '507f1f77bcf86cd799439011',
    orderNumber: 'TAQ-X',
    customerId: '507f1f77bcf86cd799439022',
    status: 'PENDING',
    statusHistory: [],
    totals: {},
    delivery: {
      address: {},
      zone: 'OUTSIDE_CHITTAGONG',
      deliveryFeeMinorUnits: 0,
    },
    items: [],
    paymentMethod: 'COD',
    notes: null,
  });
  assert.equal(minimal.statusHistory.length, 0);
  assert.equal(minimal.items.length, 0);
  assert.equal(minimal.totals.grandTotalMinorUnits, undefined);
  assert.equal(minimal.createdAt, null);
});

test('delivery email serializes when present and defaults to null otherwise', () => {
  const base = orderDoc();
  const withEmail = serializeCustomerOrder({
    ...base,
    delivery: {
      ...base.delivery,
      address: { ...base.delivery.address, email: 'guest@example.com' },
    },
  });
  assert.equal(withEmail.delivery.address.email, 'guest@example.com');

  const without = serializeCustomerOrder(orderDoc());
  assert.equal(without.delivery.address.email, null);
});
