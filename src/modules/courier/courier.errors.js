'use strict';

/**
 * Courier provider error taxonomy (Phase 09, ADR-0017).
 *
 * Providers (Pathao, mock) signal failures by throwing `CourierProviderError`
 * with one of the machine-readable codes below. The CourierService catches
 * these and maps them to HTTP ApiErrors with stable ERROR_CODES — the provider
 * layer never constructs HTTP responses itself.
 *
 *   PROVIDER_UNAVAILABLE  network/timeout/5xx — RETRYABLE.
 *   PROVIDER_REJECTED     4xx validation/auth — fix config/payload, retry.
 *   TRACKING_NOT_FOUND    status lookup 404 — shipment does not exist there.
 *   CANCEL_REJECTED       provider refused the cancellation.
 *   NOT_CONFIGURED        provider never configured (missing credentials).
 */
const COURIER_PROVIDER_ERROR_CODES = Object.freeze({
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  PROVIDER_REJECTED: 'PROVIDER_REJECTED',
  TRACKING_NOT_FOUND: 'TRACKING_NOT_FOUND',
  CANCEL_REJECTED: 'CANCEL_REJECTED',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
});

class CourierProviderError extends Error {
  constructor(code, message, { raw = null } = {}) {
    super(message);
    this.name = 'CourierProviderError';
    this.code = code;
    this.raw = raw;
    Error.captureStackTrace(this, this.constructor);
  }
}

function isCourierProviderError(err) {
  return err instanceof CourierProviderError;
}

module.exports = {
  COURIER_PROVIDER_ERROR_CODES,
  CourierProviderError,
  isCourierProviderError,
};
