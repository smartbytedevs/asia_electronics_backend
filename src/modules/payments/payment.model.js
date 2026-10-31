'use strict';

const mongoose = require('mongoose');
const {
  PAYMENT_STATUSES,
  PAYMENT_LIMITS,
} = require('./payment.constants');

const { Schema } = mongoose;

function isInteger(value) {
  return Number.isInteger(value);
}

/**
 * Safe proof-media snapshot. No binary data is ever stored in MongoDB — only
 * provider references and a URL. `secureUrl` is a Cloudinary HTTPS URL, not a
 * credential.
 */
const proofSchema = new Schema(
  {
    provider: { type: String, required: true, trim: true },
    publicId: { type: String, required: true, trim: true },
    secureUrl: { type: String, required: true, trim: true },
    resourceType: { type: String, required: true, trim: true },
    format: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const statusHistorySchema = new Schema(
  {
    status: {
      type: String,
      required: true,
      enum: PAYMENT_STATUSES,
    },
    at: { type: Date, required: true, default: Date.now },
    by: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    note: { type: String, default: null, trim: true, maxlength: PAYMENT_LIMITS.NOTE_MAX },
  },
  { _id: false }
);

/**
 * Payment — manual-payment capture record (Phase 08, ADR-0016).
 *
 * ONE record per order (unique `{ orderId }`), created lazily on the first
 * submission at `SUBMITTED`. All money is integer minor units; the expected
 * amount is the order's server-derived `grandTotalMinorUnits`, and the
 * submitted amount must match it exactly. `idempotencyKey` + fingerprint make
 * submission replay-safe (mirrors the order idempotency of ADR-0015).
 * `statusHistory` records every transition with the acting user.
 */
const paymentSchema = new Schema(
  {
    orderId: {
      type: Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
    },
    orderNumber: {
      type: String,
      required: true,
      trim: true,
    },
    customerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    paymentMethodId: {
      type: Schema.Types.ObjectId,
      ref: 'PaymentMethod',
      required: true,
    },
    paymentMethodSnapshot: {
      type: new Schema(
        {
          code: { type: String, required: true, trim: true },
          displayName: { type: String, required: true, trim: true },
          accountNumber: { type: String, default: null, trim: true },
        },
        { _id: false }
      ),
      required: true,
    },
    transactionReference: {
      type: String,
      required: true,
      trim: true,
      maxlength: PAYMENT_LIMITS.TRANSACTION_REFERENCE_MAX,
    },
    submittedAmountMinorUnits: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: isInteger,
        message: 'submittedAmountMinorUnits must be an integer',
      },
    },
    expectedAmountMinorUnits: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: isInteger,
        message: 'expectedAmountMinorUnits must be an integer',
      },
    },
    proof: { type: proofSchema, required: true },
    status: {
      type: String,
      required: true,
      default: PAYMENT_STATUSES.UNPAID,
      enum: PAYMENT_STATUSES,
    },
    statusHistory: {
      type: [statusHistorySchema],
      required: true,
      default: [],
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
    notes: {
      type: String,
      default: null,
      trim: true,
      maxlength: PAYMENT_LIMITS.NOTES_MAX,
    },
    verifiedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    verifiedAt: { type: Date, default: null },
    rejectedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    rejectedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// One payment record per order — the DB-level guard against double records.
paymentSchema.index({ orderId: 1 }, { unique: true });

// Customer payment lookup (own orders, newest first).
paymentSchema.index({ customerId: 1, createdAt: -1 });

// Staff/admin review-list filters.
paymentSchema.index({ status: 1, createdAt: -1 });

// Reference-reuse guard query: paymentMethodId + transactionReference.
paymentSchema.index({ paymentMethodId: 1, transactionReference: 1 });

module.exports = mongoose.model('Payment', paymentSchema);
