'use strict';

const mongoose = require('mongoose');
const {
  STOCK_TRANSFER_STATUS_VALUES,
  STOCK_TRANSFER_LIMITS,
} = require('./stockTransfer.constants');

const { Schema } = mongoose;

function isPositiveInteger(value) {
  return Number.isInteger(value) && value >= 1;
}

/**
 * StockTransfer — an atomic movement of `quantity` of ONE product variant
 * between two physical outlets (Phase 14).
 *
 * A transfer is created in its terminal COMPLETED state inside the SAME
 * MongoDB transaction that moves the stock (source outlet decreases,
 * destination outlet increases) and appends the two immutable
 * InventoryMovement audit records (TRANSFER_OUT / TRANSFER_IN, linked via
 * `referenceType: 'STOCK_TRANSFER'` / `referenceId`). If any step fails the
 * whole transfer rolls back — there is never a partial transfer.
 *
 * `createdBy` is the acting `User._id`, ALWAYS derived from `req.user` and
 * never from the request body. `status`/`completedAt` are server-set.
 */
const stockTransferSchema = new Schema(
  {
    sourceOutletId: {
      type: Schema.Types.ObjectId,
      ref: 'Outlet',
      required: true,
    },
    destinationOutletId: {
      type: Schema.Types.ObjectId,
      ref: 'Outlet',
      required: true,
    },
    productVariantId: {
      type: Schema.Types.ObjectId,
      ref: 'ProductVariant',
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      max: STOCK_TRANSFER_LIMITS.QUANTITY_MAX,
      validate: {
        validator: isPositiveInteger,
        message: 'quantity must be a positive integer',
      },
    },
    status: {
      type: String,
      required: true,
      enum: STOCK_TRANSFER_STATUS_VALUES,
      default: 'COMPLETED',
    },
    completedAt: {
      type: Date,
      default: null,
    },
    reason: {
      type: String,
      trim: true,
      default: null,
      maxlength: STOCK_TRANSFER_LIMITS.REASON_MAX,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  { timestamps: true }
);

// Admin list ordering and per-outlet audit lookups.
stockTransferSchema.index({ createdAt: -1 });
stockTransferSchema.index({ sourceOutletId: 1, createdAt: -1 });
stockTransferSchema.index({ destinationOutletId: 1, createdAt: -1 });
stockTransferSchema.index({ productVariantId: 1, createdAt: -1 });

module.exports = mongoose.model('StockTransfer', stockTransferSchema);
