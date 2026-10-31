'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { classifyDeliveryZone } = require('../../../src/modules/orders/delivery');
const { DELIVERY_ZONES } = require('../../../src/modules/orders/order.constants');

function address(overrides = {}) {
  return {
    city: 'Chattogram',
    district: 'Chittagong',
    ...overrides,
  };
}

test('Chittagong city + Chittagong district → INSIDE', () => {
  assert.equal(classifyDeliveryZone(address()), DELIVERY_ZONES.INSIDE_CHITTAGONG);
});

test('city/district matching is case-insensitive and ignores surrounding whitespace', () => {
  for (const city of ['Chattogram', 'chattogram', ' CHATTOGRAM ', 'Chittagong', 'CTg']) {
    assert.equal(
      classifyDeliveryZone(address({ city })),
      DELIVERY_ZONES.INSIDE_CHITTAGONG,
      `city="${city}"`
    );
  }
  for (const alias of ['Chittagong', 'ctg', 'chatgaon', 'CHATTOGRAM']) {
    assert.equal(
      classifyDeliveryZone(address({ district: alias })),
      DELIVERY_ZONES.INSIDE_CHITTAGONG,
      `district="${alias}"`
    );
  }
});

test('a Chittagong city with a non-Chittagong district → OUTSIDE', () => {
  assert.equal(
    classifyDeliveryZone(address({ district: 'Dhaka' })),
    DELIVERY_ZONES.OUTSIDE_CHITTAGONG
  );
});

test('a Chittagong district with a non-Chittagong city → OUTSIDE', () => {
  assert.equal(
    classifyDeliveryZone(address({ city: 'Dhaka' })),
    DELIVERY_ZONES.OUTSIDE_CHITTAGONG
  );
});

test('unrelated city + district → OUTSIDE', () => {
  assert.equal(
    classifyDeliveryZone(address({ city: 'Dhaka', district: 'Dhaka' })),
    DELIVERY_ZONES.OUTSIDE_CHITTAGONG
  );
});

test('missing/empty address parts never crash and yield OUTSIDE', () => {
  assert.equal(classifyDeliveryZone(undefined), DELIVERY_ZONES.OUTSIDE_CHITTAGONG);
  assert.equal(classifyDeliveryZone({}), DELIVERY_ZONES.OUTSIDE_CHITTAGONG);
  assert.equal(classifyDeliveryZone({ city: '', district: '' }), DELIVERY_ZONES.OUTSIDE_CHITTAGONG);
});
