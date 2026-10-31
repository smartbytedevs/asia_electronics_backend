'use strict';

const { REVIEW_STATUSES } = require('./review.constants');

/**
 * Review state machine.
 *
 * Reachable transitions (admin moderation):
 *
 *   PENDING → APPROVED  (admin approve; TERMINAL)
 *   PENDING → REJECTED  (admin reject; TERMINAL)
 *
 * There is deliberately NO moderation reversal: a REJECTED review cannot be
 * approved and an APPROVED review cannot be rejected (the customer would
 * submit a fresh review instead). The transition table is the SINGLE source of
 * truth; services derive the allowed-from sets from it, so the state machine
 * cannot drift from the transition guards.
 */

const VALID_TRANSITIONS = Object.freeze({
  [REVIEW_STATUSES.APPROVED]: Object.freeze([REVIEW_STATUSES.PENDING]),
  [REVIEW_STATUSES.REJECTED]: Object.freeze([REVIEW_STATUSES.PENDING]),
});

/**
 * Which actor may perform each transition. Customers can never approve or
 * reject reviews; moderation is ADMIN-only (enforced additionally by the
 * route's `authorizeRoles(ROLES.ADMIN)`).
 */
const TRANSITION_ACTORS = Object.freeze({
  [REVIEW_STATUSES.APPROVED]: Object.freeze(['admin']),
  [REVIEW_STATUSES.REJECTED]: Object.freeze(['admin']),
});

function canTransition(fromStatus, toStatus) {
  const sources = VALID_TRANSITIONS[toStatus];
  return Boolean(sources && sources.includes(fromStatus));
}

module.exports = {
  VALID_TRANSITIONS,
  TRANSITION_ACTORS,
  canTransition,
};
