'use strict';

/**
 * Notification constants (Phase 11, ADR-0019).
 *
 * A Notification is the audit record of ONE best-effort message. It is created
 * by the business services at real domain events (order
 * placed/confirmed/cancelled, payment submitted/verified/rejected, shipment
 * dispatched, order delivered, return
 * requested/approved/rejected/completed/cancelled, refund processed/voided).
 *
 * Two channels share the SAME document and SAME delivery is best-effort:
 *   - EMAIL   — customer-facing transactional email (rendered + sent). Also
 *               used by the admin NEW ORDER email (ADMIN_ORDER_PLACED_EMAIL),
 *               which is sent to the configured ADMIN_EMAIL address.
 *   - ADMIN   — admin dashboard event (new order / new review). No email is
 *               sent; the record is persisted as SENT ("available in the admin
 *               notification list") the moment it is created.
 *
 * Notifications NEVER change the outcome of the business operation that
 * triggered them: delivery is best-effort, failures are recorded on the
 * Notification document (status FAILED + lastError) and are retryable, and the
 * email provider is fully swappable (mock in dev/tests, SMTP in production).
 */

/**
 * Notification status machine. Reachable states:
 *
 *   QUEUED   → SENT      (email accepted by the provider; TERMINAL)
 *   QUEUED   → FAILED    (provider error; retryable → QUEUED)
 *   QUEUED   → SKIPPED   (no provider configured; TERMINAL)
 *   FAILED   → QUEUED    (retry via a future retry worker)
 *   FAILED   → SKIPPED   (abandoned)
 *
 * QUEUED is the entry state: the record is persisted BEFORE the send attempt
 * so a crash between create and mark leaves a retryable QUEUED row.
 */
const NOTIFICATION_STATUSES = Object.freeze({
  QUEUED: 'QUEUED',
  SENT: 'SENT',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
});

const NOTIFICATION_STATUS_VALUES = Object.freeze(Object.values(NOTIFICATION_STATUSES));

/**
 * Delivery channels. 'EMAIL' is the customer-facing transactional email
 * channel; 'ADMIN' is the admin dashboard channel (see the header comment).
 */
const NOTIFICATION_CHANNELS = Object.freeze({
  EMAIL: 'EMAIL',
  ADMIN: 'ADMIN',
});

const NOTIFICATION_EVENT_TYPES = Object.freeze({
  // Order lifecycle (Phase 07, ADR-0015).
  ORDER_PLACED: 'ORDER_PLACED',
  ORDER_CONFIRMED: 'ORDER_CONFIRMED',
  ORDER_PROCESSING: 'ORDER_PROCESSING',
  ORDER_REJECTED: 'ORDER_REJECTED',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  // Payment lifecycle (Phase 08, ADR-0016).
  PAYMENT_SUBMITTED: 'PAYMENT_SUBMITTED',
  PAYMENT_VERIFIED: 'PAYMENT_VERIFIED',
  PAYMENT_REJECTED: 'PAYMENT_REJECTED',
  // Courier lifecycle (Phase 09, ADR-0017).
  SHIPMENT_DISPATCHED: 'SHIPMENT_DISPATCHED',
  ORDER_DELIVERED: 'ORDER_DELIVERED',
  // Return lifecycle (Phase 10, ADR-0018).
  RETURN_REQUESTED: 'RETURN_REQUESTED',
  RETURN_APPROVED: 'RETURN_APPROVED',
  RETURN_REJECTED: 'RETURN_REJECTED',
  RETURN_COMPLETED: 'RETURN_COMPLETED',
  RETURN_CANCELLED: 'RETURN_CANCELLED',
  // Refund lifecycle (Phase 10, ADR-0018).
  REFUND_PROCESSED: 'REFUND_PROCESSED',
  REFUND_VOIDED: 'REFUND_VOIDED',
  // Admin dashboard events (ADMIN channel — no email).
  ADMIN_ORDER_PLACED: 'ADMIN_ORDER_PLACED',
  ADMIN_REVIEW_SUBMITTED: 'ADMIN_REVIEW_SUBMITTED',
  // Admin NEW ORDER email (EMAIL channel): a separate HTML email to the
  // configured admin address for every successfully placed order. It is an
  // EMAIL-ONLY side effect — NotificationService.notifyAdminEmail is called
  // with `persist: false`, so NO Notification record is ever created for it
  // and it never appears in the in-app admin notification center. The value
  // is retained as the template key / event identifier for the email itself.
  ADMIN_ORDER_PLACED_EMAIL: 'ADMIN_ORDER_PLACED_EMAIL',
});

const NOTIFICATION_EVENT_TYPE_VALUES = Object.freeze(Object.values(NOTIFICATION_EVENT_TYPES));

const NOTIFICATION_EVENT_CATEGORIES = Object.freeze({
  ORDER: 'order',
  PAYMENT: 'payment',
  COURIER: 'courier',
  RETURN: 'return',
  REFUND: 'refund',
  ADMIN: 'admin',
});

const NOTIFICATION_LIMITS = Object.freeze({
  ENTITY_REF_MAX: 128,
  ERROR_MESSAGE_MAX: 500,
});

const NOTIFICATION_MESSAGES = Object.freeze({
  NOTIFICATION_NOT_FOUND: 'Notification not found',
  INVALID_NOTIFICATION: 'Invalid notification data',
  UNKNOWN_EVENT_TYPE: 'Unknown notification event type',
  NOTIFICATIONS_FETCHED: 'Notifications retrieved successfully',
  NOTIFICATION_FETCHED: 'Notification retrieved successfully',
  INVALID_STATUS: 'status must be one of: QUEUED, SENT, FAILED, SKIPPED',
});

module.exports = {
  NOTIFICATION_STATUSES,
  NOTIFICATION_STATUS_VALUES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_EVENT_TYPE_VALUES,
  NOTIFICATION_EVENT_CATEGORIES,
  NOTIFICATION_LIMITS,
  NOTIFICATION_MESSAGES,
};
