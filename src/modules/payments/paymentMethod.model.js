'use strict';

const mongoose = require('mongoose');
const {
  PAYMENT_METHOD_TYPES,
  PAYMENT_LIMITS,
} = require('./payment.constants');

const { Schema } = mongoose;

/**
 * PaymentMethod — ADMIN-managed manual-payment instructions (Phase 08,
 * ADR-0016).
 *
 * Deactivation is ALWAYS soft (`isActive: false`): methods are never hard
 * deleted, because payments snapshot the method at submission time so history
 * stays readable. `code` is unique, server-normalised to uppercase
 * `[A-Z0-9_]{1,50}` (e.g. `BANK_TRANSFER`).
 */
const paymentMethodSchema = new Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      match: PAYMENT_LIMITS.CODE_PATTERN,
    },
    displayName: {
      type: String,
      required: true,
      trim: true,
      maxlength: PAYMENT_LIMITS.DISPLAY_NAME_MAX,
    },
    type: {
      type: String,
      required: true,
      default: PAYMENT_METHOD_TYPES.MANUAL,
      enum: PAYMENT_METHOD_TYPES,
    },
    metadata: {
      type: new Schema(
        {
          accountName: { type: String, default: null, trim: true, maxlength: PAYMENT_LIMITS.METADATA_FIELD_MAX },
          accountNumber: { type: String, default: null, trim: true, maxlength: PAYMENT_LIMITS.METADATA_FIELD_MAX },
          bankName: { type: String, default: null, trim: true, maxlength: PAYMENT_LIMITS.METADATA_FIELD_MAX },
          branch: { type: String, default: null, trim: true, maxlength: PAYMENT_LIMITS.METADATA_FIELD_MAX },
          district: { type: String, default: null, trim: true, maxlength: PAYMENT_LIMITS.METADATA_FIELD_MAX },
          accountType: { type: String, default: null, trim: true, maxlength: PAYMENT_LIMITS.METADATA_FIELD_MAX },
          routingNumber: { type: String, default: null, trim: true, maxlength: PAYMENT_LIMITS.METADATA_FIELD_MAX },
          instructions: { type: String, default: null, trim: true, maxlength: PAYMENT_LIMITS.METADATA_FIELD_MAX },
        },
        { _id: false }
      ),
      default: {},
    },
    isActive: {
      type: Boolean,
      required: true,
      default: true,
    },
    sortOrder: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      max: PAYMENT_LIMITS.SORT_ORDER_MAX,
    },
  },
  { timestamps: true }
);

paymentMethodSchema.index({ code: 1 }, { unique: true });
paymentMethodSchema.index({ isActive: 1, sortOrder: 1 });

module.exports = mongoose.model('PaymentMethod', paymentMethodSchema);
