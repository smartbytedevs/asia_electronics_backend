'use strict';

const mongoose = require('mongoose');
const {
  INVENTORY_LIMITS,
  MOVEMENT_TYPE_VALUES,
  STOCK_LOCATION_VALUES,
} = require('./inventory.constants');

const { Schema } = mongoose;

function isPositiveInteger(value) {
  return Number.isInteger(value) && value >= 1;
}

/**
 * InventoryMovement — IMMUTABLE audit record of one inventory mutation
 * (Phase 06, ADR-0014).
 *
 * Every operation that changes an Inventory record appends a movement in the
 * SAME MongoDB transaction. Movements are never updated or deleted; a
 * correction is a NEW movement (the ledger is a full audit trail).
 *
 * The movement subject mirrors the Inventory record: a Simple Product stores
 * `productId` with `productVariantId: null`; a ProductVariant stores both.
 * Either id may be null but the service always records exactly one subject.
 *
 * `quantity` is always a POSITIVE integer magnitude. Direction is carried by
 * `fromLocation` (stock decreases) and `toLocation` (stock increases); see
 * `MOVEMENT_TYPES` in inventory.constants.js. `performedBy` is the acting
 * `User._id`, ALWAYS derived from `req.user` — never from the request body.
 */
const inventoryMovementSchema = new Schema(
  {
    inventoryId: {
      type: Schema.Types.ObjectId,
      ref: 'Inventory',
      required: true,
    },
    // Simple-Product movements set `productId` with `productVariantId: null`.
    productId: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      default: null,
    },
    // ProductVariant movements set `productVariantId` (with `productId`).
    productVariantId: {
      type: Schema.Types.ObjectId,
      ref: 'ProductVariant',
      default: null,
    },
    // The Outlet the movement belongs to (Phase 14). `null` for movements on
    // the CENTRAL online pool; set for per-outlet movements (TRANSFER_OUT /
    // TRANSFER_IN, outlet initializations). Identifies the physical store in
    // the immutable audit trail without a join.
    outletId: {
      type: Schema.Types.ObjectId,
      ref: 'Outlet',
      default: null,
    },
    type: {
      type: String,
      required: true,
      enum: MOVEMENT_TYPE_VALUES,
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
    fromLocation: {
      type: String,
      enum: STOCK_LOCATION_VALUES,
      default: null,
    },
    toLocation: {
      type: String,
      enum: STOCK_LOCATION_VALUES,
      default: null,
    },
    reason: {
      type: String,
      trim: true,
      default: null,
      maxlength: INVENTORY_LIMITS.REASON_MAX,
    },
    referenceType: {
      type: String,
      default: null,
      maxlength: INVENTORY_LIMITS.REFERENCE_TYPE_MAX,
    },
    referenceId: {
      type: String,
      default: null,
      maxlength: INVENTORY_LIMITS.REFERENCE_ID_MAX,
    },
    performedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

inventoryMovementSchema.index({ productVariantId: 1, createdAt: -1 });
inventoryMovementSchema.index({ productId: 1, createdAt: -1 });
inventoryMovementSchema.index({ inventoryId: 1, createdAt: -1 });
inventoryMovementSchema.index({ type: 1, createdAt: -1 });

module.exports = mongoose.model('InventoryMovement', inventoryMovementSchema);
