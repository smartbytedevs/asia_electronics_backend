'use strict';

/**
 * Payment & payment-method constants (Phase 08, ADR-0016).
 *
 * All payment money is INTEGER MINOR UNITS (paisa) — the same representation as
 * the order totals (ADR-0013/ADR-0015). The expected amount is ALWAYS derived
 * server-side from `order.totals.grandTotalMinorUnits`; the client-submitted
 * amount is compared and must match exactly (partial payments are not
 * supported).
 */

/**
 * Payment status machine. Reachable states:
 *
 *   UNPAID   → SUBMITTED            (customer first submission; UNPAID has no
 *                                    persisted document — the record is created
 *                                    lazily at SUBMITTED)
 *   REJECTED → SUBMITTED            (customer resubmission)
 *   SUBMITTED → VERIFIED            (staff/admin; TERMINAL)
 *   SUBMITTED → REJECTED            (staff/admin; mutable via resubmission)
 */
const PAYMENT_STATUSES = Object.freeze({
  UNPAID: 'UNPAID',
  SUBMITTED: 'SUBMITTED',
  VERIFIED: 'VERIFIED',
  REJECTED: 'REJECTED',
});

const PAYMENT_STATUS_VALUES = Object.freeze(Object.values(PAYMENT_STATUSES));

/**
 * Reachable payment statuses (used by the admin list filter). All values except
 * UNPAID are persisted statuses; UNPAID is documented but never stored.
 */
const REACHABLE_PAYMENT_STATUSES = Object.freeze([
  PAYMENT_STATUSES.SUBMITTED,
  PAYMENT_STATUSES.VERIFIED,
  PAYMENT_STATUSES.REJECTED,
]);

/**
 * Payment-method types. `MANUAL` covers off-platform transfer methods (bKash,
 * bank transfer — order enum `BKASH` / `BANK_TRANSFER`, plus legacy `MANUAL`
 * orders) that are captured via an admin-configured `PaymentMethod` document
 * and a customer-submitted proof. `CARD` represents an online/card gateway
 * payment: it carries no manual transfer metadata and gateway integration is
 * reserved for a future phase.
 */
const PAYMENT_METHOD_TYPES = Object.freeze({
  MANUAL: 'MANUAL',
  CARD: 'CARD',
});

const PAYMENT_METHOD_TYPE_VALUES = Object.freeze(Object.values(PAYMENT_METHOD_TYPES));

const PAYMENT_LIMITS = Object.freeze({
  IDEMPOTENCY_KEY_MAX: 100,
  TRANSACTION_REFERENCE_MAX: 100,
  NOTES_MAX: 1000,
  NOTE_MAX: 500,
  CODE_MIN: 1,
  CODE_MAX: 50,
  CODE_PATTERN: /^[A-Z0-9_]+$/,
  DISPLAY_NAME_MAX: 100,
  METADATA_FIELD_MAX: 200,
  SORT_ORDER_MAX: 100000,
  PROOF_MAX_BYTES: 2 * 1024 * 1024,
  MULTIPART_BODY_MAX_BYTES: 4 * 1024 * 1024,
});

/**
 * Proof media: only these MIME types / extensions / magic bytes are accepted.
 * Everything else (SVG, HTML, JS, PDF, executables, polyglots) is rejected as
 * INVALID_PAYMENT_PROOF.
 */
const PROOF_MEDIA_RULES = Object.freeze({
  // declared Content-Type → allowed file extensions
  'image/jpeg': Object.freeze(['jpg', 'jpeg']),
  'image/png': Object.freeze(['png']),
  'image/webp': Object.freeze(['webp']),
});

/**
 * Whitelist of every client-writable payment-submission multipart text field.
 * `paymentMethodId`, `submittedAmountMinorUnits`, and `transactionReference`
 * are required; `notes` is optional. status/actor/amount/identity fields are
 * ALWAYS server-derived and rejected.
 */
const PAYMENT_SUBMIT_FIELDS = Object.freeze([
  'paymentMethodId',
  'submittedAmountMinorUnits',
  'transactionReference',
  'notes',
]);

