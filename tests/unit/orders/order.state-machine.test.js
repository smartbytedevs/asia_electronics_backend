'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  VALID_TRANSITIONS,
  TRANSITION_ACTORS,
  canTransition,
} = require('../../../src/modules/orders/order.state-machine');
const {
  ORDER_STATUSES,
  REACHABLE_ORDER_STATUSES,
  RESERVED_ORDER_STATUSES,
} = require('../../../src/modules/orders/order.constants');

test('every reachable forward transition is allowed', () => {
  assert.equal(canTransition(ORDER_STATUSES.PENDING, ORDER_STATUSES.CONFIRMED), true);
  assert.equal(canTransition(ORDER_STATUSES.CONFIRMED, ORDER_STATUSES.PROCESSING), true);
  assert.equal(canTransition(ORDER_STATUSES.CONFIRMED, ORDER_STATUSES.DISPATCHED), true);
  assert.equal(canTransition(ORDER_STATUSES.PROCESSING, ORDER_STATUSES.DISPATCHED), true);
  assert.equal(canTransition(ORDER_STATUSES.DISPATCHED, ORDER_STATUSES.SHIPPED), true);
  assert.equal(canTransition(ORDER_STATUSES.SHIPPED, ORDER_STATUSES.DELIVERED), true);
  assert.equal(canTransition(ORDER_STATUSES.DELIVERED, ORDER_STATUSES.COMPLETED), true);
});

test('courier-confirmed DELIVERED is NOT reachable — delivery is staff/admin from SHIPPED only', () => {
  assert.equal(canTransition(ORDER_STATUSES.SHIPPED, ORDER_STATUSES.DELIVERED), true);
  assert.equal(canTransition(ORDER_STATUSES.PROCESSING, ORDER_STATUSES.DELIVERED), false);
  assert.equal(canTransition(ORDER_STATUSES.CONFIRMED, ORDER_STATUSES.DELIVERED), false);
  assert.equal(canTransition(ORDER_STATUSES.PENDING, ORDER_STATUSES.DELIVERED), false);
  assert.equal(canTransition(ORDER_STATUSES.DELIVERED, ORDER_STATUSES.DELIVERED), false);
});

test('SHIPPED → RETURNED is allowed; RETURNED is reachable only from SHIPPED', () => {
  assert.equal(canTransition(ORDER_STATUSES.SHIPPED, ORDER_STATUSES.RETURNED), true);
  assert.equal(canTransition(ORDER_STATUSES.DISPATCHED, ORDER_STATUSES.RETURNED), false);
  assert.equal(canTransition(ORDER_STATUSES.DELIVERED, ORDER_STATUSES.RETURNED), false);
});

test('terminal transitions are allowed exactly from their reachable sources', () => {
  assert.equal(canTransition(ORDER_STATUSES.PENDING, ORDER_STATUSES.REJECTED), true);
  assert.equal(canTransition(ORDER_STATUSES.CONFIRMED, ORDER_STATUSES.REJECTED), false);

  assert.equal(canTransition(ORDER_STATUSES.PENDING, ORDER_STATUSES.CANCELLED), true);
  assert.equal(canTransition(ORDER_STATUSES.CONFIRMED, ORDER_STATUSES.CANCELLED), true);
  assert.equal(canTransition(ORDER_STATUSES.PROCESSING, ORDER_STATUSES.CANCELLED), true);
  assert.equal(canTransition(ORDER_STATUSES.DISPATCHED, ORDER_STATUSES.CANCELLED), true);
  assert.equal(canTransition(ORDER_STATUSES.SHIPPED, ORDER_STATUSES.CANCELLED), true);
  assert.equal(canTransition(ORDER_STATUSES.REJECTED, ORDER_STATUSES.CANCELLED), false);
});

test('DELIVERED and COMPLETED are terminal and cannot be cancelled', () => {
  assert.equal(canTransition(ORDER_STATUSES.DELIVERED, ORDER_STATUSES.CANCELLED), false);
  assert.equal(canTransition(ORDER_STATUSES.COMPLETED, ORDER_STATUSES.CANCELLED), false);
  assert.equal(canTransition(ORDER_STATUSES.DELIVERED, ORDER_STATUSES.DELIVERED), false);
  assert.equal(canTransition(ORDER_STATUSES.COMPLETED, ORDER_STATUSES.COMPLETED), false);
});

test('the state machine is acyclic for reachable states', () => {
  for (const to of Object.keys(VALID_TRANSITIONS)) {
    for (const from of Object.keys(VALID_TRANSITIONS)) {
      if (canTransition(from, to)) {
        assert.equal(
          canTransition(to, from),
          false,
          `${from} -> ${to} must not have a reverse edge`
        );
      }
    }
  }
});

test('reserved (future-phase) states have no valid transition', () => {
  for (const reserved of RESERVED_ORDER_STATUSES) {
    for (const from of [...REACHABLE_ORDER_STATUSES, ...RESERVED_ORDER_STATUSES]) {
      assert.equal(canTransition(from, reserved), false, `${from} -> ${reserved} must be blocked`);
    }
  }
});

test('unknown statuses are never transitionable', () => {
  assert.equal(canTransition('UNKNOWN', ORDER_STATUSES.CONFIRMED), false);
  assert.equal(canTransition(ORDER_STATUSES.PENDING, 'UNKNOWN'), false);
  assert.equal(canTransition(undefined, ORDER_STATUSES.CONFIRMED), false);
});

test('confirm/process/complete/reject/return are admin+staff; dispatch is courier; cancel is customer+admin', () => {
  assert.deepEqual(TRANSITION_ACTORS[ORDER_STATUSES.CONFIRMED], ['admin', 'staff']);
  assert.deepEqual(TRANSITION_ACTORS[ORDER_STATUSES.PROCESSING], ['admin', 'staff']);
  assert.deepEqual(TRANSITION_ACTORS[ORDER_STATUSES.DISPATCHED], ['courier']);
  assert.deepEqual(TRANSITION_ACTORS[ORDER_STATUSES.SHIPPED], ['admin', 'staff']);
  assert.deepEqual(TRANSITION_ACTORS[ORDER_STATUSES.DELIVERED], ['admin', 'staff']);
  assert.deepEqual(TRANSITION_ACTORS[ORDER_STATUSES.COMPLETED], ['admin', 'staff']);
  assert.deepEqual(TRANSITION_ACTORS[ORDER_STATUSES.REJECTED], ['admin', 'staff']);
  assert.deepEqual(TRANSITION_ACTORS[ORDER_STATUSES.CANCELLED], ['customer', 'admin']);
  assert.deepEqual(TRANSITION_ACTORS[ORDER_STATUSES.RETURNED], ['admin', 'staff']);
});
