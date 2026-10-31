'use strict';

const { REFUND_STATUSES } = require('./refund.constants');

/**
 * Refund state machine (Phase 10, ADR-0018).
 *
 * Reachable transitions:
 *
 *   PENDING → PROCESSED   (staff/admin process; TERMINAL)
 *   PENDING → VOIDED      (staff/admin void; TERMINAL)
 *
 * PROCESSED and VOIDED are terminal and have NO outgoing transition. A refund
 * is created server-side at PENDING inside the return's APPROVED → COMPLETED
 * transaction and is immutable afterwards except for the two terminal
 * transitions. PROCESSING also requires the linked return to remain COMPLETED
 * (guarded in the service).
 *
 * The transition table is the SINGLE source of truth; services derive the
 * allowed-from sets from it, so the state machine cannot drift from the
 * transition guards.
 */

/**
 * Map: target status → the set of source statuses from which it is reachable.
 */
const VALID_TRANSITIONS = Object.freeze({
  [REFUND_STATUSES.PROCESSED]: Object.freeze([REFUND_STATUSES.PENDING]),
  [REFUND_STATUSES.VOIDED]: Object.freeze([REFUND_STATUSES.PENDING]),
});

/**
 * Which actor may perform each transition (both staff/admin only — customers
 * never touch refund records directly).
 */
const TRANSITION_ACTORS = Object.freeze({
  [REFUND_STATUSES.PROCESSED]: Object.freeze(['admin', 'staff']),
  [REFUND_STATUSES.VOIDED]: Object.freeze(['admin', 'staff']),
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
