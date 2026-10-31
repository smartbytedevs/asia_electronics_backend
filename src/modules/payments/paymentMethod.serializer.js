'use strict';

/**
 * PaymentMethod serialization (Phase 08, ADR-0016).
 *
 * The customer representation exposes exactly what a customer needs to make a
 * manual transfer (identity + instructions) and omits operational flags; the
 * admin representation adds `isActive`, `sortOrder`, and timestamps. Never
 * serializes `_id`/`__v`. Metadata is intentionally visible to customers —
 * these are public transfer instructions, not credentials.
 */

function serializePaymentMethodForCustomer(method) {
  return {
    id: String(method._id || method.id),
    code: method.code,
    displayName: method.displayName,
    type: method.type,
    metadata: {
      accountName: (method.metadata && method.metadata.accountName) || null,
      accountNumber: (method.metadata && method.metadata.accountNumber) || null,
      bankName: (method.metadata && method.metadata.bankName) || null,
      branch: (method.metadata && method.metadata.branch) || null,
      district: (method.metadata && method.metadata.district) || null,
      accountType: (method.metadata && method.metadata.accountType) || null,
      routingNumber: (method.metadata && method.metadata.routingNumber) || null,
      instructions: (method.metadata && method.metadata.instructions) || null,
    },
  };
}

function serializePaymentMethodForAdmin(method) {
  return {
    id: String(method._id || method.id),
    code: method.code,
    displayName: method.displayName,
    type: method.type,
    metadata: {
      accountName: (method.metadata && method.metadata.accountName) || null,
      accountNumber: (method.metadata && method.metadata.accountNumber) || null,
      bankName: (method.metadata && method.metadata.bankName) || null,
      branch: (method.metadata && method.metadata.branch) || null,
      district: (method.metadata && method.metadata.district) || null,
      accountType: (method.metadata && method.metadata.accountType) || null,
      routingNumber: (method.metadata && method.metadata.routingNumber) || null,
      instructions: (method.metadata && method.metadata.instructions) || null,
    },
    isActive: method.isActive,
    sortOrder: method.sortOrder,
    createdAt: method.createdAt ? new Date(method.createdAt).toISOString() : null,
    updatedAt: method.updatedAt ? new Date(method.updatedAt).toISOString() : null,
  };
}

module.exports = {
  serializePaymentMethodForCustomer,
  serializePaymentMethodForAdmin,
};
