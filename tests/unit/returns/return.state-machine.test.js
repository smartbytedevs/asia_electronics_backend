'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { RETURN_STATUSES } = require('../../../src/modules/returns/return.constants');
const {
  VALID_TRANSITIONS,
  TRANSITION_ACTORS,
  canTransition,
} = require('../../../src/modules/returns/return.state-machine');

const S = RETURN_STATUSES;

test('valid transitions match the documented table', () => {
  assert.deepEqual(VALID_TRANSITIONS[S.APPROVED], [S.PENDING]);
  assert.deepEqual(VALID_TRANSITIONS[S.REJECTED], [S.PENDING]);
  assert.deepEqual(VALID_TRANSITIONS[S.COMPLETED], [S.APPROVED]);
  assert.deepEqual(VALID_TRANSITIONS[S.CANCELLED], [S.PENDING, S.APPROVED]);
});

test('canTransition accepts only documented moves', () => {
  assert.equal(canTransition(S.PENDING, S.APPROVED), true);
  assert.equal(canTransition(S.PENDING, S.REJECTED), true);
  assert.equal(canTransition(S.PENDING, S.CANCELLED), true);
  assert.equal(canTransition(S.APPROVED, S.COMPLETED), true);
  assert.equal(canTransition(S.APPROVED, S.CANCELLED), true);
});

test('COMPLETED and REJECTED are terminal: no transition out of them', () => {
  for (const terminal of [S.COMPLETED, S.REJECTED]) {
    for (const target of Object.values(S)) {
      assert.equal(
        canTransition(terminal, target),
        false,
        `${terminal} -> ${target} must be forbidden`
      );
    }
  }
});

test('illegal transitions are forbidden', () => {
  assert.equal(canTransition(S.PENDING, S.PENDING), false);
  assert.equal(canTransition(S.PENDING, S.COMPLETED), false);
  assert.equal(canTransition(S.APPROVED, S.APPROVED), false);
  assert.equal(canTransition(S.APPROVED, S.REJECTED), false);
  assert.equal(canTransition(S.REJECTED, S.CANCELLED), false);
  assert.equal(canTransition(S.COMPLETED, S.CANCELLED), false);
  assert.equal(canTransition(S.CANCELLED, S.CANCELLED), false);
  assert.equal(canTransition(S.CANCELLED, S.PENDING), false);
});

test('actors match the machine: customer submits/cancels, staff/admin review', () => {
  assert.deepEqual(TRANSITION_ACTORS[S.APPROVED], ['admin', 'staff']);
  assert.deepEqual(TRANSITION_ACTORS[S.REJECTED], ['admin', 'staff']);
  assert.deepEqual(TRANSITION_ACTORS[S.COMPLETED], ['admin', 'staff']);
  assert.deepEqual(TRANSITION_ACTORS[S.CANCELLED], ['customer', 'admin', 'staff']);
});
