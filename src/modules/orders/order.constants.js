'use strict';

/**
 * Order & checkout constants (Phase 07, ADR-0015).
 *
 * All order money is INTEGER MINOR UNITS (paisa) — the same representation as
 * the product catalog (ADR-0013). Every amount is computed server-side at
 * checkout; client-supplied totals, discounts, and delivery fees are ignored.
 */

/**
 * Order status machine. REACHABLE states:
 *
 *   PENDING → CONFIRMED → DISPATCHED → SHIPPED → DELIVERED → COMPLETED
 *                          ↑            ↓ (staff/admin mark SHIPPED /
 *              (successful courier    RETURNED (staff/admin; released)
 *               dispatch also moves
 *               PROCESSING → DISPATCHED)
 *
 *   PENDING → REJECTED                  (staff/admin, terminal)
 *   PENDING | CONFIRMED | PROCESSING | DISPATCHED | SHIPPED → CANCELLED
 *                                       (customer + admin, terminal)
 *
 * The Order status is the SINGLE source of truth. DISPATCHED is set by the
 * courier module ONLY on a successful dispatch; SHIPPED / DELIVERED / RETURNED
 * are staff/admin actions. Pathao status updates (webhook / reconciliation)
 * update the CourierShipment status, never the Order status.
 *
 * DELIVERED / COMPLETED cannot be cancelled. RETURN_REQUESTED is RESERVED for a
 * future returns phase — it is unreachable and any attempt to reach it fails
 * with ORDER_INVALID_STATE.
 */
const ORDER_STATUSES = Object.freeze({
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  PROCESSING: 'PROCESSING',
  DISPATCHED: 'DISPATCHED',
  SHIPPED: 'SHIPPED',
  DELIVERED: 'DELIVERED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  REJECTED: 'REJECTED',
  RETURN_REQUESTED: 'RETURN_REQUESTED',
  RETURNED: 'RETURNED',
});

const ORDER_STATUS_VALUES = Object.freeze(Object.values(ORDER_STATUSES));

const REACHABLE_ORDER_STATUSES = Object.freeze([
  ORDER_STATUSES.PENDING,
  ORDER_STATUSES.CONFIRMED,
  ORDER_STATUSES.PROCESSING,
  ORDER_STATUSES.DISPATCHED,
  ORDER_STATUSES.SHIPPED,
  ORDER_STATUSES.DELIVERED,
  ORDER_STATUSES.COMPLETED,
  ORDER_STATUSES.CANCELLED,
  ORDER_STATUSES.REJECTED,
  ORDER_STATUSES.RETURNED,
]);

const RESERVED_ORDER_STATUSES = Object.freeze([
  ORDER_STATUSES.RETURN_REQUESTED,
]);

/**
 * Delivery zones. The customer selects the zone at checkout (an optional
 * `delivery.zone` on the checkout body, validated against this enum); when no
 * selection is sent the zone falls back to the server-side address
 * classification in delivery.js. The fee table lives HERE so the amounts can
 * change in one place: ৳80 inside Chittagong, ৳150 outside.
 */
const DELIVERY_ZONES = Object.freeze({
  INSIDE_CHITTAGONG: 'INSIDE_CHITTAGONG',
  OUTSIDE_CHITTAGONG: 'OUTSIDE_CHITTAGONG',
});

const DELIVERY_ZONE_VALUES = Object.freeze(Object.values(DELIVERY_ZONES));

const DELIVERY_FEES_MINOR_UNITS = Object.freeze({
  [DELIVERY_ZONES.INSIDE_CHITTAGONG]: 8000,
  [DELIVERY_ZONES.OUTSIDE_CHITTAGONG]: 15000,
});

/**
 * Order payment methods. `COD` is the Phase 07 default (paid on delivery).
 *
 * `MANUAL` is the Phase 08 legacy value (ADR-0016): it opts the order into
 * manual payment capture, where the customer submits a proof of payment
 * against a PaymentMethod document and staff/admin verify it. `BKASH` and
 * `BANK_TRANSFER` are the concrete manual methods — the choice is recorded on
 * the order at checkout, even if the customer never submits a proof. `CARD`
 * represents an online/card gateway payment (gateway integration is reserved).
 *
 * Manual payment verification is OPTIONAL and never gates order confirmation
 * or courier dispatch. The order value is a server-controlled enum — never a
 * client string.
 */
const PAYMENT_METHODS = Object.freeze({
  COD: 'COD',
  MANUAL: 'MANUAL',
  BKASH: 'BKASH',
  BANK_TRANSFER: 'BANK_TRANSFER',
  CARD: 'CARD',
});

const PAYMENT_METHOD_VALUES = Object.freeze(Object.values(PAYMENT_METHODS));

/**
 * Manual (off-platform) payment methods. Only these orders are eligible to
 * submit a manual payment proof. `MANUAL` is retained for backward
 * compatibility with pre-split orders.
 */
