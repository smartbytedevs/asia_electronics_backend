'use strict';

const { createBaseRepository } = require('../base/base.repository');

/**
 * PaymentMethod persistence layer (Phase 08, ADR-0016).
 *
 * Encapsulates database operations only. Deactivation is ALWAYS a soft
 * `isActive: false` update — the repository exposes no hard delete for payment
 * methods (none of the callers may remove history-referenced methods).
 */
function createPaymentMethodRepository(model) {
  const base = createBaseRepository(model);

  return {
    ...base,
    findByCode: (code, options = {}) => base.findOne({ code }, options),
  };
}

module.exports = { createPaymentMethodRepository };
