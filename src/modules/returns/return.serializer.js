'use strict';

/**
 * Return serialization (Phase 10, ADR-0018).
 *
 * Never serializes `_id`, `__v`, or any internal/MongoDB detail. The item
 * snapshots are immutable embedded subdocuments — always serialized as-is.
 * The admin representation adds the customer id and the reviewer identities;
 * the customer representation keeps the record readable but omits them.
 */

function serializeReturnItem(item) {
  return {
    id: String(item._id || item.id),
    orderItemId: String(item.orderItemId || ''),
    productId: String(item.productId || ''),
    productVariantId: item.productVariantId
      ? String(item.productVariantId)
      : null,
    productName: item.productName,
    sku: item.sku ?? null,
    quantity: item.quantity,
    unitPriceMinorUnits: item.unitPriceMinorUnits,
    discountMinorUnits: item.discountMinorUnits,
  };
}

function serializeReturn(returnDoc, { admin = false } = {}) {
  const safe = {
    id: String(returnDoc._id || returnDoc.id),
    returnNumber: returnDoc.returnNumber,
    orderId: String(returnDoc.orderId || ''),
    status: returnDoc.status,
    statusHistory: (returnDoc.statusHistory || []).map((entry) => ({
      status: entry.status,
      at: entry.at ? new Date(entry.at).toISOString() : null,
      by: String(entry.by || ''),
      note: entry.note || null,
    })),
    items: (returnDoc.items || []).map((item) => serializeReturnItem(item)),
    reason: returnDoc.reason,
    notes: returnDoc.notes || null,
    refundId: returnDoc.refundId ? String(returnDoc.refundId) : null,
    approvedAt: returnDoc.approvedAt ? new Date(returnDoc.approvedAt).toISOString() : null,
    rejectedAt: returnDoc.rejectedAt ? new Date(returnDoc.rejectedAt).toISOString() : null,
    cancelledAt: returnDoc.cancelledAt ? new Date(returnDoc.cancelledAt).toISOString() : null,
    completedAt: returnDoc.completedAt ? new Date(returnDoc.completedAt).toISOString() : null,
    createdAt: returnDoc.createdAt ? new Date(returnDoc.createdAt).toISOString() : null,
    updatedAt: returnDoc.updatedAt ? new Date(returnDoc.updatedAt).toISOString() : null,
  };
  if (admin) {
    safe.customerId = String(returnDoc.customerId || '');
    safe.approvedBy = returnDoc.approvedBy ? String(returnDoc.approvedBy) : null;
    safe.rejectedBy = returnDoc.rejectedBy ? String(returnDoc.rejectedBy) : null;
    safe.cancelledBy = returnDoc.cancelledBy ? String(returnDoc.cancelledBy) : null;
    safe.completedBy = returnDoc.completedBy ? String(returnDoc.completedBy) : null;
  }
  return safe;
}

function serializeCustomerReturn(returnDoc) {
  return serializeReturn(returnDoc, { admin: false });
}

function serializeAdminReturn(returnDoc) {
  return serializeReturn(returnDoc, { admin: true });
}

module.exports = {
  serializeReturn,
  serializeCustomerReturn,
  serializeAdminReturn,
};
