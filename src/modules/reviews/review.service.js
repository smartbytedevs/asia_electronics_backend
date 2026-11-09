'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const { normalizePagination } = require('../../utils/pagination');
const { assertObjectId } = require('./review.validation');
const {
  serializePublicReview,
  serializeCustomerReview,
  serializeAdminReview,
} = require('./review.serializer');
const {
  REVIEW_STATUSES,
  REVIEW_LIMITS,
  REVIEW_MESSAGES,
} = require('./review.constants');
const { PRODUCT_MESSAGES } = require('../products/product.constants');
const { NOTIFICATION_EVENT_TYPES } = require('../notifications/notification.constants');
const { createMaybeNotifyAdmin } = require('../notifications/notification.service');

/**
 * Review business logic (Product Reviews + Admin Moderation).
 *
 * Safety:
 * - The authenticated customer identity is passed in by the controller
 *   (`req.user.id`) and is NEVER read from the request body.
 * - New reviews are ALWAYS created PENDING — a client can never supply or
 *   force a status (the create-body allowlist rejects `status`).
 * - Public/customer-facing reads ALWAYS filter `status: APPROVED` — PENDING
 *   and REJECTED reviews are never exposed by the public surface.
 * - Moderation (approve/reject) is PENDING → APPROVED / PENDING → REJECTED
 *   only; both outcomes are terminal (no moderation reversal). Every status
 *   change is an ATOMIC CONDITIONAL transition (`conditionalTransition`), so
 *   concurrent approvals cannot double-apply.
 * - Rating aggregation is computed on read (per-rating aggregate) and is never
 *   denormalized onto the Product document.
 *
 * No purchase-verification rule is enforced — the project has no established
 * "must purchase before reviewing" rule, so none is invented.
 */
class ReviewService {
  constructor({ reviewRepository, productRepository, notificationService = null }) {
    if (!reviewRepository || typeof reviewRepository.conditionalTransition !== 'function') {
      throw new Error('ReviewService requires a reviewRepository');
    }
    if (!productRepository || typeof productRepository.findById !== 'function') {
      throw new Error('ReviewService requires a productRepository');
    }
    this.reviewRepository = reviewRepository;
    this.productRepository = productRepository;
    this.maybeNotifyAdmin = createMaybeNotifyAdmin(notificationService);
  }

  notFound() {
    return new ApiError(404, REVIEW_MESSAGES.REVIEW_NOT_FOUND, ERROR_CODES.REVIEW_NOT_FOUND);
  }

  productNotFound() {
    return new ApiError(
      404,
      PRODUCT_MESSAGES.PRODUCT_NOT_FOUND,
      ERROR_CODES.PRODUCT_NOT_FOUND
    );
  }

  invalidState() {
    return new ApiError(409, REVIEW_MESSAGES.REVIEW_INVALID_STATE, ERROR_CODES.REVIEW_INVALID_STATE);
  }

  /**
   * Public review endpoints require the referenced product to exist and be
   * ACTIVE (mirrors the storefront catalog: deactivated products are
   * invisible, so their reviews are too).
   */
  async assertActiveProduct(productId) {
    const product = await this.productRepository.findById(productId, { lean: true });
    if (!product || product.isActive !== true) {
      throw this.productNotFound();
    }
    return product;
  }

  /**
   * CREATE (customer, authenticated identity). The review is always persisted
   * as PENDING. `customerDisplayName` is an optional snapshot for the public
   * view — it comes from the authenticated user, never from the body.
   */
  async createReview({ customerId, productId, customerDisplayName, value }) {
    assertObjectId(customerId, 'customerId');
    assertObjectId(productId, 'productId');
    const product = await this.assertActiveProduct(productId);

    const created = await this.reviewRepository.create({
      productId,
      customerId,
      customerDisplayName:
        typeof customerDisplayName === 'string' && customerDisplayName.trim().length > 0
          ? customerDisplayName.trim().slice(0, REVIEW_LIMITS.DISPLAY_NAME_MAX)
          : null,
      rating: value.rating,
      comment: value.comment,
      status: REVIEW_STATUSES.PENDING,
      statusHistory: [
        { status: REVIEW_STATUSES.PENDING, at: new Date(), by: customerId, note: null },
      ],
    });
    await this.maybeNotifyAdmin({
      userId: customerId,
      eventType: NOTIFICATION_EVENT_TYPES.ADMIN_REVIEW_SUBMITTED,
      data: {
        entityRef: String(created._id),
        customerName: created.customerDisplayName || null,
        productName: product.name || null,
        rating: created.rating,
        comment: created.comment || null,
      },
    });
    return serializeCustomerReview(created);
  }

