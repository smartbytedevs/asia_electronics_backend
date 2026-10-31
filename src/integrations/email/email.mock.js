'use strict';

const crypto = require('crypto');
const { EmailProviderError, EMAIL_PROVIDER_ERROR_CODES } = require('./email.errors');

/**
 * In-memory email service (test double, Phase 11).
 *
 * Implements the same interface as the SMTP provider so the NotificationService
 * and integration fixtures can run without network/credentials. Exposes a
 * `sent` array (every delivered message) and a `calls.sends` log so tests can
 * assert on recipient/subject/body. `failNextSendWith(err)` forces the NEXT
 * send to throw (exercises the distributed boundary: business success + email
 * failure recorded on the Notification document).
 */
function createMemoryEmailService({ now = Date.now } = {}) {
  const sent = [];
  const calls = { sends: [] };
  let injectedFailure = null;

  return {
    provider: 'mock',
    sent,
    calls,

    failNextSendWith: (err) => {
      injectedFailure = err;
    },

    async sendEmail({ to, subject, html, text }) {
      calls.sends.push({ to, subject, html, text });
      if (injectedFailure) {
        const err = injectedFailure;
        injectedFailure = null;
        throw err;
      }
      const messageId = `<mock-${crypto.randomUUID()}@taqwa.test>`;
      sent.push({
        messageId,
        to,
        subject,
        html,
        text,
        sentAt: new Date(now()),
      });
      return { messageId, provider: 'mock', accepted: [to] };
    },
  };
}

module.exports = { createMemoryEmailService };
