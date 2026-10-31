'use strict';

const { ORDER_STATUSES } = require('../orders/order.constants');

/**
 * Return constants (Phase 10, ADR-0018).
 *
 * Returns are a SEPARATE state machine, deliberately DECOUPLED from the order
 * state machine: the return service NEVER mutates the Order document, and the
 * order-level RETURN_REQUESTED / RETURNED statuses remain reserved and
 * unreachable (see ADR-0018 and docs/return-state-machine.md).
 *
 * A return can be started for an order that is CONFIRMED or PROCESSING, within
 * RETURN_LIMITS.ELIGIBLE_DAYS of `order.createdAt` (there is no delivered
 * anchor in the current order machine). Money is INTEGER MINOR UNITS (paisa);
 * return items snapshot the order item prices so the refund amount is provable
 * without re-reading the catalog.
 */

/**
 * Return status machine. Reachable states:
 *
 *   PENDING  → APPROVED    (staff/admin approve)
 *   PENDING  → REJECTED    (staff/admin reject; TERMINAL)
 *   PENDING  → CANCELLED   (customer own / admin; TERMINAL)
 *   APPROVED → COMPLETED   (staff/admin complete → stock restocked + refund
 *                           created in the SAME transaction; TERMINAL)
 *   APPROVED → CANCELLED   (admin; TERMINAL — no refund exists yet because the
 *                           refund is created on COMPLETION, not approval)
 *
 * REFUND / restock side effects happen ONLY on COMPLETED (never on approval),
 * so cancelling an APPROVED return has nothing to undo.
 */
const RETURN_STATUSES = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
});

const RETURN_STATUS_VALUES = Object.freeze(Object.values(RETURN_STATUSES));

/**
 * Return statuses that "claim" an order item's quantity for duplicate
 * prevention: available = orderItem.quantity − claimed (PENDING, APPROVED, and
 * COMPLETED all reduce what may be returned again). REJECTED and CANCELLED
 * release their claim (they never restocked).
 */
const RETURN_CLAIMED_STATUSES = Object.freeze([
  RETURN_STATUSES.PENDING,
  RETURN_STATUSES.APPROVED,
  RETURN_STATUSES.COMPLETED,
]);

/**
 * Order statuses eligible to start a return. Server-derived; the customer can
 * never supply or override this.
 */
const RETURN_ELIGIBLE_ORDER_STATUSES = Object.freeze([
  ORDER_STATUSES.CONFIRMED,
  ORDER_STATUSES.PROCESSING,
]);

const RETURN_LIMITS = Object.freeze({
  REASON_MAX: 500,
  NOTES_MAX: 1000,
  NOTE_MAX: 500,
  IDEMPOTENCY_KEY_MAX: 100,
  ITEMS_MAX: 50,
  QUANTITY_MAX: 9999,
  RETURN_NUMBER_PREFIX: 'RET-',
  RETURN_NUMBER_SEQUENCE_WIDTH: 6,
  RETURN_NUMBER_RETRIES: 5,
  ELIGIBLE_DAYS: 30,
});

/**
 * Whitelist of every client-writable return-request field. `reason` and
 * `items` are required; `notes` is optional. status/actor/amount/identity
 * fields (`customerId`, `userId`, `orderId`, `returnNumber`, `status`,
 * refund/refundId, ...) are ALWAYS server-derived and rejected.
 */
const RETURN_INPUT_FIELDS = Object.freeze(['reason', 'items', 'notes']);

/**
 * Whitelist of every client-writable field inside a single return item.
 * `orderItemId` links to the immutable OrderItem snapshot; `quantity` is the
 * positive integer being returned. All other item fields (prices, sku, ...)
 * are snapshotted server-side from the order.
 */
const RETURN_ITEM_INPUT_FIELDS = Object.freeze(['orderItemId', 'quantity']);

const RETURN_MESSAGES = Object.freeze({
  RETURN_CREATED: 'Return request submitted successfully',
  RETURNS_FETCHED: 'Returns retrieved successfully',
  RETURN_FETCHED: 'Return retrieved successfully',
  RETURN_APPROVED: 'Return approved successfully',
  RETURN_REJECTED: 'Return rejected successfully',
  RETURN_COMPLETED: 'Return completed successfully',
  RETURN_CANCELLED: 'Return cancelled successfully',
  RETURN_NOT_FOUND: 'Return not found',
  RETURN_NOT_ELIGIBLE: 'This order is not eligible for a return',
  RETURN_WINDOW_EXPIRED: 'The return window for this order has expired',
  RETURN_INVALID_STATE: 'Return is in an invalid state for this operation',
  RETURN_ITEM_NOT_FOUND: 'One or more requested items do not belong to this order',
  RETURN_QUANTITY_EXCEEDED: 'Requested return quantity exceeds the available quantity',
  RETURN_ITEM_DUPLICATE: 'Each order item may appear only once in a return request',
  IDEMPOTENCY_CONFLICT: 'Idempotency-Key conflict: a different return was already created with this key',
  IDEMPOTENCY_KEY_REQUIRED: 'Idempotency-Key header is required to submit a return',
  RETURN_NUMBER_GENERATION_FAILED: 'Could not generate a unique return number',
  INVALID_STATUS: 'status must be one of: PENDING, APPROVED, REJECTED, COMPLETED, CANCELLED',
});

module.exports = {
  RETURN_STATUSES,
  RETURN_STATUS_VALUES,
  RETURN_CLAIMED_STATUSES,
  RETURN_ELIGIBLE_ORDER_STATUSES,
  RETURN_LIMITS,
  RETURN_INPUT_FIELDS,
  RETURN_ITEM_INPUT_FIELDS,
  RETURN_MESSAGES,
};
