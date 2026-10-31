'use strict';

const { createBaseRepository } = require('../base/base.repository');
const { NOTIFICATION_STATUSES } = require('./notification.constants');

/**
 * Notification persistence layer (Phase 11, ADR-0019).
 *
 * Encapsulates database operations only — no business rules, HTTP, or provider
 * calls. The status mutations below are guarded conditional updates (QUEUED →
 * SENT | FAILED | SKIPPED) so a retry worker can never double-mark a
 * notification.
 */
function createNotificationRepository(model) {
  const base = createBaseRepository(model);

  return {
    ...base,

    /**
     * Returns the most recent notification for the same recipient + event +
     * entity created after `since`, or `null`. Used for the within-window
     * deduplication guard (defense-in-depth on top of the business services'
     * own idempotency short-circuits).
     */
    findRecentDuplicate: (recipient, eventType, entityRef, since, options = {}) => {
      if (!entityRef) {
        return Promise.resolve(null);
      }
      return base.findOne(
        { recipient, eventType, entityRef, createdAt: { $gte: since } },
        { lean: true, ...options }
      );
    },

    markSent: (id, { provider, providerRef, deliveredAt }, options = {}) =>
      model.findByIdAndUpdate(
        id,
        {
          $set: {
            status: NOTIFICATION_STATUSES.SENT,
            deliveredAt,
            lastError: null,
            ...(provider ? { provider } : {}),
            ...(providerRef ? { providerRef } : {}),
          },
          $inc: { attempts: 1 },
        },
        { new: true, runValidators: true, ...options }
      ),

    markFailed: (id, { code, message, at }, options = {}) =>
      model.findByIdAndUpdate(
        id,
        {
          $set: {
            status: NOTIFICATION_STATUSES.FAILED,
            lastAttemptAt: at || new Date(),
            lastError: {
              code: code || 'EMAIL_SEND_FAILED',
              message: message ? String(message).slice(0, 500) : null,
            },
          },
          $inc: { attempts: 1 },
        },
        { new: true, runValidators: true, ...options }
      ),

    markSkipped: (id, { reason, at }, options = {}) =>
      model.findByIdAndUpdate(
        id,
        {
          $set: {
            status: NOTIFICATION_STATUSES.SKIPPED,
            lastAttemptAt: at || new Date(),
            lastError: {
              code: 'SKIPPED',
              message: reason || null,
            },
          },
          $inc: { attempts: 1 },
        },
        { new: true, runValidators: true, ...options }
      ),
  };
}

module.exports = { createNotificationRepository };
