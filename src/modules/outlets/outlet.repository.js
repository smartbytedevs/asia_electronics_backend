'use strict';

const { createBaseRepository } = require('../base/base.repository');

/**
 * Outlet persistence layer (Phase 14).
 *
 * Encapsulates database operations only — no authorization, business rules,
 * HTTP, or response formatting. Never calls external APIs.
 */
function createOutletRepository(model) {
  const base = createBaseRepository(model);

  return {
    ...base,

    findByCode: (code, options = {}) => base.findOne({ code }, options),

    existsByCode: (code, options = {}) =>
      model.exists({ code }, options).then(Boolean),

    listActive: (options = {}) =>
      base.findMany({ isActive: true }, options),
  };
}

module.exports = { createOutletRepository };
