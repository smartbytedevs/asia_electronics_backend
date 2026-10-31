'use strict';

const crypto = require('crypto');

/**
 * Pathao webhook signature verification (Phase 09, ADR-0017).
 *
 * The Pathao merchant webhook sends its registered secret in the
 * `X-Pathao-Signature` header. We compare it constant-time against the
 * configured secret. An unconfigured secret or a missing/mismatched header
 * never verifies (fail closed).
 */
function verifyWebhookSignature({ signature, secret }) {
  if (!secret || !signature) {
    return false;
  }
  const left = Buffer.from(String(signature));
  const right = Buffer.from(String(secret));
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

module.exports = { verifyWebhookSignature };
