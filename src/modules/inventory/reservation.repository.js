'use strict';

const { createBaseRepository } = require('../base/base.repository');

/**
 * Reservation persistence layer (Phase 06, ADR-0014).
 *
 * Encapsulates database operations only — no authorization, business rules,
 * HTTP, or response formatting. Status transitions are explicit service
 * operations (`resolvedAt`/`resolvedBy` set together with the terminal
 * status); there is no generic update endpoint.
 */
function createReservationRepository(model) {
  const base = createBaseRepository(model);

  return {
    ...base,

    findActiveByReference: (referenceType, referenceId, options = {}) =>
      base.findOne(
        { referenceType, referenceId, status: 'ACTIVE' },
        options
      ),

    /**
     * Atomic status transition: moves a reservation from `fromStatus` to
     * `toStatus` ONLY while it is still in `fromStatus`. Returns the updated
     * doc, or `null` when the reservation is no longer in `fromStatus`. This
     * is the CONFLICT POINT that makes concurrent release/consume/expire
     * calls safe and idempotent — only one caller can win the transition.
     */
    transitionStatus: (id, fromStatus, toStatus, fields, options = {}) =>
      model.findOneAndUpdate(
        { _id: id, status: fromStatus },
        { $set: { status: toStatus, ...fields } },
        { new: true, runValidators: true, ...options }
      ),
  };
}

module.exports = { createReservationRepository };
