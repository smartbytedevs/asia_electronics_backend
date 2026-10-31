'use strict';

const mongoose = require('mongoose');
const { INVENTORY_LIMITS } = require('./inventory.constants');

const { Schema } = mongoose;

function isInteger(value) {
  return Number.isInteger(value);
}

/**
 * Inventory — stock levels for a Product OR a ProductVariant (Phase 06, ADR-0014).
 *
 * Supports both:
 * 1. Simple Products (no variants): `productId` set, `productVariantId: null`.
 * 2. Variant Products: `productId` set AND `productVariantId` set.
 */
const inventorySchema = new Schema(
  {
    productId: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
      index: true,
    },
    productVariantId: {
      type: Schema.Types.ObjectId,
      ref: 'ProductVariant',
      default: null,
      index: true,
    },
    outletId: {
      type: Schema.Types.ObjectId,
      ref: 'Outlet',
      default: null,
    },
    onlineQuantity: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      max: INVENTORY_LIMITS.QUANTITY_MAX,
      validate: {
        validator: isInteger,
        message: 'onlineQuantity must be an integer',
      },
    },
    offlineQuantity: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      max: INVENTORY_LIMITS.QUANTITY_MAX,
      validate: {
        validator: isInteger,
        message: 'offlineQuantity must be an integer',
      },
    },
    reservedQuantity: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      max: INVENTORY_LIMITS.QUANTITY_MAX,
      validate: {
        validator: isInteger,
        message: 'reservedQuantity must be an integer',
      },
    },
    lowStockThreshold: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      max: INVENTORY_LIMITS.QUANTITY_MAX,
      validate: {
        validator: isInteger,
        message: 'lowStockThreshold must be an integer',
      },
    },
  },
  { timestamps: true }
);

// One inventory record per (product, variant, outlet) combination.
inventorySchema.index({ productId: 1, productVariantId: 1, outletId: 1 }, { unique: true });
inventorySchema.index({ onlineQuantity: 1, lowStockThreshold: 1 });

module.exports = mongoose.model('Inventory', inventorySchema);