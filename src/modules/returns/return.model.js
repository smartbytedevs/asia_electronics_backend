'use strict';

const mongoose = require('mongoose');
const { RETURN_STATUSES, RETURN_LIMITS } = require('./return.constants');

const { Schema } = mongoose;

function isInteger(value) {
  return Number.isInteger(value);
}

/**
 * ReturnItem — embedded snapshot of the ORDERED quantity being returned
 * (Phase 10, ADR-0018). Copies the price fields from the order's immutable
 * OrderItem snapshot at submission time, so the refund amount (computed at
 * completion from these snapshots) is provable and stable even if the catalog
 * changes. The stock-ledger link is `productVariantId`; `orderItemId` links
 * back to the original OrderItem subdocument for duplicate-prevention.
 */
const returnItemSchema = new Schema(
  {
    orderItemId: {
      type: Schema.Types.ObjectId,
      required: true,
    },
    productId: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    productVariantId: {
      type: Schema.Types.ObjectId,
      ref: 'ProductVariant',
      default: null,
    },
    productName: {
      type: String,
      required: true,
      trim: true,
    },
    sku: {
      type: String,
      default: null,
      trim: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: isInteger,
        message: 'quantity must be an integer',
      },
    },
    unitPriceMinorUnits: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: isInteger,
        message: 'unitPriceMinorUnits must be an integer',
      },
    },
    discountMinorUnits: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: {
        validator: isInteger,
        message: 'discountMinorUnits must be an integer',
      },
    },
  },
  { _id: true }
);

const statusHistorySchema = new Schema(
  {
    status: {
      type: String,
      required: true,
      enum: RETURN_STATUSES,
    },
    at: { type: Date, required: true, default: Date.now },
    by: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    note: { type: String, default: null, trim: true, maxlength: RETURN_LIMITS.NOTE_MAX },
  },
  { _id: false }
);

/**
 * Return — a customer's return request against an order (Phase 10, ADR-0018).
 *
 * Multiple returns per order are allowed (each return claims specific order
 * items/quantities). `returnNumber` (`RET-YYYYMMDD-XXXXXX`) is generated
 * server-side with a unique index and bounded retry. `idempotencyKey` +
 * `customerId`-independent `{ orderId, idempotencyKey }` unique compound index
 * makes submission replay-safe. `statusHistory` records every transition with
 * the acting user. The refund reference (`refundId`) is populated when the
 * return COMPLETES — never on approval.
 */
const returnSchema = new Schema(
  {
    customerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    orderId: {
      type: Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
    },
    returnNumber: {
      type: String,
      required: true,
      trim: true,
    },
    idempotencyKey: {
      type: String,
      required: true,
      trim: true,
    },
    idempotencyFingerprint: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      required: true,
      default: RETURN_STATUSES.PENDING,
      enum: RETURN_STATUSES,
    },
    statusHistory: {
      type: [statusHistorySchema],
      required: true,
      default: [],
    },
    items: {
      type: [returnItemSchema],
      required: true,
      default: [],
    },
    reason: {
      type: String,
      required: true,
      trim: true,
      maxlength: RETURN_LIMITS.REASON_MAX,
    },
    notes: {
      type: String,
      default: null,
      trim: true,
      maxlength: RETURN_LIMITS.NOTES_MAX,
    },
    refundId: {
      type: Schema.Types.ObjectId,
      ref: 'Refund',
      default: null,
    },
    approvedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    approvedAt: { type: Date, default: null },
    rejectedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    rejectedAt: { type: Date, default: null },
    cancelledBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    cancelledAt: { type: Date, default: null },
    completedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Return-submission idempotency per order: a retried submit re-uses the same
// key (mapped to RETURN_IDEMPOTENCY_CONFLICT on fingerprint mismatch). Multiple
// DISTINCT returns per order remain allowed (different keys).
returnSchema.index({ orderId: 1, idempotencyKey: 1 }, { unique: true });

// Return-number generation races: unique index + bounded retry.
returnSchema.index({ returnNumber: 1 }, { unique: true });

// Customer return-history listing (newest first).
returnSchema.index({ customerId: 1, createdAt: -1 });

// Order return-history listing + the availability "claimed" query.
returnSchema.index({ orderId: 1, createdAt: -1 });
returnSchema.index({ orderId: 1, status: 1 });

// Staff/admin return-listing filters.
returnSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('Return', returnSchema);
