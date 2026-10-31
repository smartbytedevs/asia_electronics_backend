'use strict';

const { RETURN_STATUSES } = require('./return.constants');

/**
 * Return state machine (Phase 10, ADR-0018).
 *
 * Reachable transitions:
 *
 *   PENDING  → APPROVED   (staff/admin approve)
 *   PENDING  → REJECTED   (staff/admin reject; terminal)
 *   PENDING  → CANCELLED  (customer own / admin; terminal)
 *   APPROVED → COMPLETED  (staff/admin complete; terminal)
 *   APPROVED → CANCELLED  (admin; terminal)
 *
 * COMPLETED and REJECTED are terminal and have NO outgoing transition; the
 * refund/restock side effects happen ONLY inside the APPROVED → COMPLETED
 * transaction, so no other transition has a side effect to undo.
 *
 * The transition table is the SINGLE source of truth; services derive the
 * allowed-from sets from it, so the state machine cannot drift from the
 * transition guards.
 */

/**
 * Map: target status → the set of source statuses from which it is reachable.
 */
const VALID_TRANSITIONS = Object.freeze({
  [RETURN_STATUSES.APPROVED]: Object.freeze([RETURN_STATUSES.PENDING]),
  [RETURN_STATUSES.REJECTED]: Object.freeze([RETURN_STATUSES.PENDING]),
  [RETURN_STATUSES.COMPLETED]: Object.freeze([RETURN_STATUSES.APPROVED]),
  [RETURN_STATUSES.CANCELLED]: Object.freeze([
    RETURN_STATUSES.PENDING,
    RETURN_STATUSES.APPROVED,
  ]),
});

/**
 * Which actor may perform each transition. `customer` transitions are also
 * allowed for admin/staff (cancelling via the admin surface); the
 * customer-facing cancel is restricted to their own PENDING return by the
 * customer return service.
 */
const TRANSITION_ACTORS = Object.freeze({
  [RETURN_STATUSES.APPROVED]: Object.freeze(['admin', 'staff']),
  [RETURN_STATUSES.REJECTED]: Object.freeze(['admin', 'staff']),
  [RETURN_STATUSES.COMPLETED]: Object.freeze(['admin', 'staff']),
  [RETURN_STATUSES.CANCELLED]: Object.freeze(['customer', 'admin', 'staff']),
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
