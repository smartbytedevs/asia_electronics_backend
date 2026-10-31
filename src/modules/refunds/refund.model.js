'use strict';

const mongoose = require('mongoose');
const { REFUND_STATUSES, REFUND_LIMITS } = require('./refund.constants');

function isInteger(value) {
  return Number.isInteger(value);
}

const refundNumberRegex = new RegExp(
  `^${REFUND_LIMITS.REFUND_NUMBER_PREFIX}\\d{8}-\\d{${REFUND_LIMITS.REFUND_NUMBER_SEQUENCE_WIDTH}}$`
);

const refundSchema = new mongoose.Schema(
  {
    refundNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      match: refundNumberRegex,
      description: 'Human-readable number, e.g. RFD-20260808-000001',
    },
    return: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Return',
      required: true,
      unique: true,
    },
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    paymentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Payment',
      default: null,
      description: 'Captured Payment for MANUAL orders; null for COD',
    },
    paymentMethod: {
      type: String,
      enum: Object.values(require('./refund.constants').REFUND_PAYMENT_METHODS),
      required: true,
      description: 'MANUAL (verifiable via paymentId) or COD (informational only)',
    },
    amount: {
      type: Number,
      min: 0,
      validate: {
        validator: isInteger,
        message: 'amount must be an integer',
      },
      required: true,
      description: 'Integer minor units (paisa) — server-derived from item snapshots',
    },
    status: {
      type: String,
      enum: Object.values(REFUND_STATUSES),
      default: REFUND_STATUSES.PENDING,
      required: true,
    },
    processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    processedAt: { type: Date, default: null },
    voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    voidedAt: { type: Date, default: null },
    note: {
      type: String,
      trim: true,
      maxlength: REFUND_LIMITS.NOTE_MAX,
      default: '',
    },
    statusHistory: [
      {
        status: { type: String, enum: Object.values(REFUND_STATUSES), required: true },
        at: { type: Date, required: true },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        note: { type: String, trim: true, maxlength: REFUND_LIMITS.NOTE_MAX, default: '' },
        _id: false,
      },
    ],
    deleted: { type: Boolean, default: false, select: false },
  },
  {
    timestamps: true,
    versionKey: 'version',
    toJSON: {
      virtuals: true,
      transform(doc, ret) {
        delete ret.__v;
        delete ret.version;
        return ret;
      },
    },
  }
);

refundSchema.index({ refundNumber: 1 }, { unique: true });
refundSchema.index({ status: 1, createdAt: -1 });
refundSchema.index({ order: 1, createdAt: -1 });
refundSchema.index({ customer: 1, createdAt: -1 });

module.exports = mongoose.model('Refund', refundSchema);