  buildRatingSummary(ratingCounts) {
    const ratingBreakdown = {};
    let total = 0;
    let sum = 0;
    for (const { rating, count } of ratingCounts || []) {
      ratingBreakdown[rating] = count;
      total += count;
      sum += rating * count;
    }
    const averageRating = total > 0 ? Math.round((sum / total) * 10) / 10 : null;
    return { averageRating, totalReviews: total, ratingBreakdown };
  }

  /**
   * PUBLIC list: a product's APPROVED reviews (newest first) with a rating
   * summary computed across ALL approved reviews. PENDING/REJECTED are never
   * returned.
   */
  async listProductReviews({ productId, page, limit }) {
    assertObjectId(productId, 'productId');
    await this.assertActiveProduct(productId);

    const { page: safePage, limit: safeLimit, skip } = normalizePagination({ page, limit });
    const filter = { productId, status: REVIEW_STATUSES.APPROVED };
    // The rating aggregate already counts EVERY approved review for this
    // product, so its `totalReviews` is the pagination total — the extra
    // countDocuments query was redundant.
    const [docs, ratingCounts] = await Promise.all([
      this.reviewRepository.findMany(filter, {
        sort: { createdAt: -1 },
        skip,
        limit: safeLimit,
        lean: true,
      }),
      this.reviewRepository.aggregateApprovedRatings(productId),
    ]);
    const summary = this.buildRatingSummary(ratingCounts);
    const total = summary.totalReviews;
    return {
      reviews: docs.map((doc) => serializePublicReview(doc)),
      summary,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit),
      },
    };
  }

  /**
   * Batched rating summaries for the catalog list: ONE aggregate for every
   * product on the page instead of one reviews request per card. Only APPROVED
   * reviews are counted (same rule as the single-product public endpoint).
   *
   * `productIds` is either an array or a comma-separated string. The batch is
   * capped and every id is validated before it reaches the repository.
   */
  normalizeRatingProductIds(productIds) {
    const raw = typeof productIds === 'string' ? productIds.split(',') : productIds;
    if (raw === undefined || raw === null) {
      return [];
    }
    if (!Array.isArray(raw)) {
      throw new ApiError(
        400,
        'productIds must be a comma-separated list of product ids',
        ERROR_CODES.INVALID_REVIEW
      );
    }
    const ids = [
      ...new Set(
        raw
          .map((id) => (typeof id === 'string' ? id.trim() : ''))
          .filter(Boolean)
      ),
    ];
    if (ids.length > 100) {
      throw new ApiError(
        400,
        'at most 100 product ids may be requested at once',
        ERROR_CODES.INVALID_REVIEW
      );
    }
    for (const id of ids) {
      assertObjectId(id, 'productId');
    }
    return ids;
  }

  async listProductRatingSummaries({ productIds } = {}) {
    const ids = this.normalizeRatingProductIds(productIds);
    if (ids.length === 0) {
      return { ratings: {} };
    }

    const rows = await this.reviewRepository.aggregateApprovedRatingsForProducts(ids);
    const countsByProduct = new Map(ids.map((id) => [id, []]));
    for (const row of rows) {
      const counts = countsByProduct.get(row.productId);
      if (counts) {
        counts.push({ rating: row.rating, count: row.count });
      }
    }

    const ratings = {};
    for (const id of ids) {
      ratings[id] = this.buildRatingSummary(countsByProduct.get(id));
    }
    return { ratings };
  }

  async performTransition({ reviewId, fromStatus, toStatus, performedBy, note }) {
    assertObjectId(reviewId, 'reviewId');
    assertObjectId(performedBy, 'performedBy');
    const now = new Date();
    const actorFields = {
      [REVIEW_STATUSES.APPROVED]: ['approvedBy', 'approvedAt'],
      [REVIEW_STATUSES.REJECTED]: ['rejectedBy', 'rejectedAt'],
    };
    const set = { status: toStatus };
    for (const [index, field] of (actorFields[toStatus] || []).entries()) {
      set[field] = index === 0 ? performedBy : now;
    }
    const updated = await this.reviewRepository.conditionalTransition(reviewId, fromStatus, {
      $set: set,
      $push: {
        statusHistory: { status: toStatus, at: now, by: performedBy, note: note || null },
      },
    });
    if (!updated) {
      throw this.invalidState();
    }
    return updated;
  }

  // ---------------------------------------------------------------------
  // Admin surface (ADMIN-only moderation)
  // ---------------------------------------------------------------------

  async listReviews({ status, productId, page, limit }) {
    const filter = {};
    if (status !== undefined && status !== null && status !== '') {
      filter.status = status;
    }
    if (productId !== undefined && productId !== null && productId !== '') {
      assertObjectId(productId, 'productId');
      filter.productId = productId;
    }
    const { page: safePage, limit: safeLimit, skip } = normalizePagination({ page, limit });
    const [docs, total] = await Promise.all([
      this.reviewRepository.findMany(filter, {
        sort: { createdAt: -1 },
        skip,
        limit: safeLimit,
        lean: true,
      }),
      this.reviewRepository.count(filter),
    ]);
    return {
      reviews: docs.map((doc) => serializeAdminReview(doc)),
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit),
      },
    };
  }

  async getReview(reviewId) {
    assertObjectId(reviewId, 'reviewId');
    const doc = await this.reviewRepository.findById(reviewId);
    if (!doc) {
      throw this.notFound();
    }
    return serializeAdminReview(doc);
  }

  /**
   * APPROVE (admin). PENDING → APPROVED (terminal). Idempotent when already
   * APPROVED; REJECTED reviews cannot be approved (no moderation reversal).
   */
  async approveReview({ reviewId, performedBy, note }) {
    assertObjectId(reviewId, 'reviewId');
    assertObjectId(performedBy, 'performedBy');
    const existing = await this.reviewRepository.findById(reviewId);
    if (!existing) {
      throw this.notFound();
    }
    if (existing.status === REVIEW_STATUSES.APPROVED) {
      return serializeAdminReview(existing);
    }
    if (existing.status !== REVIEW_STATUSES.PENDING) {
      throw this.invalidState();
    }
    const updated = await this.performTransition({
      reviewId,
      fromStatus: REVIEW_STATUSES.PENDING,
      toStatus: REVIEW_STATUSES.APPROVED,
      performedBy,
      note,
    });
    return serializeAdminReview(updated);
  }

  /**
   * REJECT (admin). PENDING → REJECTED (terminal). Idempotent when already
   * REJECTED; APPROVED reviews cannot be rejected.
   */
  async rejectReview({ reviewId, performedBy, note }) {
    assertObjectId(reviewId, 'reviewId');
    assertObjectId(performedBy, 'performedBy');
    const existing = await this.reviewRepository.findById(reviewId);
    if (!existing) {
      throw this.notFound();
    }
    if (existing.status === REVIEW_STATUSES.REJECTED) {
      return serializeAdminReview(existing);
    }
    if (existing.status !== REVIEW_STATUSES.PENDING) {
      throw this.invalidState();
    }
    const updated = await this.performTransition({
      reviewId,
      fromStatus: REVIEW_STATUSES.PENDING,
      toStatus: REVIEW_STATUSES.REJECTED,
      performedBy,
      note,
    });
    return serializeAdminReview(updated);
  }
}

module.exports = { ReviewService };
