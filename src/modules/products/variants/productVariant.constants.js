'use strict';

const { PRODUCT_LIMITS } = require('../product.constants');

/**
 * ProductVariant constants (Phase 05).
 *
 * A variant is the SELLABLE variation of a Product (ADR-0013):
 * "Which specific variation are we selling?" It carries a stable persistent
 * identifier (future Inventory references `productVariantId`), a globally
 * unique SKU, and variant attributes (size/color/...).
 */

/**
 * Whitelist of every client-writable ProductVariant field. Shared by the
 * variant validator/service to reject unknown/immutable/operator keys.
 * `productId` is deliberately NOT writable here — a variant can never move
 * between products except through a dedicated business operation.
 */
const VARIANT_FIELDS = Object.freeze([
  'sku',
  'attributes',
  'sellingPriceOverride',
  'purchasePriceOverride',
  'isActive',
]);

const VARIANT_MESSAGES = Object.freeze({
  VARIANT_NOT_FOUND: 'Product variant not found',
  INVALID_VARIANT: 'Invalid product variant data',
  VARIANT_SKU_ALREADY_EXISTS: 'A variant with this SKU already exists',
  VARIANT_DUPLICATE_ATTRIBUTES:
    'A variant with the same attributes already exists for this product',
  PURCHASE_PRICE_ADMIN_ONLY:
    'Only administrators can set or view purchase price information',
});

/**
 * Auto-generated SKU rules. When the client omits `sku` (the normal product
 * form manages sizes, not SKUs), the variant service derives one from the
 * product slug + attribute values and guarantees uniqueness against the
 * global SKU index.
 */
const SKU_GENERATION = Object.freeze({
  // Reserve room for a `-<n>` collision suffix within PRODUCT_LIMITS.SKU_MAX.
  BASE_MAX: PRODUCT_LIMITS.SKU_MAX - 4,
  // Per-attribute fragment length in the generated SKU.
  VALUE_MAX: 20,
  // Upper bound on collision-suffix attempts before failing loudly.
  MAX_ATTEMPTS: 100,
});

module.exports = {
  VARIANT_FIELDS,
  VARIANT_MESSAGES,
  SKU_GENERATION,
  PRODUCT_LIMITS,
};
