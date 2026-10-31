'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  PAYMENT_STATUSES,
} = require('../../../src/modules/payments/payment.constants');
const {
  VALID_TRANSITIONS,
  TRANSITION_ACTORS,
  canTransition,
} = require('../../../src/modules/payments/payment.state-machine');

const S = PAYMENT_STATUSES;

test('valid transitions match the documented table', () => {
  assert.deepEqual(VALID_TRANSITIONS[S.SUBMITTED], [S.UNPAID, S.REJECTED]);
  assert.deepEqual(VALID_TRANSITIONS[S.VERIFIED], [S.SUBMITTED]);
  assert.deepEqual(VALID_TRANSITIONS[S.REJECTED], [S.SUBMITTED]);
});

test('canTransition accepts only documented moves', () => {
  assert.equal(canTransition(S.UNPAID, S.SUBMITTED), true, 'first submission');
  assert.equal(canTransition(S.REJECTED, S.SUBMITTED), true, 'resubmission');
  assert.equal(canTransition(S.SUBMITTED, S.VERIFIED), true);
  assert.equal(canTransition(S.SUBMITTED, S.REJECTED), true);
});

test('VERIFIED is terminal: no transition out of it', () => {
  for (const target of Object.values(S)) {
    assert.equal(
      canTransition(S.VERIFIED, target),
      false,
      `VERIFIED -> ${target} must be forbidden`
    );
  }
});

test('reserved/illegal transitions are forbidden', () => {
  assert.equal(canTransition(S.UNPAID, S.VERIFIED), false);
  assert.equal(canTransition(S.UNPAID, S.REJECTED), false);
  assert.equal(canTransition(S.REJECTED, S.VERIFIED), false);
  assert.equal(canTransition(S.REJECTED, S.REJECTED), false);
  assert.equal(canTransition(S.SUBMITTED, S.SUBMITTED), false);
});

test('actors match the machine: customers submit, staff/admin review', () => {
  assert.deepEqual(TRANSITION_ACTORS[S.SUBMITTED], ['customer']);
  assert.deepEqual(TRANSITION_ACTORS[S.VERIFIED], ['admin', 'staff']);
  assert.deepEqual(TRANSITION_ACTORS[S.REJECTED], ['admin', 'staff']);
});
