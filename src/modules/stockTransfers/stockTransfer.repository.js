'use strict';

const { createBaseRepository } = require('../base/base.repository');

/**
 * StockTransfer persistence layer (Phase 14).
 *
 * Encapsulates database operations only — no authorization, business rules,
 * HTTP, or response formatting. Never calls external APIs.
 */
function createStockTransferRepository(model) {
  const base = createBaseRepository(model);

  return {
    ...base,

    findManyByOutlet: (outletId, options = {}) =>
      base.findMany(
        { $or: [{ sourceOutletId: outletId }, { destinationOutletId: outletId }] },
        options
      ),

    findManyByVariant: (productVariantId, options = {}) =>
      base.findMany({ productVariantId }, options),
  };
}

module.exports = { createStockTransferRepository };
