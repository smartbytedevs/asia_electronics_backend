'use strict';

const { PAYMENT_STATUSES } = require('./payment.constants');

/**
 * Payment state machine (Phase 08, ADR-0016).
 *
 * Reachable transitions:
 *
 *   UNPAID    → SUBMITTED  (customer first submission; UNPAID has no persisted
 *                           document — the record is created lazily at SUBMITTED)
 *   REJECTED  → SUBMITTED  (customer resubmission)
 *   SUBMITTED → VERIFIED   (staff/admin verify; TERMINAL)
 *   SUBMITTED → REJECTED   (staff/admin reject; mutable via resubmission)
 *
 * VERIFIED is terminal — there is NO transition out of it.
 *
 * The transition table is the SINGLE source of truth; services derive the
 * allowed-from sets from it, so the state machine cannot drift from the
 * transition guards.
 */

/**
 * Map: target status → the set of source statuses from which it is reachable.
 * VERIFIED intentionally appears as a TARGET only (terminal, no entry here).
 */
const VALID_TRANSITIONS = Object.freeze({
  [PAYMENT_STATUSES.SUBMITTED]: Object.freeze([
    PAYMENT_STATUSES.UNPAID,
    PAYMENT_STATUSES.REJECTED,
  ]),
  [PAYMENT_STATUSES.VERIFIED]: Object.freeze([PAYMENT_STATUSES.SUBMITTED]),
  [PAYMENT_STATUSES.REJECTED]: Object.freeze([PAYMENT_STATUSES.SUBMITTED]),
});

/**
 * Which actor may perform each transition. `customer` transitions are strictly
 * own-order (enforced by the payment service scoping). Staff/admin drive the
 * review transitions; customers can never move SUBMITTED → VERIFIED/REJECTED.
 */
const TRANSITION_ACTORS = Object.freeze({
  [PAYMENT_STATUSES.SUBMITTED]: Object.freeze(['customer']),
  [PAYMENT_STATUSES.VERIFIED]: Object.freeze(['admin', 'staff']),
  [PAYMENT_STATUSES.REJECTED]: Object.freeze(['admin', 'staff']),
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
