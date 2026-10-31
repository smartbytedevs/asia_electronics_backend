'use strict';

/**
 * Payment serialization (Phase 08, ADR-0016).
 *
 * Never serializes `_id`, `__v`, or any internal/MongoDB detail. The proof is
 * always the safe media object (provider references only) — credentials never
 * appear. The admin representation adds the reviewer identities; the customer
 * representation keeps the record readable but omits reviewer ids.
 */

function serializePayment(payment, { admin = false } = {}) {
  const safe = {
    id: String(payment._id || payment.id),
    orderId: String(payment.orderId || ''),
    customerId: String(payment.customerId || ''),
    paymentMethodId: String(payment.paymentMethodId || ''),
    paymentMethod: {
      code: payment.paymentMethodSnapshot && payment.paymentMethodSnapshot.code,
      displayName: payment.paymentMethodSnapshot && payment.paymentMethodSnapshot.displayName,
      accountNumber:
        (payment.paymentMethodSnapshot && payment.paymentMethodSnapshot.accountNumber) || null,
    },
    transactionReference: payment.transactionReference,
    submittedAmountMinorUnits: payment.submittedAmountMinorUnits,
    expectedAmountMinorUnits: payment.expectedAmountMinorUnits,
    proof: {
      provider: payment.proof && payment.proof.provider,
      publicId: payment.proof && payment.proof.publicId,
      secureUrl: payment.proof && payment.proof.secureUrl,
      resourceType: payment.proof && payment.proof.resourceType,
      format: payment.proof && payment.proof.format,
    },
    status: payment.status,
    statusHistory: (payment.statusHistory || []).map((entry) => ({
      status: entry.status,
      at: entry.at ? new Date(entry.at).toISOString() : null,
      by: String(entry.by || ''),
      note: entry.note || null,
    })),
    notes: payment.notes || null,
    verifiedAt: payment.verifiedAt ? new Date(payment.verifiedAt).toISOString() : null,
    rejectedAt: payment.rejectedAt ? new Date(payment.rejectedAt).toISOString() : null,
    createdAt: payment.createdAt ? new Date(payment.createdAt).toISOString() : null,
    updatedAt: payment.updatedAt ? new Date(payment.updatedAt).toISOString() : null,
  };
  if (admin) {
    safe.verifiedBy = payment.verifiedBy ? String(payment.verifiedBy) : null;
    safe.rejectedBy = payment.rejectedBy ? String(payment.rejectedBy) : null;
  }
  return safe;
}

function serializeCustomerPayment(payment) {
  return serializePayment(payment, { admin: false });
}

function serializeAdminPayment(payment) {
  return serializePayment(payment, { admin: true });
}

module.exports = {
  serializePayment,
  serializeCustomerPayment,
  serializeAdminPayment,
};
