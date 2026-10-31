'use strict';

const mongoose = require('mongoose');
const {
  NOTIFICATION_STATUSES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_LIMITS,
} = require('./notification.constants');

const { Schema } = mongoose;

const notificationErrorSchema = new Schema(
  {
    code: { type: String, default: null, trim: true },
    message: {
      type: String,
      default: null,
      trim: true,
      maxlength: NOTIFICATION_LIMITS.ERROR_MESSAGE_MAX,
    },
  },
  { _id: false }
);

/**
 * Notification — ONE audit record per customer-facing message (Phase 11,
 * ADR-0019). Created at a real domain event (order placed/confirmed/...,
 * payment submitted/verified/rejected, shipment dispatched, order delivered,
 * return lifecycle, refund processed/voided) and updated in place as the email
 * provider accepts or rejects it.
 *
 * Delivery is BEST-EFFORT: `status` starts QUEUED (the retry safety net —
 * persisted BEFORE the send attempt), then SENT / FAILED / SKIPPED. `payload`
 * is a sanitized snapshot of the event data (never secrets — the callers build
 * safe subsets) so a notification is re-renderable/auditable later.
 */
const notificationSchema = new Schema(
  {
    recipient: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Audit field: the actual email address the message was delivered to. For
    // customer EMAIL notifications this is the recipient's account email (or
    // the order's customer email for guests); for the admin NEW ORDER email it
    // is the configured ADMIN_EMAIL. Stored so a later audit never needs to
    // re-derive the destination.
    recipientEmail: {
      type: String,
      default: null,
      trim: true,
      lowercase: true,
      maxlength: 254,
    },
    channel: {
      type: String,
      required: true,
      default: NOTIFICATION_CHANNELS.EMAIL,
      enum: Object.values(NOTIFICATION_CHANNELS),
    },
    eventType: {
      type: String,
      required: true,
      enum: NOTIFICATION_EVENT_TYPES,
    },
    templateKey: { type: String, required: true, trim: true },
    // Stable per-event identifier (e.g. an order/payment/return/refund id) used
    // for the within-window deduplication and for audits ("what order was
    // this?").
    entityRef: {
      type: String,
      default: null,
      trim: true,
      maxlength: NOTIFICATION_LIMITS.ENTITY_REF_MAX,
    },
    payload: { type: Schema.Types.Mixed, default: {} },
    status: {
      type: String,
      required: true,
      default: NOTIFICATION_STATUSES.QUEUED,
      enum: NOTIFICATION_STATUSES,
    },
    attempts: { type: Number, required: true, default: 0, min: 0 },
    lastAttemptAt: { type: Date, default: null },
    lastError: { type: notificationErrorSchema, default: null },
    // Provider label (e.g. 'smtp'/'mock') and message-id for troubleshooting.
    provider: { type: String, default: null, trim: true },
    providerRef: { type: String, default: null, trim: true },
    deliveredAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Customer notification history (future customer-facing inbox).
notificationSchema.index({ recipient: 1, createdAt: -1 });

// Retry scans (future retry worker): failed/queued notifications oldest first.
notificationSchema.index({ status: 1, lastAttemptAt: 1 });

// Deduplication: same recipient + event + entity within the dedupe window.
notificationSchema.index({ recipient: 1, eventType: 1, entityRef: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
