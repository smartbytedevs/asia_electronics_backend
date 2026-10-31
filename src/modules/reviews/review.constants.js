'use strict';

/**
 * Review constants (Product Reviews + Admin Moderation).
 *
 * A Product Review is a customer's rating/comment about a PRODUCT (not a
 * customer-account review). Customers submit reviews which start PENDING;
 * an ADMIN approves or rejects them. Only APPROVED reviews are ever exposed
 * by public/customer-facing endpoints.
 *
 * There is deliberately NO purchase-verification rule: the project has no
 * established "must have purchased before reviewing" business rule, so one is
 * not invented here.
 */

/**
 * Review status machine. Reachable transitions (see review.state-machine.js):
 *
 *   PENDING → APPROVED  (admin approve; TERMINAL)
 *   PENDING → REJECTED  (admin reject; TERMINAL)
 *
 * No moderation reversal — an APPROVED/REJECTED review stays terminal.
 */
const REVIEW_STATUSES = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
});

const REVIEW_STATUS_VALUES = Object.freeze(Object.values(REVIEW_STATUSES));

const REVIEW_LIMITS = Object.freeze({
  RATING_MIN: 1,
  RATING_MAX: 5,
  COMMENT_MAX: 2000,
  NOTE_MAX: 500,
  DISPLAY_NAME_MAX: 100,
});

/**
 * Whitelist of every client-writable review-creation field. `rating` is
 * required; `comment` is optional. Status/actor/identity fields (`productId`
 * comes from the URL, `customerId` from the authenticated user, `status`,
 * `approvedBy`, ...) are ALWAYS server-derived and rejected.
 */
const REVIEW_INPUT_FIELDS = Object.freeze(['rating', 'comment']);

/**
 * Whitelist of every client-writable admin moderation field (approve/reject
 * bodies accept an optional moderation `note` only).
 */
const REVIEW_REVIEW_INPUT_FIELDS = Object.freeze(['note']);

const REVIEW_MESSAGES = Object.freeze({
  REVIEW_CREATED: 'Review submitted successfully',
  REVIEWS_FETCHED: 'Product reviews retrieved successfully',
  REVIEW_FETCHED: 'Review retrieved successfully',
  REVIEW_APPROVED: 'Review approved successfully',
  REVIEW_REJECTED: 'Review rejected successfully',
  REVIEW_NOT_FOUND: 'Review not found',
  REVIEW_INVALID_STATE: 'Review is in an invalid state for this operation',
  INVALID_STATUS: 'status must be one of: PENDING, APPROVED, REJECTED',
});

module.exports = {
  REVIEW_STATUSES,
  REVIEW_STATUS_VALUES,
  REVIEW_LIMITS,
  REVIEW_INPUT_FIELDS,
  REVIEW_REVIEW_INPUT_FIELDS,
  REVIEW_MESSAGES,
};
