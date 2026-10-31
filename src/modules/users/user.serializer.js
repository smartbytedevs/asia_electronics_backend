'use strict';

/**
 * User serializers.
 *
 * The admin view deliberately omits `authProviderId` (the immutable link to
 * the Better Auth identity) and any internal fields, so future schema
 * additions cannot leak to admin clients. It adds `createdAt`/`updatedAt` so
 * the admin customer list/detail can show account timestamps.
 */
function serializeAdminUser(doc) {
  return {
    id: String(doc._id || doc.id),
    email: doc.email || null,
    displayName: doc.displayName || null,
    phone: doc.phone || null,
    role: doc.role,
    status: doc.status,
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
  };
}

module.exports = { serializeAdminUser };
