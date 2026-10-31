'use strict';

const { createBaseRepository } = require('../base/base.repository');

/**
 * Expense data-access layer (Phase 13). A repository over the model with
 * consistent method signatures: filters as the first argument, Mongoose
 * options second. `buildQuery` maps the OPT-IN `dateFrom`/`dateTo` filters to
 * an `expenseDate` range (the field analytics aggregates on) — the same
 * date-filter convention used by returns, payments, and refunds.
 */
function createExpenseRepository(model) {
  const base = createBaseRepository(model);

  return {
    ...base,

    buildQuery(filters = {}) {
      const query = {};
      if (filters.id) query._id = filters.id;
      if (filters.category) query.category = filters.category;
      if (filters.createdBy) query.createdBy = filters.createdBy;
      if (filters.dateFrom) {
        query.expenseDate = { ...(query.expenseDate || {}), $gte: filters.dateFrom };
      }
      if (filters.dateTo) {
        query.expenseDate = { ...(query.expenseDate || {}), $lte: filters.dateTo };
      }
      return query;
    },

    findOne(filter = {}, options = {}) {
      return model.findOne(this.buildQuery(filter), null, options).lean();
    },

    findMany(filter = {}, options = {}) {
      return model.find(this.buildQuery(filter), null, options).lean();
    },

    count(filter = {}) {
      return model.countDocuments(this.buildQuery(filter));
    },

    create: (data, options = {}) => model.create([data], options).then((docs) => docs[0]),
  };
}

module.exports = { createExpenseRepository };
