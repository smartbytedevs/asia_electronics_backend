'use strict';

const { createBaseRepository } = require('../base/base.repository');

/**
 * Return persistence layer (Phase 10, ADR-0018).
 *
 * Encapsulates database operations only — no authorization, business rules,
 * HTTP, or response formatting. Customer scoping is ALWAYS applied by the
 * service (every customer query filters on `customerId`); `conditionalTransition`
 * is the ATOMIC CONFLICT POINT that makes concurrent approve/reject/complete/
 * cancel calls safe (a transition applies only while the document is still in
 * `fromStatus`).
 */
function createReturnRepository(model) {
  const base = createBaseRepository(model);

  return {
    ...base,

    /**
     * Atomic status transition: applies `update` (built by the service as
     * `{ $set, $push }`) ONLY while the return is still in `fromStatus`,
     * returning the updated doc (or `null` when the state no longer matches).
     * This is the conflict point for the return state machine — two concurrent
     * completes cannot double-restock.
     */
    conditionalTransition: (id, fromStatus, update, options = {}) =>
      model.findOneAndUpdate(
        { _id: id, status: fromStatus },
        update,
        { new: true, runValidators: true, ...options }
      ),
  };
}

module.exports = { createReturnRepository };
