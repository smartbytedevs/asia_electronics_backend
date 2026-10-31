'use strict';

/**
 * Courier shipment serialization (Phase 09, ADR-0017).
 *
 * Never serializes `_id`, `__v`, or internal/MongoDB details. The customer
 * (tracking) representation is intentionally minimal and NEVER leaks provider
 * error details, attempt counts, or payload snapshots. The admin representation
 * adds full audit detail (attempts, last error, payload, dispatch/cancel info).
 */

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function serializeStatusHistory(history = []) {
  return history.map((entry) => ({
    status: entry.status,
    at: iso(entry.at),
    by: entry.by ? String(entry.by) : null,
    note: entry.note || null,
    providerStatus: entry.providerStatus || null,
  }));
}

function serializeAdminShipment(doc) {
  return {
    id: String(doc._id || doc.id),
    orderId: String(doc.orderId || ''),
    orderNumber: doc.merchantReference,
    provider: doc.provider,
    status: doc.status,
    consignmentId: doc.consignmentId || null,
    amountToCollectMinorUnits: doc.amountToCollectMinorUnits || 0,
    statusHistory: serializeStatusHistory(doc.statusHistory),
    submission: {
      attempts: (doc.submission && doc.submission.attempts) || 0,
      submittedAt: iso(doc.submission && doc.submission.submittedAt),
      lastSubmitAttemptAt: iso(doc.submission && doc.submission.lastSubmitAttemptAt),
      lastError: (doc.submission && doc.submission.lastError) || null,
    },
    providerStatus: {
      status: (doc.providerStatus && doc.providerStatus.status) || null,
      updatedAt: iso(doc.providerStatus && doc.providerStatus.updatedAt),
      fetchedAt: iso(doc.providerStatus && doc.providerStatus.fetchedAt),
    },
    fees: {
      providerDeliveryFeeMinorUnits:
        (doc.fees && doc.fees.providerDeliveryFeeMinorUnits) || 0,
      currency: (doc.fees && doc.fees.currency) || 'BDT',
    },
    cancel: {
      requestedAt: iso(doc.cancel && doc.cancel.requestedAt),
      confirmedAt: iso(doc.cancel && doc.cancel.confirmedAt),
      lastError: (doc.cancel && doc.cancel.lastError) || null,
    },
    dispatch: {
      requestedBy: (doc.dispatch && doc.dispatch.requestedBy)
        ? String(doc.dispatch.requestedBy)
        : null,
      requestedAt: iso(doc.dispatch && doc.dispatch.requestedAt),
      note: (doc.dispatch && doc.dispatch.note) || null,
    },
    createdAt: iso(doc.createdAt),
    updatedAt: iso(doc.updatedAt),
  };
}

function serializeCustomerShipment(doc) {
  return {
    id: String(doc._id || doc.id),
    orderId: String(doc.orderId || ''),
    status: doc.status,
    consignmentId: doc.consignmentId || null,
    providerStatus: {
      status: (doc.providerStatus && doc.providerStatus.status) || null,
      updatedAt: iso(doc.providerStatus && doc.providerStatus.updatedAt),
    },
    deliveryFeeMinorUnits: (doc.fees && doc.fees.providerDeliveryFeeMinorUnits) || 0,
    updatedAt: iso(doc.updatedAt),
  };
}

module.exports = {
  serializeAdminShipment,
  serializeCustomerShipment,
};
