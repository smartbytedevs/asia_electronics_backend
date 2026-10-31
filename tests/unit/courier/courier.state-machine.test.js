'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { canTransition, VALID_TRANSITIONS } = require('../../../src/modules/courier/courier.state-machine');
const { COURIER_STATUSES } = require('../../../src/modules/courier/courier.constants');

test('forward path transitions are valid', () => {
  assert.equal(canTransition(COURIER_STATUSES.PENDING, COURIER_STATUSES.ACTIVE), true);
  assert.equal(canTransition(COURIER_STATUSES.FAILED, COURIER_STATUSES.ACTIVE), true);
  assert.equal(canTransition(COURIER_STATUSES.ACTIVE, COURIER_STATUSES.DELIVERED), true);
  assert.equal(canTransition(COURIER_STATUSES.CANCELLATION_FAILED, COURIER_STATUSES.DELIVERED), true);
});

test('cancellation transitions are valid', () => {
  assert.equal(canTransition(COURIER_STATUSES.PENDING, COURIER_STATUSES.CANCELLED), true);
  assert.equal(canTransition(COURIER_STATUSES.FAILED, COURIER_STATUSES.CANCELLED), true);
  assert.equal(canTransition(COURIER_STATUSES.ACTIVE, COURIER_STATUSES.CANCELLED), true);
  assert.equal(canTransition(COURIER_STATUSES.CANCELLATION_FAILED, COURIER_STATUSES.CANCELLED), true);
  assert.equal(canTransition(COURIER_STATUSES.ACTIVE, COURIER_STATUSES.CANCELLATION_FAILED), true);
});

test('terminal statuses have no outgoing transitions', () => {
  for (const status of [COURIER_STATUSES.DELIVERED, COURIER_STATUSES.CANCELLED]) {
    assert.equal(canTransition(status, COURIER_STATUSES.ACTIVE), false);
    assert.equal(canTransition(status, COURIER_STATUSES.CANCELLED), false);
    assert.equal(canTransition(status, COURIER_STATUSES.DELIVERED), false);
  }
});

test('invalid source/target combinations are rejected', () => {
  assert.equal(canTransition(COURIER_STATUSES.PENDING, COURIER_STATUSES.DELIVERED), false);
  assert.equal(canTransition(COURIER_STATUSES.DELIVERED, COURIER_STATUSES.DELIVERED), false);
  assert.equal(canTransition(COURIER_STATUSES.ACTIVE, COURIER_STATUSES.ACTIVE), false);
  assert.equal(canTransition(COURIER_STATUSES.PENDING, COURIER_STATUSES.CANCELLATION_FAILED), false);
});

test('every listed transition is bidirectional-consistent with the table', () => {
  const targets = Object.keys(VALID_TRANSITIONS);
  for (const toStatus of targets) {
    for (const fromStatus of VALID_TRANSITIONS[toStatus]) {
      assert.equal(canTransition(fromStatus, toStatus), true);
    }
  }
});
