'use strict';

const { COURIER_STATUSES } = require('./courier.constants');

/**
 * Courier shipment state machine (Phase 09, ADR-0017).
 *
 *   PENDING → ACTIVE                 (submitted to provider)
 *   PENDING → FAILED                 (submit rejected/errored)
 *   PENDING → CANCELLED              (cancelled before dispatch)
 *   FAILED  → ACTIVE                 (retry succeeded)
 *   FAILED  → CANCELLED              (cancelled after failure)
 *   ACTIVE  → DELIVERED              (provider confirmed)
 *   ACTIVE  → CANCELLED              (provider confirmed cancellation)
 *   ACTIVE  → CANCELLATION_FAILED    (cancel refused/errored)
 *   CANCELLATION_FAILED → DELIVERED  (provider reported delivered meanwhile)
 *   CANCELLATION_FAILED → CANCELLED  (retried cancel succeeded)
 *
 * DELIVERED and CANCELLED are terminal: no valid transition reaches them from
 * anywhere except the listed sources, and nothing may leave them.
 *
 * The transition table is the SINGLE source of truth; services derive the
 * allowed-from sets from it, so the state machine cannot drift from the
 * transition guards.
 */

/**
 * Map: target status → the set of source statuses from which it is reachable.
 * Only reachable targets appear; terminal targets have no outgoing entries.
 */
const VALID_TRANSITIONS = Object.freeze({
  [COURIER_STATUSES.ACTIVE]: Object.freeze([
    COURIER_STATUSES.PENDING,
    COURIER_STATUSES.FAILED,
  ]),
  [COURIER_STATUSES.DELIVERED]: Object.freeze([
    COURIER_STATUSES.ACTIVE,
    COURIER_STATUSES.CANCELLATION_FAILED,
  ]),
  [COURIER_STATUSES.CANCELLED]: Object.freeze([
    COURIER_STATUSES.PENDING,
    COURIER_STATUSES.FAILED,
    COURIER_STATUSES.ACTIVE,
    COURIER_STATUSES.CANCELLATION_FAILED,
  ]),
  [COURIER_STATUSES.FAILED]: Object.freeze([COURIER_STATUSES.PENDING]),
  [COURIER_STATUSES.CANCELLATION_FAILED]: Object.freeze([
    COURIER_STATUSES.ACTIVE,
  ]),
});

function canTransition(fromStatus, toStatus) {
  const sources = VALID_TRANSITIONS[toStatus];
  return Boolean(sources && sources.includes(fromStatus));
}

module.exports = {
  VALID_TRANSITIONS,
  canTransition,
};
