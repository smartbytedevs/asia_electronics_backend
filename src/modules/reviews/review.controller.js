'use strict';

const { validateCreateInput } = require('./review.validation');
const { REVIEW_MESSAGES } = require('./review.constants');

/**
 * Thin review controller: validate input, delegate to the service, serialize
 * the envelope.
 *
 * The customer id ALWAYS comes from `req.user.id` — never from the request
 * body. `customerDisplayName` is also read from the authenticated user only.
 */
function createReviewController({ reviewService }) {
  if (!reviewService || typeof reviewService.createReview !== 'function') {
    throw new Error('createReviewController requires a reviewService');
  }

  return {
    // GET /api/v1/products/:productId/reviews — public (APPROVED only).
    listProductReviews: async (req, res) => {
      const data = await reviewService.listProductReviews({
        productId: req.params.productId,
        page: req.query.page,
        limit: req.query.limit,
      });
      res.status(200).json({
        success: true,
        message: REVIEW_MESSAGES.REVIEWS_FETCHED,
        data,
      });
    },

    // POST /api/v1/products/:productId/reviews — CUSTOMER (own identity).
    createReview: async (req, res) => {
      const { value } = validateCreateInput(req.body);
      const review = await reviewService.createReview({
        customerId: req.user.id,
        productId: req.params.productId,
        customerDisplayName: req.user ? req.user.displayName : null,
        value,
      });
      res.status(201).json({
        success: true,
        message: REVIEW_MESSAGES.REVIEW_CREATED,
        data: { review },
      });
    },
  };
}

module.exports = { createReviewController };
