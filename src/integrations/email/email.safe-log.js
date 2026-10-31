'use strict';

/**
 * Safe email logging helpers (Phase 11 deployment audit).
 *
 * Email delivery must be diagnosable from serverless runtime logs (e.g. Vercel
 * Runtime Logs) WITHOUT leaking secrets or full message content. These helpers
 * mask the recipient local-part while keeping the domain for routing
 * diagnostics. SMTP credentials never pass through this layer, and no helper
 * here ever formats the HTML/text body of a message.
 */

/**
 * Extracts the lower-cased domain of an email address (everything after the
 * last '@'), or null when the address has no usable domain.
 */
function recipientDomain(email) {
  const value = String(email == null ? '' : email);
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) {
    return null;
  }
  return value.slice(at + 1).toLowerCase();
}

/**
 * Masks the local-part of an email address (e.g. "a***e@example.com") so full
 * customer addresses never reach logs while the domain stays visible for
 * routing diagnostics. Accepts a string or an array of strings.
 */
function maskRecipient(email) {
  const recipients = Array.isArray(email) ? email : [email];
  const masked = recipients
    .map((one) => {
      const value = String(one == null ? '' : one);
      const at = value.lastIndexOf('@');
      if (at <= 0) {
        return value ? '***' : null;
      }
      const local = value.slice(0, at);
      const domain = value.slice(at + 1);
      const maskedLocal = local.length <= 2 ? '***' : `${local.charAt(0)}***${local.charAt(local.length - 1)}`;
      return `${maskedLocal}@${domain}`;
    })
    .filter(Boolean);
  return masked.length > 0 ? masked.join(', ') : null;
}

module.exports = { recipientDomain, maskRecipient };
