'use strict';

const { createBaseRepository } = require('../base/base.repository');

/**
 * InventoryMovement persistence layer (Phase 06, ADR-0014).
 *
 * Movements are IMMUTABLE audit records: only `create` and read operations
 * exist. There is deliberately no update/delete surface — a correction is a
 * new movement.
 */
function createInventoryMovementRepository(model) {
  const base = createBaseRepository(model);

  return {
    ...base,
    findManyByProductVariant: (productVariantId, options = {}) =>
      base.findMany({ productVariantId }, options),

    findManyByProduct: (productId, options = {}) =>
      base.findMany({ productId }, options),

    findManyByInventory: (inventoryId, options = {}) =>
      base.findMany({ inventoryId }, options),
  };
}

module.exports = { createInventoryMovementRepository };
