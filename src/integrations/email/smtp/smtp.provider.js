'use strict';

const { SmtpClient } = require('./smtp.client');
const { EmailProviderError, EMAIL_PROVIDER_ERROR_CODES } = require('../email.errors');
const { maskRecipient } = require('../email.safe-log');

/**
 * SMTP email provider (Phase 11, ADR-0019).
 *
 * Implements the email interface (email.interface.js) on top of the minimal
 * dependency-free SMTP client. Selected when `EMAIL_PROVIDER=smtp`; the mock
 * provider is the default in development and tests.
 *
 * Configuration validation is DEFERRED to the first send (per the provider
 * interface contract) so application boot never fails on missing credentials —
 * a send with an unconfigured provider records NOT_CONFIGURED on the
 * Notification document instead. (The config layer additionally fails fast in
 * production so a deployment can never boot with a silently-broken email
 * system.)
 *
 * Every send is logged for serverless runtime diagnostics. Logs never contain
 * the SMTP password, tokens, or message content; the recipient is masked and
 * only the domain is kept.
 */
function createSmtpEmailProvider({ host, port, user, password, from, timeoutMs, secure } = {}) {
  return {
    provider: 'smtp',

    async sendEmail({ to, subject, html, text }) {
      const missing = [];
      if (!host) missing.push('EMAIL_HOST');
      if (!from) missing.push('EMAIL_FROM');
      if (missing.length > 0) {
        throw new EmailProviderError(
          EMAIL_PROVIDER_ERROR_CODES.NOT_CONFIGURED,
          `SMTP email is not configured (missing: ${missing.join(', ')}). See .env.example.`
        );
      }
      const client = new SmtpClient({
        host,
        port,
        user,
        password,
        secure,
        timeoutMs,
      });
      const startedAt = Date.now();
      try {
        const result = await client.send({ from, to, subject, html, text });
        console.info('[email] SMTP message accepted', {
          provider: 'smtp',
          host,
          port,
          to: maskRecipient(to),
          messageId: (result && result.messageId) || null,
          durationMs: Date.now() - startedAt,
        });
        return result;
      } catch (err) {
        console.error('[email] SMTP send failed', {
          provider: 'smtp',
          host,
          port,
          to: maskRecipient(to),
          error: {
            code: (err && err.code) || 'SMTP_ERROR',
            message: (err && err.message) || String(err),
          },
          durationMs: Date.now() - startedAt,
        });
        throw err;
      }
    },
  };
}

module.exports = { createSmtpEmailProvider };
