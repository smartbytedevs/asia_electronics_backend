'use strict';

const mongoose = require('mongoose');
const {
  COURIER_STATUSES,
  COURIER_PROVIDERS,
  COURIER_LIMITS,
} = require('./courier.constants');

const { Schema } = mongoose;

const courierStatusHistorySchema = new Schema(
  {
    status: {
      type: String,
      required: true,
      enum: COURIER_STATUSES,
    },
    at: { type: Date, required: true, default: Date.now },
    // Null for system-initiated transitions (webhooks, reconciliation); a
    // User id for actor-initiated ones (dispatch, cancel, retry).
    by: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    note: { type: String, default: null, trim: true, maxlength: COURIER_LIMITS.NOTE_MAX },
    // Free-text provider status label captured when the transition arrived via
    // a webhook/reconciliation (e.g. 'Delivered'). NOT a local enum — it is a
    // provider-supplied snapshot.
    providerStatus: { type: String, default: null, trim: true },
  },
  { _id: false }
);

const submissionSchema = new Schema(
  {
    // Snapshot of the normalized payload sent to the provider. `Mixed` because
    // payloads are provider-specific; kept for auditability of retries.
    payload: { type: Schema.Types.Mixed, default: null },
    attempts: { type: Number, required: true, default: 0, min: 0 },
    lastSubmitAttemptAt: { type: Date, default: null },
    submittedAt: { type: Date, default: null },
    lastError: {
      code: { type: String, default: null, trim: true },
      message: {
        type: String,
        default: null,
        trim: true,
        maxlength: COURIER_LIMITS.PROVIDER_ERROR_MESSAGE_MAX,
      },
      raw: { type: Schema.Types.Mixed, default: null },
    },
  },
  { _id: false }
);

const providerStatusSchema = new Schema(
  {
    // Raw provider status label (e.g. Pathao 'Pending'/'Out for Delivery').
    status: { type: String, default: null, trim: true },
    updatedAt: { type: Date, default: null },
    // Last time this shipment was reconciled with the provider (poll/webhook).
    fetchedAt: { type: Date, default: null },
  },
  { _id: false }
);

const feesSchema = new Schema(
  {
    providerDeliveryFeeMinorUnits: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    currency: { type: String, required: true, default: 'BDT', trim: true },
  },
  { _id: false }
);

const cancelSchema = new Schema(
  {
    requestedAt: { type: Date, default: null },
    confirmedAt: { type: Date, default: null },
    lastError: {
      code: { type: String, default: null, trim: true },
      message: {
        type: String,
        default: null,
        trim: true,
        maxlength: COURIER_LIMITS.PROVIDER_ERROR_MESSAGE_MAX,
      },
    },
  },
  { _id: false }
);

const dispatchSchema = new Schema(
  {
    requestedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    requestedAt: { type: Date, default: null },
    note: { type: String, default: null, trim: true, maxlength: COURIER_LIMITS.NOTE_MAX },
  },
  { _id: false }
);

/**
 * CourierShipment — ONE document per Order (unique `orderId`), Phase 09,
 * ADR-0017. Wraps a single logical delivery handoff to a courier provider.
 *
 * The local `status` is the authoritative lifecycle; provider transitions are
 * applied through courier.state-machine.js only. `consignmentId` is the
 * provider tracking number (null until ACTIVE). `merchantReference` snapshots
 * the order's orderNumber so webhooks can match shipments that arrive before
 * the consignment id is persisted.
 */
const courierShipmentSchema = new Schema(
  {
    orderId: {
      type: Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
    },
    merchantReference: {
      type: String,
      required: true,
      trim: true,
      maxlength: COURIER_LIMITS.MERCHANT_REFERENCE_MAX,
    },
    provider: {
      type: String,
      required: true,
      enum: COURIER_PROVIDERS,
    },
    status: {
      type: String,
      required: true,
      default: COURIER_STATUSES.PENDING,
      enum: COURIER_STATUSES,
    },
    statusHistory: {
      type: [courierStatusHistorySchema],
      required: true,
      default: [],
    },
    consignmentId: { type: String, default: null, trim: true },
    amountToCollectMinorUnits: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    submission: { type: submissionSchema, default: () => ({}) },
    providerStatus: { type: providerStatusSchema, default: () => ({}) },
    fees: { type: feesSchema, default: () => ({}) },
    cancel: { type: cancelSchema, default: () => ({}) },
    dispatch: { type: dispatchSchema, default: () => ({}) },
  },
  { timestamps: true }
);

// One shipment per order — the DB-level idempotency guard for dispatch.
courierShipmentSchema.index({ orderId: 1 }, { unique: true });

// Webhook lookup by provider consignment id (only present once ACTIVE).
courierShipmentSchema.index({ consignmentId: 1 }, { unique: true, sparse: true });

// Webhook fallback lookup by order number (snapshotted at creation).
courierShipmentSchema.index({ merchantReference: 1 }, { unique: true });

// Reconciliation scan: open shipments ordered by last check time.
courierShipmentSchema.index({ status: 1, 'providerStatus.fetchedAt': 1 });

// Admin listing (newest first).
courierShipmentSchema.index({ createdAt: -1 });

module.exports = mongoose.model('CourierShipment', courierShipmentSchema);
