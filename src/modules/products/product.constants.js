'use strict';

const slugify = require('../../utils/slugify');

/**
 * Product catalog constants (Phase 05).
 *
 * `slugify` is the SINGLE backend slug implementation (src/utils/slugify.js);
 * re-exported here for convenience, never re-implemented.
 */

const PRODUCT_LIMITS = Object.freeze({
  NAME_MAX: 200,
  SLUG_MAX: 220,
  DESCRIPTION_MAX: 5000,
  // Images
  IMAGES_MAX: 10,
  IMAGE_URL_MAX: 500,
  IMAGE_ALT_MAX: 300,
  IMAGE_SORT_ORDER_MIN: 0,
  IMAGE_SORT_ORDER_MAX: 999,
  // Money (integer minor units — see below)
  PRICE_MAX: 100_000_000,
  PRICE_MIN: 1,
  // Discount
  DISCOUNT_PERCENT_MAX: 100,
  // Measurement guide
  MEASUREMENT_FIELDS_MAX: 20,
  MEASUREMENT_SIZES_MAX: 50,
  MEASUREMENT_FIELD_KEY_MAX: 60,
  MEASUREMENT_LABEL_MAX: 80,
  MEASUREMENT_SIZE_MAX: 40,
  MEASUREMENT_VALUE_MAX: 10000,
  MEASUREMENT_VALUE_PRECISION: 2,
  // Variants
  VARIANTS_MAX: 50,
  SKU_MAX: 64,
  ATTRIBUTE_KEY_MAX: 40,
  ATTRIBUTE_VALUE_MAX: 60,
  ATTRIBUTES_MAX: 10,
  // Electronics extensions
  BRAND_MAX: 100,
  MODEL_NUMBER_MAX: 100,
  WARRANTY_PERIOD_MIN: 0,
  WARRANTY_PERIOD_MAX: 120,
});

/**
 * Money representation — DECIDED (ADR-0013):
 *
 * All prices are stored as INTEGER MINOR UNITS (paisa), i.e. ৳1,500.00 is
 * stored as 150000. There is exactly one representation for money across the
 * backend; floating-point price math is prohibited. Divide by 100 to display.
 *
 * Rationale: MongoDB numbers are IEEE-754 doubles, which represent integers
 * exactly up to 2^53. Storing whole minor units avoids the accumulation and
 * comparison errors of naive floating-point money arithmetic.
 */
const MONEY = Object.freeze({
  MINOR_UNITS_PER_MAJOR: 100,
  CURRENCY: 'BDT',
});

/**
 * Discount representation (product-level only):
 * - `percentage`: `value` is 0 < value <= 100 (percent off sellingPrice).
 * - `fixed`: `value` is an integer minor-unit amount 0 < value <= sellingPrice.
 *
 * Effective selling price is always computed centrally (never stored) in
 * product.serializer.js: for `percentage` it is
 * `sellingPrice - round(sellingPrice * value / 100)`; for `fixed` it is
 * `sellingPrice - value`.
 */
const DISCOUNT_TYPES = Object.freeze({
  PERCENTAGE: 'percentage',
  FIXED: 'fixed',
});

/**
 * Controlled measurement units. Normalized to lower-case at the application
 * layer; never stored as "IN", "inches", or "".
 */
const MEASUREMENT_UNITS = Object.freeze(['inch', 'cm']);

/**
 * Safe measurement field-key pattern. Keys are application-defined identifiers
 * (e.g. `abayaLength`, `bust`, `hip`, `sleeve`, `shoulder`) and are used as
 * object keys inside `measurements`. This blocks unsafe/Mongo-operator keys.
 */
const MEASUREMENT_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9]{0,59}$/;

/**
 * Product catalog flag names (featured / newArrival / bestDeal). Used by the
 * public list filter allowlist.
 */
const PRODUCT_FLAGS = Object.freeze(['featured', 'newArrival', 'bestDeal']);

/**
 * Whitelist of every client-writable Product field. Shared by the validator
 * and the service to reject unknown/immutable/operator keys (`$set`, `_id`,
 * `createdAt`, `__v`, ...). Prevents mass-assignment and operator injection.
 */
const PRODUCT_FIELDS = Object.freeze([
  'name',
  'slug',
  'description',
  'categoryId',
  'images',
  'sellingPrice',
  'purchasePrice',
  'discount',
  'featured',
  'newArrival',
  'bestDeal',
  'isActive',
  'measurementGuide',
  'variants',
  // Electronics extensions
  'brand',
  'modelNumber',
  'warrantyPeriod',
  'specifications',
  'stockKeepingUnit',
]);

/**
 * Public list filters and sort options (see docs/api-contract.md §Products).
 * Only these are accepted; arbitrary MongoDB query/sort expressions are never
 * passed through.
 */
const PRODUCT_LIST_FILTERS = Object.freeze([
  'categoryId',
  'featured',
  'newArrival',
  'bestDeal',
]);

const PRODUCT_SORTS = Object.freeze({
  NEWEST: 'newest',
  PRICE_ASC: 'priceAsc',
  PRICE_DESC: 'priceDesc',
  FEATURED: 'featured',
});

const PAGINATION = Object.freeze({
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
});

const PRODUCT_MESSAGES = Object.freeze({
  LIST_FETCHED: 'Products retrieved successfully',
  PRODUCT_FETCHED: 'Product retrieved successfully',
  AVAILABILITY_FETCHED: 'Product availability retrieved successfully',
  PRODUCT_CREATED: 'Product created successfully',
  PRODUCT_UPDATED: 'Product updated successfully',
  PRODUCT_NOT_FOUND: 'Product not found',
  INVALID_PRODUCT: 'Invalid product data',
  PRODUCT_SLUG_ALREADY_EXISTS: 'A product with this slug already exists',
  PRODUCT_SKU_ALREADY_EXISTS: 'A product with this SKU already exists',
  INVALID_CATEGORY: 'Invalid category for this product',
  INVALID_MEASUREMENT_GUIDE: 'Invalid measurement guide',
  VARIANT_NOT_FOUND: 'Product variant not found',
  INVALID_VARIANT: 'Invalid product variant data',
  VARIANT_SKU_ALREADY_EXISTS: 'A variant with this SKU already exists',
  VARIANT_DUPLICATE_ATTRIBUTES:
    'A variant with the same attributes already exists for this product',
  PURCHASE_PRICE_ADMIN_ONLY:
    'Only administrators can set or view purchase price information',
});

module.exports = {
  PRODUCT_LIMITS,
  MONEY,
  DISCOUNT_TYPES,
  MEASUREMENT_UNITS,
  MEASUREMENT_KEY_PATTERN,
  PRODUCT_FLAGS,
  PRODUCT_FIELDS,
  PRODUCT_LIST_FILTERS,
  PRODUCT_SORTS,
  PAGINATION,
  PRODUCT_MESSAGES,
  slugify,
};
