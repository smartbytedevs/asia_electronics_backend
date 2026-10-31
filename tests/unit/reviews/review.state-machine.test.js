'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  REVIEW_STATUSES,
} = require('../../../src/modules/reviews/review.constants');
const {
  VALID_TRANSITIONS,
  TRANSITION_ACTORS,
  canTransition,
} = require('../../../src/modules/reviews/review.state-machine');

const S = REVIEW_STATUSES;

test('moderation transitions are PENDING → APPROVED / PENDING → REJECTED only', () => {
  assert.equal(canTransition(S.PENDING, S.APPROVED), true);
  assert.equal(canTransition(S.PENDING, S.REJECTED), true);
});

test('nonsensical transitions are not allowed (no moderation reversal)', () => {
  assert.equal(canTransition(S.REJECTED, S.APPROVED), false);
  assert.equal(canTransition(S.APPROVED, S.REJECTED), false);
  assert.equal(canTransition(S.APPROVED, S.PENDING), false);
  assert.equal(canTransition(S.REJECTED, S.PENDING), false);
  assert.equal(canTransition(S.PENDING, S.PENDING), false);
  assert.equal(canTransition(S.APPROVED, S.APPROVED), false);
  assert.equal(canTransition(S.REJECTED, S.REJECTED), false);
});

test('approve/reject transitions are admin-only', () => {
  assert.deepEqual(TRANSITION_ACTORS[S.APPROVED], ['admin']);
  assert.deepEqual(TRANSITION_ACTORS[S.REJECTED], ['admin']);
});

test('the transition table is the single source of truth', () => {
  assert.deepEqual(Object.keys(VALID_TRANSITIONS).sort(), [S.APPROVED, S.REJECTED].sort());
  for (const target of [S.APPROVED, S.REJECTED]) {
    for (const from of Object.values(S)) {
      assert.equal(
        canTransition(from, target),
        VALID_TRANSITIONS[target].includes(from),
        `canTransition(${from}, ${target}) must match VALID_TRANSITIONS`
      );
    }
  }
});
