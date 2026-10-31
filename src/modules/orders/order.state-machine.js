'use strict';

const { ORDER_STATUSES } = require('./order.constants');

/**
 * Order state machine (Phase 07, ADR-0015).
 *
 * The Order status is the SINGLE source of truth. Reachable transitions:
 *
 *   PENDING     → CONFIRMED  (staff/admin confirm)
 *   CONFIRMED   → PROCESSING (staff/admin process)
 *   CONFIRMED   → DISPATCHED (successful courier dispatch)
 *   PROCESSING  → DISPATCHED (successful courier dispatch)
 *   DISPATCHED  → SHIPPED    (staff/admin ship)
 *   SHIPPED     → DELIVERED  (staff/admin deliver)
 *   DELIVERED   → COMPLETED  (staff/admin complete)
 *   SHIPPED     → RETURNED   (staff/admin return; released)
 *   PENDING     → REJECTED   (staff/admin reject; terminal)
 *   PENDING | CONFIRMED | PROCESSING | DISPATCHED | SHIPPED → CANCELLED
 *                            (customer / admin cancel; terminal)
 *
 * Pathao status updates (webhook / reconciliation) change the CourierShipment
 * status — NEVER the Order status. DELIVERED / COMPLETED are terminal and
 * cannot be cancelled. RETURN_REQUESTED is RESERVED for a future returns phase
 * and has NO valid transition — any attempt surfaces ORDER_INVALID_STATE.
 *
 * The transition table is the SINGLE source of truth; services derive the
 * allowed-from sets from it, so the state machine cannot drift from the
 * transition guards.
 */

/**
 * Map: target status → the set of source statuses from which it is reachable.
 * Only reachable targets appear; reserved targets are intentionally absent
 * (no valid transition → ORDER_INVALID_STATE).
 */
const VALID_TRANSITIONS = Object.freeze({
  [ORDER_STATUSES.CONFIRMED]: Object.freeze([ORDER_STATUSES.PENDING]),
  [ORDER_STATUSES.PROCESSING]: Object.freeze([ORDER_STATUSES.CONFIRMED]),
  [ORDER_STATUSES.DISPATCHED]: Object.freeze([
    ORDER_STATUSES.CONFIRMED,
    ORDER_STATUSES.PROCESSING,
  ]),
  [ORDER_STATUSES.SHIPPED]: Object.freeze([ORDER_STATUSES.DISPATCHED]),
  [ORDER_STATUSES.DELIVERED]: Object.freeze([ORDER_STATUSES.SHIPPED]),
  [ORDER_STATUSES.COMPLETED]: Object.freeze([ORDER_STATUSES.DELIVERED]),
  [ORDER_STATUSES.REJECTED]: Object.freeze([ORDER_STATUSES.PENDING]),
  [ORDER_STATUSES.CANCELLED]: Object.freeze([
    ORDER_STATUSES.PENDING,
    ORDER_STATUSES.CONFIRMED,
    ORDER_STATUSES.PROCESSING,
    ORDER_STATUSES.DISPATCHED,
    ORDER_STATUSES.SHIPPED,
  ]),
  [ORDER_STATUSES.RETURNED]: Object.freeze([ORDER_STATUSES.SHIPPED]),
});

/**
 * Which actor may perform each transition. `customer` transitions are also
 * allowed for admin (a staff/admin cancelling via the admin surface); the
 * customer-facing cancel is restricted by the customer order service.
 * DISPATCHED is courier-driven (a successful dispatch), so SHIPPED / DELIVERED
 * are purely staff/admin manual actions — never a courier handoff.
 */
const TRANSITION_ACTORS = Object.freeze({
  [ORDER_STATUSES.CONFIRMED]: Object.freeze(['admin', 'staff']),
  [ORDER_STATUSES.PROCESSING]: Object.freeze(['admin', 'staff']),
  [ORDER_STATUSES.DISPATCHED]: Object.freeze(['courier']),
  [ORDER_STATUSES.SHIPPED]: Object.freeze(['admin', 'staff']),
  [ORDER_STATUSES.DELIVERED]: Object.freeze(['admin', 'staff']),
  [ORDER_STATUSES.COMPLETED]: Object.freeze(['admin', 'staff']),
  [ORDER_STATUSES.REJECTED]: Object.freeze(['admin', 'staff']),
  [ORDER_STATUSES.CANCELLED]: Object.freeze(['customer', 'admin']),
  [ORDER_STATUSES.RETURNED]: Object.freeze(['admin', 'staff']),
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
