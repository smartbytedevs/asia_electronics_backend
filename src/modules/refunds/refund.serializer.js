'use strict';

/**
 * True when `value` is a bare reference id (ObjectId or string) rather than a
 * populated lean document. Populated refs carry an `_id`; bare ids do not.
 */
function isBareId(value) {
  return Boolean(value) && !value._id;
}

/**
 * Serializes a Date (or date string) as an ISO-8601 string; `null`/invalid
 * inputs become `null` so responses never leak raw Date objects.
 */
function toISO(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Serializes a User ref that may be a plain ObjectId, a populated lean user
 * doc, or null. Populated users expose only safe identity fields.
 */
function serializeUserRef(user) {
  if (!user) return null;
  if (isBareId(user)) {
    return { id: String(user) };
  }
  const value = { id: String(user._id) };
  if (user.name) value.name = user.name;
  if (user.email) value.email = user.email;
  return value;
}

/**
 * Refund response serializer (Phase 10, ADR-0018). Returns a plain envelope
 * for `data.refund`. Refund documents carry minimal refs; the interesting
 * identity fields (return number, order number, customer) are exposed as
 * populated plain-object refs when available, else as bare `{ id }`.
 */
function serializeRefundRef(refund) {
  if (!refund) return null;
  return {
    id: refund._id.toString(),
    refundNumber: refund.refundNumber,
    status: refund.status,
    amount: refund.amount,
  };
}

function serializeReturnRef(refund) {
  if (!refund || !refund.return) return null;
  const ret = refund.return;
  const id = isBareId(ret) ? String(ret) : String(ret._id);
  return {
    id,
    returnNumber: ret.returnNumber || null,
    status: ret.status || null,
  };
}

function serializeOrderRef(refund) {
  if (!refund || !refund.order) return null;
  const order = refund.order;
  const id = isBareId(order) ? String(order) : String(order._id);
  return {
    id,
    orderNumber: order.orderNumber || null,
  };
}

function toRefundOutput(refund, { includeCustomer = true } = {}) {
  if (!refund) return null;
  return {
    id: refund._id.toString(),
    refundNumber: refund.refundNumber,
    return: serializeReturnRef(refund),
    order: serializeOrderRef(refund),
    paymentMethod: refund.paymentMethod,
    paymentId: refund.paymentId ? refund.paymentId.toString() : null,
    amount: refund.amount,
    status: refund.status,
    note: refund.note || '',
    processedBy: refund.processedBy ? serializeUserRef(refund.processedBy) : null,
    processedAt: toISO(refund.processedAt),
    voidedBy: refund.voidedBy ? serializeUserRef(refund.voidedBy) : null,
    voidedAt: toISO(refund.voidedAt),
    customer: includeCustomer ? serializeUserRef(refund.customer) : undefined,
    statusHistory: (refund.statusHistory || []).map((entry) => ({
      status: entry.status,
      at: toISO(entry.at),
      by: entry.by ? serializeUserRef(entry.by) : null,
      note: entry.note || '',
    })),
    createdAt: toISO(refund.createdAt),
    updatedAt: toISO(refund.updatedAt),
  };
}

module.exports = { toRefundOutput, serializeRefundRef, serializeReturnRef, serializeOrderRef };