/**
 * Whitelist of every client-writable payment-method field (admin surface).
 */
const PAYMENT_METHOD_INPUT_FIELDS = Object.freeze([
  'code',
  'displayName',
  'type',
  'metadata',
  'isActive',
  'sortOrder',
]);

/**
 * Whitelist of every client-writable payment-method metadata field. BANK_TRANSFER
 * uses the full bank set; BKASH uses `accountName`, `accountNumber` (the mobile
 * number) and `instructions`; both are represented by the same generic fields.
 * CARD accepts NO manual metadata.
 */
const PAYMENT_METHOD_METADATA_FIELDS = Object.freeze([
  'accountName',
  'accountNumber',
  'bankName',
  'branch',
  'district',
  'accountType',
  'routingNumber',
  'instructions',
]);

/**
 * Per-type metadata allowlists. The MANUAL type keeps the full legacy field set
 * (backward compatible with pre-split methods); the CARD type accepts none.
 */
const PAYMENT_METHOD_METADATA_FIELDS_BY_TYPE = Object.freeze({
  [PAYMENT_METHOD_TYPES.MANUAL]: PAYMENT_METHOD_METADATA_FIELDS,
  [PAYMENT_METHOD_TYPES.CARD]: Object.freeze([]),
});

const PAYMENT_MESSAGES = Object.freeze({
  PAYMENT_METHODS_FETCHED: 'Payment methods retrieved successfully',
  PAYMENT_METHOD_CREATED: 'Payment method created successfully',
  PAYMENT_METHOD_UPDATED: 'Payment method updated successfully',
  PAYMENT_METHOD_NOT_FOUND: 'Payment method not found',
  PAYMENT_METHOD_NOT_MANUAL: 'This payment method does not accept a manual payment proof',
  INVALID_PAYMENT_METHOD: 'Invalid payment method data',
  PAYMENT_SUBMITTED: 'Payment submitted for review',
  PAYMENT_FETCHED: 'Payment retrieved successfully',
  PAYMENTS_FETCHED: 'Payments retrieved successfully',
  PAYMENT_VERIFIED: 'Payment verified successfully',
  PAYMENT_REJECTED: 'Payment rejected successfully',
  PAYMENT_NOT_FOUND: 'Payment not found',
  PAYMENT_ALREADY_SUBMITTED: 'A payment is already submitted for this order',
  PAYMENT_ALREADY_VERIFIED: 'A payment for this order is already verified',
  PAYMENT_INVALID_STATE: 'Payment is in an invalid state for this operation',
  ORDER_NOT_ELIGIBLE: 'This order is not eligible for manual payment',
  IDEMPOTENCY_CONFLICT: 'Idempotency-Key conflict: a different submission already used this key',
  IDEMPOTENCY_KEY_REQUIRED: 'Idempotency-Key header is required for payment submission',
  PROOF_REQUIRED: 'A payment proof file is required',
  INVALID_PROOF: 'Invalid payment proof',
  PROOF_UPLOAD_FAILED: 'Payment proof could not be uploaded',
  INVALID_AMOUNT: 'Submitted amount must match the order total exactly',
  INVALID_PAYMENT: 'Invalid payment data',
  INVALID_STATUS: 'status must be one of: SUBMITTED, VERIFIED, REJECTED',
  MULTIPART_REQUIRED: 'multipart/form-data is required for payment submission',
});

module.exports = {
  PAYMENT_STATUSES,
  PAYMENT_STATUS_VALUES,
  REACHABLE_PAYMENT_STATUSES,
  PAYMENT_METHOD_TYPES,
  PAYMENT_METHOD_TYPE_VALUES,
  PAYMENT_LIMITS,
  PROOF_MEDIA_RULES,
  PAYMENT_SUBMIT_FIELDS,
  PAYMENT_METHOD_INPUT_FIELDS,
  PAYMENT_METHOD_METADATA_FIELDS,
  PAYMENT_METHOD_METADATA_FIELDS_BY_TYPE,
  PAYMENT_MESSAGES,
};
