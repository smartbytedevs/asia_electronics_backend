'use strict';

const mongoose = require('mongoose');
const {
  PRODUCT_LIMITS,
  DISCOUNT_TYPES,
  MEASUREMENT_UNITS,
  slugify,
} = require('./product.constants');

const { Schema } = mongoose;

const measurementFieldSchema = new Schema(
  {
    key: {
      type: String,
      required: true,
      trim: true,
      maxlength: PRODUCT_LIMITS.MEASUREMENT_FIELD_KEY_MAX,
    },
    label: {
      type: String,
      required: true,
      trim: true,
      maxlength: PRODUCT_LIMITS.MEASUREMENT_LABEL_MAX,
    },
    sortOrder: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { _id: false }
);

const measurementSizeSchema = new Schema(
  {
    // Size identifier as the customer sees it: "50", "52", "S", "M", "L".
    size: {
      type: String,
      required: true,
      trim: true,
      maxlength: PRODUCT_LIMITS.MEASUREMENT_SIZE_MAX,
    },
    // Keyed by the guide's field keys, e.g. { abayaLength: 50, bust: 38 }.
    // Validated strictly at the application layer (product.validation.js);
    // the schema keeps the object because field keys are product-specific.
    measurements: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  { _id: false }
);

const measurementGuideSchema = new Schema(
  {
    // Image-only measurement guide (current format). The image is uploaded
    // separately through the media system and the resulting URL is stored here.
    imageUrl: {
      type: String,
      trim: true,
      maxlength: PRODUCT_LIMITS.IMAGE_URL_MAX,
    },
    // Legacy structured measurement-table fields. Tolerated on EXISTING records
    // only — new products never set these (see product.validation.js).
    unit: {
      type: String,
      enum: MEASUREMENT_UNITS,
      set: (value) => (typeof value === 'string' ? value.toLowerCase() : value),
    },
    fields: {
      type: [measurementFieldSchema],
    },
    sizes: {
      type: [measurementSizeSchema],
    },
  },
  { _id: false }
);

const imageSchema = new Schema(
  {
    url: {
      type: String,
      required: true,
      trim: true,
      maxlength: PRODUCT_LIMITS.IMAGE_URL_MAX,
    },
    alt: {
      type: String,
      trim: true,
      maxlength: PRODUCT_LIMITS.IMAGE_ALT_MAX,
    },
    sortOrder: {
      type: Number,
      default: 0,
      min: PRODUCT_LIMITS.IMAGE_SORT_ORDER_MIN,
      max: PRODUCT_LIMITS.IMAGE_SORT_ORDER_MAX,
    },
  },
  { _id: false }
);

const discountSchema = new Schema(
  {
    // "percentage" (0 < value <= 100) or "fixed" (integer minor units).
    type: {
      type: String,
      required: true,
      enum: [DISCOUNT_TYPES.PERCENTAGE, DISCOUNT_TYPES.FIXED],
    },
    value: {
      type: Number,
      required: true,
    },
  },
  { _id: false }
);

/**
 * Product — catalog-level item (Phase 05, ADR-0013).
 *
 * Answering: "What are we selling?" Product carries catalog identity,
 * description, category reference, images, marketing flags, default pricing
 * and the measurement guide. Sellable variations live in ProductVariant.
 *
 * Deliberately NO inventory fields (stock/availableStock/reservedStock) —
 * inventory is a dedicated future phase that references ProductVariant IDs.
 * purchasePrice is sensitive and must never be serialized into public/STAFF
 * responses (the serializer + controller enforce this).
 */
const productSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: PRODUCT_LIMITS.NAME_MAX,
    },
    slug: {
      type: String,
      required: true,
      trim: true,
      set: slugify,
      maxlength: PRODUCT_LIMITS.SLUG_MAX,
    },
    description: {
      type: String,
      trim: true,
      maxlength: PRODUCT_LIMITS.DESCRIPTION_MAX,
      default: '',
    },
    categoryId: {
      type: Schema.Types.ObjectId,
      ref: 'Category',
      required: true,
      index: true,
    },
    images: {
      type: [imageSchema],
      default: [],
    },
    // Default/base economics in integer minor units (paisa).
    sellingPrice: {
      type: Number,
      required: true,
      min: PRODUCT_LIMITS.PRICE_MIN,
      max: PRODUCT_LIMITS.PRICE_MAX,
    },
    // Sensitive business information. Private to ADMIN responses.
    purchasePrice: {
      type: Number,
      min: PRODUCT_LIMITS.PRICE_MIN,
      max: PRODUCT_LIMITS.PRICE_MAX,
    },
    discount: {
      type: discountSchema,
      default: null,
    },
    // Catalog classification flags — no separate collections.
    featured: { type: Boolean, default: false },
    newArrival: { type: Boolean, default: false },
    bestDeal: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    // Per-product measurement guide: an optional image URL (current format).
    // Legacy structured tables are tolerated on existing records.
    measurementGuide: {
      type: measurementGuideSchema,
      default: null,
    },
    // Electronics extensions
    brand: {
      type: String,
      trim: true,
      maxlength: PRODUCT_LIMITS.BRAND_MAX,
      default: '',
    },
    modelNumber: {
      type: String,
      trim: true,
      maxlength: PRODUCT_LIMITS.MODEL_NUMBER_MAX,
      default: '',
    },
    warrantyPeriod: {
      type: Number,
      min: PRODUCT_LIMITS.WARRANTY_PERIOD_MIN,
      max: PRODUCT_LIMITS.WARRANTY_PERIOD_MAX,
      // warranty period in months
    },
    specifications: {
      type: Schema.Types.Mixed,
      default: {},
      // JSON metadata object for hardware specs
    },
    stockKeepingUnit: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: PRODUCT_LIMITS.SKU_MAX,
    },
  },
  { timestamps: true }
);

// Stable public URL identifier — unique. Final consistency layer for slug
// collisions (the service additionally performs friendly pre-checks).
productSchema.index({ slug: 1 }, { unique: true });

// Public catalog listing: active products ordered by creation (newest).
productSchema.index({ isActive: 1, createdAt: -1 });

// Browse a category's newest active products.
productSchema.index({ isActive: 1, categoryId: 1, createdAt: -1 });

// Price-ordered active catalog (priceAsc / priceDesc).
productSchema.index({ isActive: 1, sellingPrice: 1 });

// Optional unique product-level SKU
productSchema.index({ stockKeepingUnit: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Product', productSchema);
