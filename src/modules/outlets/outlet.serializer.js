'use strict';

/**
 * Outlet serialization (Phase 14).
 *
 * Never serializes `_id`, `__v`, or any internal/MongoDB detail.
 */
function serializeOutlet(outlet) {
  return {
    id: String(outlet._id || outlet.id),
    name: outlet.name,
    code: outlet.code,
    address: outlet.address ?? null,
    phone: outlet.phone ?? null,
    isActive: outlet.isActive,
    createdAt: outlet.createdAt
      ? new Date(outlet.createdAt).toISOString()
      : null,
    updatedAt: outlet.updatedAt
      ? new Date(outlet.updatedAt).toISOString()
      : null,
  };
}

module.exports = { serializeOutlet };
