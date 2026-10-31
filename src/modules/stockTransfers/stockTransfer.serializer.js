'use strict';

/**
 * StockTransfer serialization (Phase 14).
 *
 * Never serializes `_id`, `__v`, or any internal/MongoDB detail.
 */
function serializeStockTransfer(transfer) {
  return {
    id: String(transfer._id || transfer.id),
    sourceOutletId: String(transfer.sourceOutletId || ''),
    destinationOutletId: String(transfer.destinationOutletId || ''),
    productVariantId: String(transfer.productVariantId || ''),
    quantity: transfer.quantity,
    status: transfer.status,
    reason: transfer.reason || null,
    completedAt: transfer.completedAt
      ? new Date(transfer.completedAt).toISOString()
      : null,
    createdBy: String(transfer.createdBy || ''),
    createdAt: transfer.createdAt
      ? new Date(transfer.createdAt).toISOString()
      : null,
    updatedAt: transfer.updatedAt
      ? new Date(transfer.updatedAt).toISOString()
      : null,
  };
}

module.exports = { serializeStockTransfer };
