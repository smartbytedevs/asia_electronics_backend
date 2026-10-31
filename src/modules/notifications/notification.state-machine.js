'use strict';

const { NOTIFICATION_STATUSES } = require('./notification.constants');

/**
 * Notification status machine (Phase 11, ADR-0019).
 *
 * Reachable transitions:
 *
 *   QUEUED   → SENT      (provider accepted the message; TERMINAL)
 *   QUEUED   → FAILED    (provider/transport error; retryable)
 *   QUEUED   → SKIPPED   (no provider configured; TERMINAL)
 *   FAILED   → QUEUED    (retry — reserved for a future retry worker)
 *   FAILED   → SKIPPED   (abandon after persistent failure)
 *
 * Every Notification is CREATED at QUEUED before the send attempt — that is the
 * retry safety net (a crash between create and mark leaves a retryable row).
 * The transition table is the SINGLE source of truth; the repository guards its
 * status updates with it.
 */
const VALID_TRANSITIONS = Object.freeze({
  [NOTIFICATION_STATUSES.SENT]: Object.freeze([NOTIFICATION_STATUSES.QUEUED]),
  [NOTIFICATION_STATUSES.FAILED]: Object.freeze([NOTIFICATION_STATUSES.QUEUED]),
  [NOTIFICATION_STATUSES.SKIPPED]: Object.freeze([
    NOTIFICATION_STATUSES.QUEUED,
    NOTIFICATION_STATUSES.FAILED,
  ]),
  [NOTIFICATION_STATUSES.QUEUED]: Object.freeze([NOTIFICATION_STATUSES.FAILED]),
});

function canTransition(fromStatus, toStatus) {
  const sources = VALID_TRANSITIONS[toStatus];
  return Boolean(sources && sources.includes(fromStatus));
}

module.exports = {
  VALID_TRANSITIONS,
  canTransition,
};
