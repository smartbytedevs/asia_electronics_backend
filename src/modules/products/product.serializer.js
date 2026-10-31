'use strict';

const { DISCOUNT_TYPES, MONEY } = require('./product.constants');
const {
  availableOnlineQuantity,
  isOutOfStock,
} = require('../inventory/inventory.serializer');

/**
 * Product serialization (Phase 05, ADR-0013).
 *
 * Centralizes:
 * - Money math: effective selling price computation in integer minor units.
 * - Purchase-price privacy: public/STAFF representations NEVER include
 *   `purchasePrice` / `purchasePriceOverride`; admin representations do.
 * - Measurement-guide plain-object output: image URL (current format), plus
 *   legacy structured table data tolerated on existing records.
 *
 * Prices are integer minor units (paisa): ৳1,500.00 == 150000. Floating-point
 * money math is prohibited.
 */

/**
 * Effective selling price after a product-level discount.
 * - percentage: sellingPrice - round(sellingPrice * value / 100)
 * - fixed: sellingPrice - value
 * No discount → sellingPrice unchanged.
 */
function computeEffectiveSellingPrice(sellingPrice, discount) {
  if (!discount || typeof sellingPrice !== 'number') {
    return sellingPrice;
  }
  if (discount.type === DISCOUNT_TYPES.PERCENTAGE) {
    const off = Math.round((sellingPrice * discount.value) / 100);
    return Math.max(0, sellingPrice - off);
  }
  if (discount.type === DISCOUNT_TYPES.FIXED) {
    return Math.max(0, sellingPrice - discount.value);
  }
  return sellingPrice;
}

function variantBasePrice(variant, product) {
  if (typeof variant.sellingPriceOverride === 'number') {
    return variant.sellingPriceOverride;
  }
  return product.sellingPrice;
}

function serializeMeasurementGuide(guide) {
  if (!guide) {
    return null;
  }
  const out = { imageUrl: guide.imageUrl || null };
  // Legacy structured guides (existing records) keep their table data;
  // image-only guides (current format) expose just the image.
  if (Array.isArray(guide.sizes) && guide.sizes.length > 0) {
    out.unit = guide.unit;
    out.fields = (guide.fields || []).map((field) => ({
      key: field.key,
      label: field.label,
      sortOrder: field.sortOrder,
    }));
    out.sizes = guide.sizes.map((row) => ({
      size: row.size,
      measurements: row.measurements || {},
    }));
  }
  return out;
}

/**
 * Minimal category summary embedded in product responses. The full category
 * object is served by the category API (src/modules/categories).
 */
function serializeCategorySummary(category) {
  if (!category) {
    return null;
  }
  return {
    id: String(category._id || category.id),
    name: category.name,
    slug: category.slug,
    isActive: category.isActive,
  };
}

function serializeVariant(variant, product, { includePurchasePrice }) {
  const basePrice = variantBasePrice(variant, product);
  const safe = {
    id: String(variant._id || variant.id),
    sku: variant.sku,
    attributes: variant.attributes || {},
    sellingPrice: basePrice,
    effectiveSellingPrice: computeEffectiveSellingPrice(basePrice, product.discount),
    isActive: variant.isActive,
  };
  if (includePurchasePrice && typeof variant.purchasePriceOverride === 'number') {
    safe.purchasePriceOverride = variant.purchasePriceOverride;
  }
  return safe;
}

function serializeProduct(product, variants, category, { includePurchasePrice }) {
  const base = {
    id: String(product._id || product.id),
    name: product.name,
    slug: product.slug,
    description: product.description ?? '',
    categoryId: String(product.categoryId || (category && (category._id || category.id)) || ''),
    category: serializeCategorySummary(category),
    images: (product.images || []).map((image) => ({
      url: image.url,
      alt: image.alt ?? '',
      sortOrder: image.sortOrder,
    })),
    sellingPrice: product.sellingPrice,
    discount: product.discount
      ? { type: product.discount.type, value: product.discount.value }
      : null,
    effectiveSellingPrice: computeEffectiveSellingPrice(
      product.sellingPrice,
      product.discount
    ),
    featured: product.featured,
    newArrival: product.newArrival,
    bestDeal: product.bestDeal,
    isActive: product.isActive,
    measurementGuide: serializeMeasurementGuide(product.measurementGuide),
    brand: product.brand ?? '',
    modelNumber: product.modelNumber ?? '',
    warrantyPeriod: product.warrantyPeriod ?? null,
    specifications: product.specifications && typeof product.specifications === 'object' && !Array.isArray(product.specifications)
      ? product.specifications
      : {},
    stockKeepingUnit: product.stockKeepingUnit ?? null,
    variants: (variants || []).map((variant) =>
      serializeVariant(variant, product, { includePurchasePrice })
    ),
    createdAt: product.createdAt ? new Date(product.createdAt).toISOString() : null,
    updatedAt: product.updatedAt ? new Date(product.updatedAt).toISOString() : null,
  };
  if (includePurchasePrice) {
    base.purchasePrice = product.purchasePrice ?? null;
  }
  return base;
}

