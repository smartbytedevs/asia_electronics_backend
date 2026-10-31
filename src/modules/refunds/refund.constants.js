'use strict';

const { PAYMENT_METHODS } = require('../orders/order.constants');

/**
 * Refund constants (Phase 10, ADR-0018).
 *
 * A refund is the financial record for an accepted, COMPLETED return. It is
 * auto-created (at PENDING) inside the return's APPROVED → COMPLETED
 * transaction, with a SERVER-DERIVED amount (Σ per-unit charged × returned
 * quantity, from the return's embedded item snapshots — no delivery-fee
 * refunds). The refund NEVER mutates the original Payment or Order documents.
 *
 * All money is INTEGER MINOR UNITS (paisa).
 */

/**
 * Refund status machine. Reachable states:
 *
 *   PENDING   → PROCESSED   (staff/admin process; TERMINAL)
 *   PENDING   → VOIDED      (staff/admin void; TERMINAL)
 *
 * PENDING refunds are created server-side on return COMPLETION. PROCESSING a
 * refund additionally requires the linked return to be COMPLETED.
 */
const REFUND_STATUSES = Object.freeze({
  PENDING: 'PENDING',
  PROCESSED: 'PROCESSED',
  VOIDED: 'VOIDED',
});

const REFUND_STATUS_VALUES = Object.freeze(Object.values(REFUND_STATUSES));

const REFUND_LIMITS = Object.freeze({
  NOTES_MAX: 1000,
  NOTE_MAX: 500,
  REFUND_NUMBER_PREFIX: 'RFD-',
  REFUND_NUMBER_SEQUENCE_WIDTH: 6,
  REFUND_NUMBER_RETRIES: 5,
});

/**
 * Whitelist of every client-writable refund review field (process/void body).
 * status/actor/amount/identity fields are ALWAYS server-derived and rejected.
 */
const REFUND_INPUT_FIELDS = Object.freeze(['note']);

/**
 * The payment method snapshot stored on the refund. For a MANUAL order the
 * refund references the verified Payment record; for COD (`paymentId: null`)
 * no captured payment exists and the refund is informational.
 */
const REFUND_PAYMENT_METHODS = Object.freeze({
  MANUAL: PAYMENT_METHODS.MANUAL,
  COD: PAYMENT_METHODS.COD,
});

const REFUND_MESSAGES = Object.freeze({
  REFUNDS_FETCHED: 'Refunds retrieved successfully',
  REFUND_FETCHED: 'Refund retrieved successfully',
  REFUND_PROCESSED: 'Refund processed successfully',
  REFUND_VOIDED: 'Refund voided successfully',
  REFUND_NOT_FOUND: 'Refund not found',
  REFUND_INVALID_STATE: 'Refund is in an invalid state for this operation',
  REFUND_RETURN_NOT_COMPLETED: 'Refund requires the linked return to be completed',
  INVALID_REFUND: 'Invalid refund data',
  INVALID_STATUS: 'status must be one of: PENDING, PROCESSED, VOIDED',
  REFUND_NUMBER_GENERATION_FAILED: 'Could not generate a unique refund number',
});

module.exports = {
  REFUND_STATUSES,
  REFUND_STATUS_VALUES,
  REFUND_LIMITS,
  REFUND_INPUT_FIELDS,
  REFUND_PAYMENT_METHODS,
  REFUND_MESSAGES,
};
