'use strict';

const { createBaseRepository } = require('../base/base.repository');

/**
 * Category persistence layer.
 *
 * Encapsulates database operations only — no authorization, business rules,
 * HTTP, or response formatting (those belong in the category service/controller).
 * Never calls external APIs.
 */
function createCategoryRepository(model) {
  const base = createBaseRepository(model);

  return {
    ...base,

    findBySlug: (slug, options = {}) => base.findOne({ slug }, options),

    existsBySlug: (slug) => model.exists({ slug }).then(Boolean),
  };
}

module.exports = { createCategoryRepository };