/**
 * Storefront-safe variant availability for the PUBLIC availability endpoint.
 * Derives from the backend's single source of truth (inventory.serializer):
 *
 *   availableQuantity = availableOnlineQuantity (online - reserved)
 *
 * A variant with NO inventory record is treated as out-of-stock (never creates
 * one). Offline stock, reservation records, movements, performedBy, and
 * purchase/cost data are NEVER exposed — only what the storefront needs.
 */
function serializeVariantAvailability(variantId, inventory) {
  const available = inventory ? availableOnlineQuantity(inventory) : 0;
  return {
    variantId,
    availableQuantity: Math.max(0, available),
    isOutOfStock: inventory ? isOutOfStock(inventory) : true,
  };
}

/**
 * Storefront-safe product-level availability for the PUBLIC availability
 * endpoint's Simple Product path (a product with no variants).
 */
function serializeProductAvailability(productId, inventory) {
  const available = inventory ? availableOnlineQuantity(inventory) : 0;
  return {
    productId: String(productId),
    availableQuantity: Math.max(0, available),
    isOutOfStock: inventory ? isOutOfStock(inventory) : true,
  };
}

/**
 * Lightweight storefront card for catalog LIST responses. Keeps the grid fast:
 * no variants, no measurement guide. Full product detail (variants + guide) is
 * served by the detail endpoints. Purchase cost is never included.
 */
function serializeProductCard(product, category) {
  const base = {
    id: String(product._id || product.id),
    name: product.name,
    slug: product.slug,
    categoryId: String(product.categoryId || (category && (category._id || category.id)) || ''),
    category: serializeCategorySummary(category),
    images: (product.images || []).map((image) => ({
      url: image.url,
      alt: image.alt ?? '',
      sortOrder: image.sortOrder,
    })),
    sellingPrice: product.sellingPrice,
    discount: product.discount
      ? { type: product.discount.type, value: product.discount.value }
      : null,
    effectiveSellingPrice: computeEffectiveSellingPrice(
      product.sellingPrice,
      product.discount
    ),
    featured: product.featured,
    newArrival: product.newArrival,
    bestDeal: product.bestDeal,
    isActive: product.isActive,
    brand: product.brand ?? '',
    modelNumber: product.modelNumber ?? '',
    warrantyPeriod: product.warrantyPeriod ?? null,
    specifications: product.specifications && typeof product.specifications === 'object' && !Array.isArray(product.specifications)
      ? product.specifications
      : {},
    stockKeepingUnit: product.stockKeepingUnit ?? null,
    createdAt: product.createdAt ? new Date(product.createdAt).toISOString() : null,
    updatedAt: product.updatedAt ? new Date(product.updatedAt).toISOString() : null,
  };
  return base;
}

/**
 * Public/STAFF representation — purchase cost is NEVER included.
 */
function serializePublicProduct(product, variants, category) {
  return serializeProduct(product, variants, category, { includePurchasePrice: false });
}

/**
 * ADMIN representation — includes purchasePrice and per-variant
 * purchasePriceOverride for profit/loss management.
 */
function serializeAdminProduct(product, variants, category) {
  return serializeProduct(product, variants, category, { includePurchasePrice: true });
}

module.exports = {
  computeEffectiveSellingPrice,
  variantBasePrice,
  serializeMeasurementGuide,
  serializeCategorySummary,
  serializePublicProduct,
  serializeAdminProduct,
  serializeVariant,
  serializeVariantAvailability,
  serializeProductAvailability,
  serializeProductCard,
  MONEY,
};
