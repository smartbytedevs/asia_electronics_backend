'use strict';

/**
 * Email integration boundary (Phase 11, ADR-0019).
 *
 * The NotificationService depends on the email INTERFACE only — never on a
 * specific provider (ADR-0004). A conforming email service implements:
 *
 *   sendEmail({ to, subject, html, text }) → Promise<{
 *     messageId: string, provider: string, accepted: string[] }>
 *
 *   provider: string                       (provider label, e.g. 'smtp'/'mock')
 *
 * Implementations: `./smtp/smtp.provider.js` (production SMTP client) and
 * `./email.mock.js` (in-memory test double). Every method is async and throws
 * `EmailProviderError` (./email.errors.js) on failure. Credentials never leave
 * the adapter — Notification records hold only safe references (message id).
 */
function assertEmailService(emailService) {
  if (!emailService || typeof emailService.sendEmail !== 'function') {
    throw new Error(
      'An email service implementing the email interface (sendEmail) is required'
    );
  }
}

module.exports = { assertEmailService };
