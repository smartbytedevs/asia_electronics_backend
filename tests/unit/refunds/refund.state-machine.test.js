'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { REFUND_STATUSES } = require('../../../src/modules/refunds/refund.constants');
const {
  VALID_TRANSITIONS,
  TRANSITION_ACTORS,
  canTransition,
} = require('../../../src/modules/refunds/refund.state-machine');

const S = REFUND_STATUSES;

test('valid transitions match the documented table', () => {
  assert.deepEqual(VALID_TRANSITIONS[S.PROCESSED], [S.PENDING]);
  assert.deepEqual(VALID_TRANSITIONS[S.VOIDED], [S.PENDING]);
});

test('canTransition accepts only documented moves', () => {
  assert.equal(canTransition(S.PENDING, S.PROCESSED), true);
  assert.equal(canTransition(S.PENDING, S.VOIDED), true);
});

test('PROCESSED and VOIDED are terminal: no transition out of them', () => {
  for (const terminal of [S.PROCESSED, S.VOIDED]) {
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
  assert.equal(canTransition(S.PROCESSED, S.VOIDED), false);
  assert.equal(canTransition(S.VOIDED, S.PROCESSED), false);
});

test('actors match the machine: only staff/admin touch refunds', () => {
  assert.deepEqual(TRANSITION_ACTORS[S.PROCESSED], ['admin', 'staff']);
  assert.deepEqual(TRANSITION_ACTORS[S.VOIDED], ['admin', 'staff']);
});
