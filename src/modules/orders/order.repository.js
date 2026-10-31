'use strict';

const { createBaseRepository } = require('../base/base.repository');

/**
 * Order persistence layer (Phase 07, ADR-0015).
 *
 * Encapsulates database operations only — no authorization, business rules,
 * HTTP, or response formatting. Customer scoping is ALWAYS applied by the
 * service (every customer query filters on `customerId`); the status
 * transitions below are the ATOMIC CONFLICT POINT that makes concurrent
 * confirm/process/reject/cancel calls safe.
 */
function createOrderRepository(model) {
  const base = createBaseRepository(model);

  return {
    ...base,

    findByIdempotencyKey: (customerId, idempotencyKey, options = {}) =>
      base.findOne({ customerId, idempotencyKey }, options),

    findByOrderNumber: (orderNumber, options = {}) =>
      base.findOne({ orderNumber }, options),

    /**
     * Atomic status transition: moves an order from `fromStatus` to `toStatus`
     * ONLY while it is still in `fromStatus`, appends the history entry, and
     * returns the updated doc (or `null` when the order is no longer in
     * `fromStatus`). This is the conflict point for the order state machine —
     * two concurrent confirms cannot double-apply.
     */
    transitionStatus: (id, fromStatus, toStatus, historyEntry, options = {}) =>
      model.findOneAndUpdate(
        { _id: id, status: fromStatus },
        { $set: { status: toStatus }, $push: { statusHistory: historyEntry } },
        { new: true, runValidators: true, ...options }
      ),
  };
}

module.exports = { createOrderRepository };
