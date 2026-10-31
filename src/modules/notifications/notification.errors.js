'use strict';

/**
 * Notification domain error taxonomy (Phase 11, ADR-0019).
 *
 * `NotificationError` is used for INVARIANT failures inside the
 * NotificationService (unknown event type, template render failure). Provider
 * and transport failures are `EmailProviderError`s from the email integration
 * and are RECORDED on the Notification document, never rethrown — a
 * notification must never fail the business operation that triggered it.
 */
const NOTIFICATION_ERROR_CODES = Object.freeze({
  UNKNOWN_EVENT_TYPE: 'UNKNOWN_EVENT_TYPE',
  RENDER_FAILED: 'RENDER_FAILED',
});

class NotificationError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = 'NotificationError';
    this.code = code;
    this.cause = cause;
    Error.captureStackTrace(this, this.constructor);
  }
}

function isNotificationError(err) {
  return err instanceof NotificationError;
}

module.exports = {
  NOTIFICATION_ERROR_CODES,
  NotificationError,
  isNotificationError,
};
