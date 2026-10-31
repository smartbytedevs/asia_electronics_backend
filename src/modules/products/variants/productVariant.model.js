'use strict';

const mongoose = require('mongoose');
const { PRODUCT_LIMITS } = require('./productVariant.constants');

const { Schema } = mongoose;

/**
 * ProductVariant — the SELLABLE variation of a Product (Phase 05, ADR-0013).
 *
 * Answering: "Which specific variation are we selling?" A stable persistent
 * `_id` is the reference key the future Inventory domain will use
 * (`productVariantId`); the size/color strings are catalog attributes, NOT
 * identifiers and NEVER inventory/stock.
 *
 * Deliberately NO stock fields (stock/availableStock/reservedStock). Inventory
 * is a dedicated future phase.
 *
 * purchasePriceOverride is sensitive and private to ADMIN responses.
 */
const productVariantSchema = new Schema(
  {
    productId: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
      index: true,
    },
    sku: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: PRODUCT_LIMITS.SKU_MAX,
    },
    // Free-form variant attributes, e.g. { size: "52", color: "Black" } or {}
    // for a default variant. Keys/values are validated at the application
    // layer. `attributeKey` is the canonical uniqueness key.
    attributes: {
      type: Schema.Types.Mixed,
      default: {},
    },
    // Canonical, order-stable serialization of `attributes` (sorted keys).
    // Unique compound index { productId, attributeKey } is the DATABASE-LEVEL
    // guard against duplicate variants under the same product (the service
    // performs friendly pre-checks too). Never exposed in API responses.
    attributeKey: {
      type: String,
      required: true,
      index: true,
    },
    // Optional per-variant price overrides (integer minor units). A variant
    // without an override uses the Product's default price.
    sellingPriceOverride: {
      type: Number,
      min: PRODUCT_LIMITS.PRICE_MIN,
      max: PRODUCT_LIMITS.PRICE_MAX,
    },
    // Sensitive supplier cost override — private to ADMIN responses.
    purchasePriceOverride: {
      type: Number,
      min: PRODUCT_LIMITS.PRICE_MIN,
      max: PRODUCT_LIMITS.PRICE_MAX,
    },
    // Catalog status: a variant can be deactivated without deleting it.
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// A SKU is globally unique — enforced at the database level.
productVariantSchema.index({ sku: 1 }, { unique: true });

// No duplicate variants under the same product (same attributes twice).
productVariantSchema.index({ productId: 1, attributeKey: 1 }, { unique: true });

// Listing a product's variants.
productVariantSchema.index({ productId: 1, isActive: 1 });

module.exports = mongoose.model('ProductVariant', productVariantSchema);
