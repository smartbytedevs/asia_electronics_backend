'use strict';

const mongoose = require('mongoose');
const {
  INVENTORY_LIMITS,
  RESERVATION_STATUS_VALUES,
} = require('./inventory.constants');

const { Schema } = mongoose;

function isPositiveInteger(value) {
  return Number.isInteger(value) && value >= 1;
}

/**
 * Reservation — a held portion of a variant's ONLINE stock (Phase 06,
 * ADR-0014).
 *
 * State machine: ACTIVE → RELEASED | CONSUMED | EXPIRED (terminal).
 * RELEASED returns the reserved quantity to availability; CONSUMED moves it
 * physically out of ONLINE; EXPIRED releases it after `expiresAt` passes.
 *
 * `referenceType`/`referenceId` are a GENERIC link to the business object
 * that holds the reservation (e.g. a future Order). Orders do not exist yet
 * in this phase, so callers use their own stable reference value. An active
 * reservation may not conflict with an existing ACTIVE reservation for the
 * SAME reference (RESERVATION_CONFLICT).
 */
const reservationSchema = new Schema(
  {
    // A reservation is scoped to a Simple Product (`productId`,
    // `productVariantId: null`) or a ProductVariant (`productId` +
    // `productVariantId`). Legacy variant-only reservations may have a null
    // `productId`; the variant still identifies the stock subject.
    productId: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      default: null,
      index: true,
    },
    productVariantId: {
      type: Schema.Types.ObjectId,
      ref: 'ProductVariant',
      default: null,
      index: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      max: INVENTORY_LIMITS.QUANTITY_MAX,
      validate: {
        validator: isPositiveInteger,
        message: 'quantity must be a positive integer',
      },
    },
    status: {
      type: String,
      required: true,
      enum: RESERVATION_STATUS_VALUES,
      default: 'ACTIVE',
      index: true,
    },
    expiresAt: {
      type: Date,
      default: null,
      index: true,
    },
    referenceType: {
      type: String,
      required: true,
      trim: true,
      maxlength: INVENTORY_LIMITS.REFERENCE_TYPE_MAX,
    },
    referenceId: {
      type: String,
      required: true,
      trim: true,
      maxlength: INVENTORY_LIMITS.REFERENCE_ID_MAX,
      index: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
    resolvedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

// A reservation must identify a stock subject: either a ProductVariant
// (`productVariantId`) or a Simple Product (`productId` with
// `productVariantId: null`).
reservationSchema.pre('validate', function requireSubject() {
  if (!this.productId && !this.productVariantId) {
    this.invalidate(
      'productVariantId',
      'productId or productVariantId is required'
    );
  }
});

// Lookups by variant and by reference.
reservationSchema.index({ productVariantId: 1, status: 1 });
reservationSchema.index({ productId: 1, status: 1 });
reservationSchema.index({ referenceType: 1, referenceId: 1, status: 1 });
// Expiry sweep support (future background job).
reservationSchema.index({ status: 1, expiresAt: 1 });

module.exports = mongoose.model('Reservation', reservationSchema);
