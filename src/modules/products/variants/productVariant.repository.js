'use strict';

const { createBaseRepository } = require('../../base/base.repository');

/**
 * ProductVariant persistence layer.
 *
 * Encapsulates database operations only — no authorization, business rules,
 * HTTP, or response formatting. Never calls external APIs.
 */
function createVariantRepository(model) {
  const base = createBaseRepository(model);

  return {
    ...base,

    findBySku: (sku, options = {}) => base.findOne({ sku }, options),

    existsBySku: (sku, options = {}) =>
      model.exists({ sku }, options).then(Boolean),

    findByProduct: (productId, options = {}) =>
      base.findMany({ productId }, options),

    /**
     * Batch variant lookup for a set of products. Catalog list endpoints use
     * this to attach card variants in one query instead of one query per
     * product.
     */
    findByProductIds: (productIds = [], options = {}) =>
      base.findMany({ productId: { $in: productIds } }, options),

    findOneByProduct: (productId, filter = {}, options = {}) =>
      base.findOne({ productId, ...filter }, options),

    findByProductAndId: (productId, variantId, options = {}) =>
      base.findOne({ productId, _id: variantId }, options),
  };
}

module.exports = { createVariantRepository };
