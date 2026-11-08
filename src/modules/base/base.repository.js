'use strict';

/**
 * Minimal shared base repository.
 *
 * Repositories encapsulate Mongoose persistence operations. They MUST NOT:
 * - make business decisions (authorization belongs in services)
 * - read HTTP requests or send HTTP responses
 * - call external APIs
 *
 * This base is deliberately thin: it forwards filters/options to Mongoose and
 * does not hide Mongoose capabilities. Modules that need complex or
 * transactional queries should use module-specific repositories, which may
 * extend this base or call their model directly.
 *
 * Future usage (per feature module):
 *
 *   const { createBaseRepository } = require('../base/base.repository');
 *   const Product = require('./product.model');
 *   const productRepository = createBaseRepository(Product);
 *
 * `options` are standard Mongoose query options (e.g. `{ lean: true, select: '...' }`)
 * and are passed through unchanged.
 */
function createBaseRepository(model) {
  return {
    findById: (id, options = {}) => model.findById(id, null, options),

    findOne: (filter = {}, options = {}) => model.findOne(filter, null, options),

    findMany: (filter = {}, options = {}) => model.find(filter, null, options),

    /**
     * Batch lookup by id. Used by catalog list endpoints to avoid one query per
     * document (N+1) when resolving referenced documents.
     */
    findByIds: (ids = [], options = {}) =>
      model.find({ _id: { $in: ids } }, null, options),

    create: (data, options = {}) => model.create([data], options).then((docs) => docs[0]),

    updateById: (id, update, options = {}) =>
      model.findByIdAndUpdate(id, update, {
        new: true,
        runValidators: true,
        ...options,
      }),

    deleteById: (id, options = {}) => model.findByIdAndDelete(id, options),

    count: (filter = {}) => model.countDocuments(filter),
  };
}

module.exports = { createBaseRepository };
