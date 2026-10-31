'use strict';

const { createBaseRepository } = require('../base/base.repository');

/**
 * Product persistence layer.
 *
 * Encapsulates database operations only — no authorization, business rules,
 * HTTP, or response formatting (those belong in the product service/serializer).
 * Never calls external APIs.
 */
function createProductRepository(model) {
  const base = createBaseRepository(model);

  return {
    ...base,

    findBySlug: (slug, options = {}) => base.findOne({ slug }, options),

    existsBySlug: (slug, options = {}) =>
      model.exists({ slug }, options).then(Boolean),
  };
}

module.exports = { createProductRepository };
