'use strict';

const { createBaseRepository } = require('../base/base.repository');

/**
 * User persistence layer.
 *
 * Encapsulates database operations only — NO role/business authorization
 * decisions live here (those belong in the user service). Never reads HTTP
 * requests, never responds, never calls external APIs.
 */
function createUserRepository(model) {
  const base = createBaseRepository(model);

  return {
    ...base,

    findByAuthProviderId: (authProviderId, options = {}) =>
      base.findOne({ authProviderId }, options),

    findByEmail: (email, options = {}) => base.findOne({ email }, options),

    existsByAuthProviderId: (authProviderId) =>
      model.exists({ authProviderId }).then(Boolean),
  };
}

module.exports = { createUserRepository };
