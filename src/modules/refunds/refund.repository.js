'use strict';

const { createBaseRepository } = require('../base/base.repository');

/**
 * Refund data-access layer (Phase 10, ADR-0018). A repository over the model
 * with consistent method signatures: filters as the first argument, Mongoose
 * options (e.g. `{ session }`) second. `buildQuery` applies the soft-delete
 * guard and every OPT-IN filter so an empty query returns EVERYTHING.
 *
 * `conditionalTransition` is the ATOMIC CONFLICT POINT for the refund state
 * machine — an update applies only while the refund is still in `fromStatus`,
 * so concurrent process/void calls cannot double-apply.
 */
function createRefundRepository(model) {
  const base = createBaseRepository(model);

  return {
    ...base,

    buildQuery(filters = {}) {
      const query = { deleted: { $ne: true } };
      if (filters.id) query._id = filters.id;
      if (filters.status) query.status = filters.status;
      if (filters.returnId) query.return = filters.returnId;
      if (filters.orderId) query.order = filters.orderId;
      if (filters.customerId) query.customer = filters.customerId;
      if (filters.paymentId) query.paymentId = filters.paymentId;
      if (filters.refundNumber) query.refundNumber = filters.refundNumber;
      if (filters.dateFrom) query.createdAt = { ...(query.createdAt || {}), $gte: filters.dateFrom };
      if (filters.dateTo) query.createdAt = { ...(query.createdAt || {}), $lte: filters.dateTo };
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

    /**
     * Atomic status transition: applies `update` (built by the service as
     * `{ $set, $push }`) ONLY while the refund is still in `fromStatus`,
     * returning the updated doc (or `null` when the state no longer matches).
     */
    conditionalTransition: (id, fromStatus, update, options = {}) =>
      model
        .findOneAndUpdate(
          { _id: id, status: fromStatus, deleted: { $ne: true } },
          update,
          { new: true, runValidators: true, ...options }
        )
        .lean(),
  };
}

module.exports = { createRefundRepository };
