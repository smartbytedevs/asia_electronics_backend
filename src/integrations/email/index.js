'use strict';

const { assertEmailService } = require('./email.interface');
const {
  EMAIL_PROVIDER_ERROR_CODES,
  EmailProviderError,
  isEmailProviderError,
} = require('./email.errors');
const { createMemoryEmailService } = require('./email.mock');
const { createSmtpEmailProvider } = require('./smtp/smtp.provider');

/**
 * Email provider factory (Phase 11, ADR-0019).
 *
 *   const emailService = createEmailProvider(config.email);
 *
 * Selects the provider from the `provider` field:
 *   - 'smtp' → production SMTP client (credentials optional until first send)
 *   - 'mock' → deterministic in-memory service (development/tests, the default)
 *
 * The returned object always satisfies the email interface
 * (email.interface.js) so callers depend on the abstraction only (ADR-0004).
 */
function createEmailProvider({
  provider = 'mock',
  host,
  port,
  user,
  password,
  from,
  timeoutMs,
  secure,
} = {}) {
  if (provider === 'smtp') {
    return createSmtpEmailProvider({ host, port, user, password, from, timeoutMs, secure });
  }
  return createMemoryEmailService();
}

module.exports = {
  assertEmailService,
  EMAIL_PROVIDER_ERROR_CODES,
  EmailProviderError,
  isEmailProviderError,
  createEmailProvider,
  createMemoryEmailService,
  createSmtpEmailProvider,
};
