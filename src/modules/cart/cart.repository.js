'use strict';

const { createBaseRepository } = require('../base/base.repository');

/**
 * Cart persistence layer (Phase 07, ADR-0015).
 *
 * Encapsulates database operations only — no authorization, business rules,
 * HTTP, or response formatting. The customer scope is ALWAYS applied by the
 * service (every query filters on `customerId`), never by the controller or
 * from the request body.
 */
function createCartRepository(model) {
  const base = createBaseRepository(model);

  return {
    ...base,

    findByCustomer: (customerId, options = {}) =>
      base.findOne({ customerId }, options),

    /**
     * Marks the cart checked-out and clears its items in ONE atomic update
     * (used inside the checkout transaction). Returns the updated doc or
     * `null` when the cart vanished concurrently.
     */
    markCheckedOutAndClear: (customerId, options = {}) =>
      model.findOneAndUpdate(
        { customerId },
        { $set: { items: [], isCheckedOut: true } },
        { new: true, runValidators: true, ...options }
      ),

    clearItems: (customerId, options = {}) =>
      model.findOneAndUpdate(
        { customerId },
        { $set: { items: [] } },
        { new: true, runValidators: true, ...options }
      ),

    /**
     * Replaces the whole items array atomically. Used by add/update/remove
     * item flows so concurrent requests cannot lose updates (the service
     * computes the new array and writes it in one operation).
     */
    setItems: (customerId, items, options = {}) =>
      model.findOneAndUpdate(
        { customerId },
        { $set: { items, isCheckedOut: false } },
        { new: true, runValidators: true, ...options }
      ),
  };
}

module.exports = { createCartRepository };