const MANUAL_PAYMENT_METHODS = Object.freeze({
  MANUAL: 'MANUAL',
  BKASH: 'BKASH',
  BANK_TRANSFER: 'BANK_TRANSFER',
});

const MANUAL_PAYMENT_METHOD_VALUES = Object.freeze(Object.values(MANUAL_PAYMENT_METHODS));

function isManualPaymentMethod(method) {
  return MANUAL_PAYMENT_METHOD_VALUES.includes(method);
}

const ORDER_LIMITS = Object.freeze({
  IDEMPOTENCY_KEY_MAX: 100,
  NOTES_MAX: 1000,
  NOTE_MAX: 500,
  FULL_NAME_MAX: 150,
  PHONE_MAX: 30,
  LINE_MAX: 300,
  CITY_MAX: 100,
  AREA_MAX: 100,
  DISTRICT_MAX: 100,
  POSTAL_CODE_MAX: 20,
  EMAIL_MAX: 254,
  COUNTRY: 'BD',
  ORDER_NUMBER_PREFIX: 'TAQ-',
  ORDER_NUMBER_SEQUENCE_WIDTH: 6,
  ORDER_NUMBER_RETRIES: 5,
});

/**
 * Whitelist of every client-writable order field. Shared by the validator and
 * the service to reject unknown/immutable/operator keys (`$set`, `_id`,
 * `customerId`, `userId`, `orderNumber`, `status`, `totals`, `deliveryFee`,
 * `discount`, `items`, ...). Prevents mass-assignment, operator injection, and
 * client-controlled money/status/identity. `customerId`, totals, zone, fee,
 * orderNumber, and status are ALWAYS server-derived.
 */
const ORDER_INPUT_FIELDS = Object.freeze(['delivery', 'notes', 'paymentMethod']);

const ORDER_MESSAGES = Object.freeze({
  ORDER_CREATED: 'Order created successfully',
  ORDERS_FETCHED: 'Orders retrieved successfully',
  ORDER_FETCHED: 'Order retrieved successfully',
  ORDER_STATUS_FETCHED: 'Order status retrieved successfully',
  ORDER_CANCELLED: 'Order cancelled successfully',
  ORDER_CONFIRMED: 'Order confirmed successfully',
  ORDER_PROCESSED: 'Order processed successfully',
  ORDER_DISPATCHED: 'Order dispatched to courier successfully',
  ORDER_SHIPPED: 'Order shipped successfully',
  ORDER_DELIVERED: 'Order delivered successfully',
  ORDER_COMPLETED: 'Order completed successfully',
  ORDER_RETURNED: 'Order returned successfully',
  ORDER_REJECTED: 'Order rejected successfully',
  ORDER_NOT_FOUND: 'Order not found',
  CART_EMPTY: 'Cart is empty',
  INVALID_ORDER: 'Invalid order data',
  INVALID_DELIVERY_ADDRESS: 'Invalid delivery address',
  CANCELLATION_NOT_ALLOWED: 'This order cannot be cancelled',
  CONFIRMATION_NOT_ALLOWED: 'This order cannot be confirmed',
  PROCESSING_NOT_ALLOWED: 'This order cannot be processed',
  DISPATCHING_NOT_ALLOWED: 'This order cannot be dispatched',
  SHIPPING_NOT_ALLOWED: 'This order cannot be shipped',
  DELIVERY_NOT_ALLOWED: 'This order cannot be marked delivered',
  COMPLETION_NOT_ALLOWED: 'This order cannot be completed',
  RETURN_NOT_ALLOWED: 'This order cannot be returned',
  PAYMENT_VERIFICATION_REQUIRED:
    'Payment must be verified before this order can be confirmed',
  REJECTION_NOT_ALLOWED: 'This order cannot be rejected',
  INVALID_STATE: 'Order is in an invalid state for this operation',
  IDEMPOTENCY_CONFLICT: 'Idempotency-Key conflict: a different order was already created with this key',
  CHECKOUT_FAILED: 'Checkout could not be completed',
  ORDER_NUMBER_GENERATION_FAILED: 'Could not generate a unique order number',
});

module.exports = {
  ORDER_STATUSES,
  ORDER_STATUS_VALUES,
  REACHABLE_ORDER_STATUSES,
  RESERVED_ORDER_STATUSES,
  DELIVERY_ZONES,
  DELIVERY_ZONE_VALUES,
  DELIVERY_FEES_MINOR_UNITS,
  PAYMENT_METHODS,
  PAYMENT_METHOD_VALUES,
  MANUAL_PAYMENT_METHODS,
  MANUAL_PAYMENT_METHOD_VALUES,
  isManualPaymentMethod,
  ORDER_LIMITS,
  ORDER_INPUT_FIELDS,
  ORDER_MESSAGES,
};
