'use strict';

const {
  computeEffectiveSellingPrice,
  variantBasePrice,
} = require('../products/product.serializer');

/**
 * Cart serialization (Phase 07, ADR-0015).
 *
 * The cart stores NO money — every money/availability value here is DERIVED
 * live from the catalog + inventory at read time and is informational (the
 * authoritative numbers are recomputed at checkout). Lines reference live
 * product/variant docs supplied by the service; inactive catalog entries
 * serialize with the live data but are flagged unavailable.
 */

function serializeCart(cart, lines) {
  const items = (cart.items || []).map((item) => {
    const line = (lines || {})[String(item._id)] || {};
    const product = line.product || null;
    const variant = line.variant || null;
    const inventory = line.inventory || null;

    const priceMinorUnits = product
      ? computeEffectiveSellingPrice(
          variant ? variantBasePrice(variant, product) : product.sellingPrice,
          product.discount
        )
      : null;
    const isAvailable = Boolean(
      product && product.isActive && (variant ? variant.isActive : true)
    );

    return {
      id: String(item._id),
      productVariantId: item.productVariantId ? String(item.productVariantId) : null,
      productId: item.productId ? String(item.productId) : null,
      quantity: item.quantity,
      selectedSize: item.selectedSize ?? null,
      product: product
        ? { id: String(product._id || product.id), name: product.name, slug: product.slug }
        : null,
      variant: variant
        ? { id: String(variant._id || variant.id), sku: variant.sku, attributes: variant.attributes || {} }
        : null,
      priceMinorUnits: typeof priceMinorUnits === 'number' ? priceMinorUnits : null,
      availableOnlineQuantity:
        inventory && typeof inventory.onlineQuantity === 'number'
          ? Number(inventory.onlineQuantity) - Number(inventory.reservedQuantity || 0)
          : null,
      isAvailable,
    };
  });

  return {
    id: String(cart._id || cart.id),
    customerId: String(cart.customerId || ''),
    items,
    itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    itemsSubtotalMinorUnits: items.reduce(
      (sum, item) => sum + (typeof item.priceMinorUnits === 'number' ? item.priceMinorUnits * item.quantity : 0),
      0
    ),
    isCheckedOut: Boolean(cart.isCheckedOut),
    createdAt: cart.createdAt ? new Date(cart.createdAt).toISOString() : null,
    updatedAt: cart.updatedAt ? new Date(cart.updatedAt).toISOString() : null,
  };
}

module.exports = { serializeCart };
