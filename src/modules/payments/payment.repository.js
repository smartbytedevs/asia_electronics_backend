'use strict';

const { createBaseRepository } = require('../base/base.repository');

/**
 * Payment persistence layer (Phase 08, ADR-0016).
 *
 * Encapsulates database operations only — no authorization, business rules,
 * HTTP, or response formatting. Customer scoping is ALWAYS applied by the
 * service (every customer query filters on `customerId`); `conditionalTransition`
 * is the ATOMIC CONFLICT POINT that makes concurrent submit/verify/reject calls
 * safe (a transition applies only while the document is still in `fromStatus`).
 */
function createPaymentRepository(model) {
  const base = createBaseRepository(model);

  return {
    ...base,

    /**
     * Atomic status transition: applies `update` (built by the service as
     * `{ $set, $push, $unset }`) ONLY while the payment is still in
     * `fromStatus`, returning the updated doc (or `null` when the state no
     * longer matches). This is the conflict point for the payment state
     * machine — two concurrent verifies cannot double-apply.
     */
    conditionalTransition: (id, fromStatus, update, options = {}) =>
      model.findOneAndUpdate(
        { _id: id, status: fromStatus },
        update,
        { new: true, runValidators: true, ...options }
      ),
  };
}

module.exports = { createPaymentRepository };
