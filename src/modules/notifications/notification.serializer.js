'use strict';

/**
 * Notification serializer (Phase 11, ADR-0019).
 *
 * Produces the API-safe representation of a Notification. The full `payload`
 * is deliberately NOT serialized (it is an internal audit snapshot) — callers
 * reference `entityRef` to correlate. ADMIN-channel notifications carry a
 * pre-rendered `title`/`message` (built by the admin templates as safe plain
 * text) which IS exposed so admins can read "new order / new review" events
 * without any internal ids or raw event data leaking.
 */
function toNotificationOutput(doc) {
  if (!doc) {
    return null;
  }
  const payload = doc.payload || {};
  return {
    id: String(doc._id),
    recipient: doc.recipient ? String(doc.recipient) : null,
    channel: doc.channel,
    eventType: doc.eventType,
    templateKey: doc.templateKey,
    entityRef: doc.entityRef,
    title: payload.title || null,
    message: payload.message || null,
    status: doc.status,
    attempts: doc.attempts,
    lastAttemptAt: doc.lastAttemptAt || null,
    lastError: doc.lastError || null,
    provider: doc.provider || null,
    providerRef: doc.providerRef || null,
    deliveredAt: doc.deliveredAt || null,
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
  };
}

module.exports = { toNotificationOutput };
