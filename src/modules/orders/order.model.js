'use strict';

const mongoose = require('mongoose');
const {
  ORDER_STATUSES,
  ORDER_LIMITS,
  DELIVERY_ZONES,
  PAYMENT_METHODS,
} = require('./order.constants');

const { Schema } = mongoose;

function isInteger(value) {
  return Number.isInteger(value);
}

/**
 * OrderItem — IMMUTABLE embedded snapshot subdocument of an Order (Phase 07,
 * ADR-0015). NOT a separate collection. Created once at checkout and never
 * updated afterwards, so historical orders stay stable even if the catalog or
 * inventory changes. Selling-side snapshots only — purchase prices are
 * deliberately NOT snapshotted in this phase.
 */
const orderItemSchema = new Schema(
  {
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
    variantAttributes: {
      type: Schema.Types.Mixed,
      default: {},
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
    lineTotalMinorUnits: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: isInteger,
        message: 'lineTotalMinorUnits must be an integer',
      },
    },
  },
  { _id: true }
);

const deliveryAddressSchema = new Schema(
  {
    fullName: { type: String, required: true, trim: true, maxlength: ORDER_LIMITS.FULL_NAME_MAX },
    phone: { type: String, required: true, trim: true, maxlength: ORDER_LIMITS.PHONE_MAX },
    line1: { type: String, required: true, trim: true, maxlength: ORDER_LIMITS.LINE_MAX },
    line2: { type: String, default: null, trim: true, maxlength: ORDER_LIMITS.LINE_MAX },
    city: { type: String, required: true, trim: true, maxlength: ORDER_LIMITS.CITY_MAX },
    area: { type: String, required: true, trim: true, maxlength: ORDER_LIMITS.AREA_MAX },
    district: { type: String, required: true, trim: true, maxlength: ORDER_LIMITS.DISTRICT_MAX },
    postalCode: { type: String, required: true, trim: true, maxlength: ORDER_LIMITS.POSTAL_CODE_MAX },
    country: { type: String, required: true, trim: true, maxlength: 2, uppercase: true },
    // Optional delivery-contact email (guest checkout): normalized the same way
    // as the User email (trimmed, lower-cased). Signed-in customers keep their
    // account email; this is the fallback recipient for the ORDER_PLACED email.
    email: {
      type: String,
      default: null,
      trim: true,
      lowercase: true,
      maxlength: ORDER_LIMITS.EMAIL_MAX,
    },
  },
  { _id: false }
);

const deliverySchema = new Schema(
  {
    address: { type: deliveryAddressSchema, required: true },
    zone: {
      type: String,
      required: true,
      enum: DELIVERY_ZONES,
    },
    deliveryFeeMinorUnits: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: isInteger,
        message: 'deliveryFeeMinorUnits must be an integer',
      },
    },
  },
  { _id: false }
);

const totalsSchema = new Schema(
  {
    itemsSubtotalMinorUnits: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: isInteger,
        message: 'itemsSubtotalMinorUnits must be an integer',
      },
    },
    totalDiscountMinorUnits: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: {
        validator: isInteger,
        message: 'totalDiscountMinorUnits must be an integer',
      },
    },
    deliveryFeeMinorUnits: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: {
        validator: isInteger,
        message: 'deliveryFeeMinorUnits must be an integer',
      },
    },
    grandTotalMinorUnits: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: isInteger,
        message: 'grandTotalMinorUnits must be an integer',
      },
    },
  },
  { _id: false }
);

const statusHistorySchema = new Schema(
  {
    status: {
      type: String,
      required: true,
      enum: ORDER_STATUSES,
    },
    at: { type: Date, required: true, default: Date.now },
    by: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    note: { type: String, default: null, trim: true, maxlength: ORDER_LIMITS.NOTE_MAX },
  },
  { _id: false }
);

/**
 * Order — created by checkout (Phase 07, ADR-0015).
 *
 * All money is integer minor units and SERVER-DERIVED. `orderNumber`
 * (`TAQ-YYYYMMDD-XXXXXX`) is generated server-side with a unique index and
 * bounded retry. `idempotencyKey` + `customerId` are a unique compound index
 * that makes checkout idempotent. `statusHistory` records every transition
 * with the acting user.
 */
const orderSchema = new Schema(
  {
    customerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    orderNumber: {
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
      default: ORDER_STATUSES.PENDING,
      enum: ORDER_STATUSES,
    },
    statusHistory: {
      type: [statusHistorySchema],
      required: true,
      default: [],
    },
    delivery: { type: deliverySchema, required: true },
    totals: { type: totalsSchema, required: true },
    items: {
      type: [orderItemSchema],
      required: true,
      default: [],
    },
    reservationReference: {
      type: new Schema(
        {
          reservationIds: {
            type: [Schema.Types.ObjectId],
            ref: 'Reservation',
            default: [],
          },
          referenceType: { type: String, required: true, trim: true },
        },
        { _id: false }
      ),
      default: null,
    },
    paymentMethod: {
      type: String,
      required: true,
      default: PAYMENT_METHODS.COD,
      enum: PAYMENT_METHODS,
    },
    notes: {
      type: String,
      default: null,
      trim: true,
      maxlength: ORDER_LIMITS.NOTES_MAX,
    },
  },
  { timestamps: true }
);

// Checkout idempotency: the DB-level guard against a retried checkout
// creating a second order (mapped to ORDER_IDEMPOTENCY_CONFLICT).
orderSchema.index({ customerId: 1, idempotencyKey: 1 }, { unique: true });

// Order-number generation races: unique index + bounded retry.
orderSchema.index({ orderNumber: 1 }, { unique: true });

// Customer order-history listing (newest first).
orderSchema.index({ customerId: 1, createdAt: -1 });

// Staff/admin order-listing filters.
orderSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('Order', orderSchema);
