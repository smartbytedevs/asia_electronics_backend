'use strict';

const { Types } = require('mongoose');
const { createBaseRepository } = require('../base/base.repository');
const { REVIEW_STATUSES } = require('./review.constants');

/**
 * Review persistence layer.
 *
 * Encapsulates database operations only — no authorization, business rules,
 * HTTP, or response formatting. Public visibility (`status: APPROVED`) is
 * always applied by the service (the public list filter comes from the
 * service, never from client input). `conditionalTransition` is the ATOMIC
 * CONFLICT POINT that makes concurrent approve/reject calls safe (a transition
 * applies only while the document is still in `fromStatus`).
 */
function createReviewRepository(model) {
  const base = createBaseRepository(model);

  return {
    ...base,

    /**
     * Atomic status transition: applies `update` (built by the service as
     * `{ $set, $push }`) ONLY while the review is still in `fromStatus`,
     * returning the updated doc (or `null` when the state no longer matches).
     */
    conditionalTransition: (id, fromStatus, update, options = {}) =>
      model.findOneAndUpdate(
        { _id: id, status: fromStatus },
        update,
        { new: true, runValidators: true, ...options }
      ),

    /**
     * Per-rating counts of a product's APPROVED reviews, e.g.
     * `[{ _id: 5, count: 3 }, { _id: 4, count: 1 }]`. The service derives the
     * rating summary (average + breakdown) from this — the aggregate is
     * computed on read, never denormalized onto the Product document.
     */
    aggregateApprovedRatings: async (productId) => {
      const docs = await model.aggregate([
        {
          $match: {
            productId: new Types.ObjectId(productId),
            status: REVIEW_STATUSES.APPROVED,
          },
        },
        { $group: { _id: '$rating', count: { $sum: 1 } } },
      ]);
      return docs.map((row) => ({ rating: Number(row._id), count: Number(row.count) }));
    },
  };
}

module.exports = { createReviewRepository };
