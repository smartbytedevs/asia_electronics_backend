'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const mapper = require('../../../src/modules/courier/pathao/pathao.mapper');
const { COURIER_STATUSES } = require('../../../src/modules/courier/courier.constants');

test('normalizeBdPhone converts to the 11-digit local form', () => {
  assert.equal(mapper.normalizeBdPhone('01712345678'), '01712345678');
  assert.equal(mapper.normalizeBdPhone('8801712345678'), '01712345678');
  assert.equal(mapper.normalizeBdPhone('+8801712345678'), '01712345678');
  assert.equal(mapper.normalizeBdPhone('01 712-345 678'), '01712345678');
});

test('clampWeight bounds the parcel weight to the Pathao range', () => {
  assert.equal(mapper.clampWeight(0.1), 0.5);
  assert.equal(mapper.clampWeight(1.5), 1.5);
  assert.equal(mapper.clampWeight(50), 10);
  assert.equal(mapper.clampWeight('nope'), 0.5);
});

test('buildCreateOrderPayload maps the generic payload to Pathao fields', () => {
  const body = mapper.buildCreateOrderPayload({
    storeId: '123',
    payload: {
      merchantReference: 'TAQ-20260808-000001',
      recipientName: 'Ayesha Siddiqua',
      recipientPhone: '+8801712345678',
      recipientAddress: 'House 12, GEC, Chattogram, Chattogram, 4000, BD',
      itemDescription: 'Abaya x2',
      specialInstruction: 'Call before delivery',
      itemQuantity: 2,
      itemWeightKg: 0.8,
      deliveryType: 'NORMAL',
      amountToCollectMinorUnits: 100000,
    },
  });

  assert.equal(body.store_id, 123);
  assert.equal(body.merchant_order_id, 'TAQ-20260808-000001');
  assert.equal(body.recipient_phone, '01712345678');
  assert.equal(body.delivery_type, 48);
  assert.equal(body.item_type, 2);
  assert.equal(body.item_quantity, 2);
  assert.equal(body.item_weight, 0.8);
  assert.equal(body.amount_to_collect, 1000);
  assert.equal(body.special_instruction, 'Call before delivery');
});

test('buildCreateOrderPayload omits special_instruction when absent', () => {
  const body = mapper.buildCreateOrderPayload({
    storeId: 1,
    payload: { merchantReference: 'R1', recipientName: 'N', recipientPhone: '0171', recipientAddress: 'A', itemQuantity: 1, itemWeightKg: 1 },
  });
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'special_instruction'), false);
});

test('mapSubmitResult normalizes the Pathao create response into minor units', () => {
  const result = mapper.mapSubmitResult({
    data: { consignment_id: 42, order_status: 'Pending', delivery_fee: 60 },
  });
  assert.equal(result.consignmentId, '42');
  assert.equal(result.providerDeliveryFeeMinorUnits, 6000);
  assert.equal(result.providerStatus, 'Pending');
});

test('mapStatusResult parses Pathao timestamps', () => {
  const result = mapper.mapStatusResult({
    data: { order_status: 'Out for Delivery', order_status_updated_at: '2026-08-08 10:30:00' },
  });
  assert.equal(result.providerStatus, 'Out for Delivery');
  assert.equal(result.providerStatusUpdatedAt.toISOString(), '2026-08-08T10:30:00.000Z');
});

test('mapProviderStatus maps labels conservatively', () => {
  assert.equal(mapper.mapProviderStatus('Delivered'), COURIER_STATUSES.DELIVERED);
  assert.equal(mapper.mapProviderStatus('Cancelled'), COURIER_STATUSES.CANCELLED);
  assert.equal(mapper.mapProviderStatus('Pending'), COURIER_STATUSES.ACTIVE);
  assert.equal(mapper.mapProviderStatus('Out for Delivery'), COURIER_STATUSES.ACTIVE);
  assert.equal(mapper.mapProviderStatus('Return'), COURIER_STATUSES.ACTIVE);
  // Only confirmed 'cancelled'/'delivered' labels are terminal — exceptions stay ACTIVE.
  assert.equal(mapper.mapProviderStatus('Cancellation'), COURIER_STATUSES.ACTIVE);
  assert.equal(mapper.mapProviderStatus(null), COURIER_STATUSES.ACTIVE);
});
