'use strict';

/**
 * Review serialization.
 *
 * Never serializes `_id`, `__v`, `customerId` (except in the ADMIN view), or
 * any internal/MongoDB detail. Three views:
 * - public: only what the storefront may show (APPROVED reviews only by the
 *   service filter); the author is exposed as `customerDisplayName` only.
 * - customer: the submitting customer's view — public fields plus their
 *   review's moderation `status`.
 * - admin: adds the `customerId` and reviewer identities for moderation.
 */

function serializePublicReview(reviewDoc) {
  return {
    id: String(reviewDoc._id || reviewDoc.id),
    productId: String(reviewDoc.productId || ''),
    customerDisplayName: reviewDoc.customerDisplayName || null,
    rating: reviewDoc.rating,
    comment: reviewDoc.comment || null,
    createdAt: reviewDoc.createdAt ? new Date(reviewDoc.createdAt).toISOString() : null,
  };
}

function serializeCustomerReview(reviewDoc) {
  return {
    ...serializePublicReview(reviewDoc),
    status: reviewDoc.status,
    updatedAt: reviewDoc.updatedAt ? new Date(reviewDoc.updatedAt).toISOString() : null,
  };
}

function serializeAdminReview(reviewDoc) {
  return {
    ...serializePublicReview(reviewDoc),
    customerId: String(reviewDoc.customerId || ''),
    status: reviewDoc.status,
    statusHistory: (reviewDoc.statusHistory || []).map((entry) => ({
      status: entry.status,
      at: entry.at ? new Date(entry.at).toISOString() : null,
      by: String(entry.by || ''),
      note: entry.note || null,
    })),
    approvedBy: reviewDoc.approvedBy ? String(reviewDoc.approvedBy) : null,
    approvedAt: reviewDoc.approvedAt ? new Date(reviewDoc.approvedAt).toISOString() : null,
    rejectedBy: reviewDoc.rejectedBy ? String(reviewDoc.rejectedBy) : null,
    rejectedAt: reviewDoc.rejectedAt ? new Date(reviewDoc.rejectedAt).toISOString() : null,
    updatedAt: reviewDoc.updatedAt ? new Date(reviewDoc.updatedAt).toISOString() : null,
  };
}

module.exports = {
  serializePublicReview,
  serializeCustomerReview,
  serializeAdminReview,
};
