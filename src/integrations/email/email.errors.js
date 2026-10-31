'use strict';

/**
 * Email provider error taxonomy (Phase 11, ADR-0019).
 *
 * Email providers (SMTP, mock) signal failures by throwing `EmailProviderError`
 * with one of the machine-readable codes below. The NotificationService catches
 * these and records them on the Notification document — the provider layer never
 * constructs HTTP responses itself and notification failures NEVER fail the
 * business operation that triggered them (they are best-effort side effects).
 *
 *   PROVIDER_UNAVAILABLE  network/timeout/transient 4xx SMTP replies — RETRYABLE.
 *   PROVIDER_REJECTED     permanent 5xx SMTP replies / malformed replies /
 *                         invalid addresses — fix config.
 *   NOT_CONFIGURED        provider never configured (missing credentials).
 */
const EMAIL_PROVIDER_ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  PROVIDER_REJECTED: 'PROVIDER_REJECTED',
});

class EmailProviderError extends Error {
  constructor(code, message, { raw = null } = {}) {
    super(message);
    this.name = 'EmailProviderError';
    this.code = code;
    this.raw = raw;
    Error.captureStackTrace(this, this.constructor);
  }
}

function isEmailProviderError(err) {
  return err instanceof EmailProviderError;
}

module.exports = {
  EMAIL_PROVIDER_ERROR_CODES,
  EmailProviderError,
  isEmailProviderError,
};
