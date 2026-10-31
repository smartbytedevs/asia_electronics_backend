'use strict';

const { ORDER_STATUSES } = require('../orders/order.constants');

/**
 * Courier shipment constants (Phase 09, ADR-0017).
 *
 * One CourierShipment document exists per Order (unique `orderId`). It wraps a
 * single logical delivery handoff to a courier provider (Pathao). All money is
 * INTEGER MINOR UNITS (paisa) — the same representation as orders and the
 * catalog (ADR-0013/ADR-0015).
 */

/**
 * Courier shipment state machine. Full diagram + transition rationale in
 * docs/courier-state-machine.md.
 *
 *   PENDING → ACTIVE                 (submitted to provider, tracking assigned)
 *   PENDING → FAILED                 (provider rejected/errored on submit)
 *   PENDING → CANCELLED              (cancelled before dispatch)
 *   FAILED  → ACTIVE                 (retry succeeded)
 *   FAILED  → CANCELLED              (cancelled after failure)
 *   ACTIVE  → DELIVERED              (provider confirmed)
 *   ACTIVE  → CANCELLED              (provider confirmed cancellation)
 *   ACTIVE  → CANCELLATION_FAILED    (provider refused/errored on cancel)
 *   CANCELLATION_FAILED → DELIVERED  (provider reported delivered meanwhile)
 *   CANCELLATION_FAILED → CANCELLED  (retried cancel succeeded)
 *
 * DELIVERED and CANCELLED are TERMINAL — no further transitions.
 */
const COURIER_STATUSES = Object.freeze({
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  DELIVERED: 'DELIVERED',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
  CANCELLATION_FAILED: 'CANCELLATION_FAILED',
});

const COURIER_STATUS_VALUES = Object.freeze(Object.values(COURIER_STATUSES));

/**
 * Non-terminal statuses — eligible for provider reconciliation polling.
 * DELIVERED/CANCELLED are terminal; FAILED needs an explicit retry, not a poll.
 */
const RECONCILABLE_COURIER_STATUSES = Object.freeze([
  COURIER_STATUSES.ACTIVE,
  COURIER_STATUSES.CANCELLATION_FAILED,
]);

const TERMINAL_COURIER_STATUSES = Object.freeze([
  COURIER_STATUSES.DELIVERED,
  COURIER_STATUSES.CANCELLED,
]);

/**
 * Courier providers. The interface (courier.provider.interface.js) is the only
 * contract the service depends on; 'mock' is the deterministic default.
 */
const COURIER_PROVIDERS = Object.freeze({
  MOCK: 'mock',
  PATHAO: 'pathao',
});

const COURIER_PROVIDER_VALUES = Object.freeze(Object.values(COURIER_PROVIDERS));

/**
 * Order statuses a shipment may be dispatched for. Dispatch is only meaningful
 * once staff/admin have confirmed the order (stock is already committed and the
 * order is no longer customer-cancellable without courier side effects). The
 * order may be dispatched at any point after confirmation — including a
 * re-dispatch while DISPATCHED and after it has already been shipped.
 */
const COURIER_DISPATCHABLE_ORDER_STATUSES = Object.freeze([
  ORDER_STATUSES.CONFIRMED,
  ORDER_STATUSES.PROCESSING,
  ORDER_STATUSES.DISPATCHED,
  ORDER_STATUSES.SHIPPED,
]);

/**
 * Max payload text lengths. Pathao bounds recipient name to 3–100 chars and
 * address to 10–220 chars; item description and special instruction are
 * truncated defensively to avoid provider rejections on free-text fields.
 */
const COURIER_LIMITS = Object.freeze({
  RECIPIENT_NAME_MAX: 100,
  RECIPIENT_NAME_MIN: 3,
  ADDRESS_MAX: 220,
  ADDRESS_MIN: 10,
  ITEM_DESCRIPTION_MAX: 500,
  SPECIAL_INSTRUCTION_MAX: 200,
  PHONE_MAX: 30,
  MERCHANT_REFERENCE_MAX: 60,
  NOTE_MAX: 500,
  ITEM_WEIGHT_MIN_KG: 0.5,
  ITEM_WEIGHT_MAX_KG: 10,
  PROVIDER_ERROR_MESSAGE_MAX: 500,
  DISPATCH_MAX_ATTEMPTS: 20,
});

const COURIER_MESSAGES = Object.freeze({
  SHIPMENT_NOT_FOUND: 'Courier shipment not found',
  SHIPMENT_EXISTS: 'An active courier shipment already exists for this order',
  DISPATCHED: 'Order dispatched to courier',
  REDISPATCHED: 'Courier dispatch retried successfully',
  CANCELLED: 'Courier shipment cancelled',
  FETCHED: 'Courier shipment retrieved',
  LISTED: 'Courier shipments retrieved',
  TRACKING_FETCHED: 'Tracking information retrieved',
  INVALID_STATE: 'Courier shipment is in an invalid state for this operation',
  DISPATCH_NOT_ALLOWED: 'This order cannot be dispatched to a courier',
  PROVIDER_NOT_CONFIGURED: 'The courier provider is not configured',
  WEBHOOK_ACCEPTED: 'Webhook accepted',
});

module.exports = {
  COURIER_STATUSES,
  COURIER_STATUS_VALUES,
  RECONCILABLE_COURIER_STATUSES,
  TERMINAL_COURIER_STATUSES,
  COURIER_PROVIDERS,
  COURIER_PROVIDER_VALUES,
  COURIER_DISPATCHABLE_ORDER_STATUSES,
  COURIER_LIMITS,
  COURIER_MESSAGES,
};
