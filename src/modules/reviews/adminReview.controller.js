'use strict';

const { validateReviewInput, validateReviewListQuery } = require('./review.validation');
const { REVIEW_MESSAGES } = require('./review.constants');

/**
 * Thin admin review controller (moderation). The acting ADMIN id ALWAYS comes
 * from `req.user.id` — never from the request body.
 */
function createAdminReviewController({ reviewService }) {
  if (!reviewService || typeof reviewService.approveReview !== 'function') {
    throw new Error('createAdminReviewController requires a reviewService');
  }

  const performedBy = (req) => req.user.id;

  return {
    // GET /api/v1/admin/reviews — ADMIN.
    listReviews: async (req, res) => {
      const { filter } = validateReviewListQuery(req.query);
      const data = await reviewService.listReviews({
        ...filter,
        page: req.query.page,
        limit: req.query.limit,
      });
      res.status(200).json({
        success: true,
        message: REVIEW_MESSAGES.REVIEWS_FETCHED,
        data,
      });
    },

    // GET /api/v1/admin/reviews/:id — ADMIN.
    getReview: async (req, res) => {
      const review = await reviewService.getReview(req.params.id);
      res.status(200).json({
        success: true,
        message: REVIEW_MESSAGES.REVIEW_FETCHED,
        data: { review },
      });
    },

    // POST /api/v1/admin/reviews/:id/approve — ADMIN.
    approveReview: async (req, res) => {
      const { value } = validateReviewInput(req.body);
      const review = await reviewService.approveReview({
        reviewId: req.params.id,
        performedBy: performedBy(req),
        note: value.note,
      });
      res.status(200).json({
        success: true,
        message: REVIEW_MESSAGES.REVIEW_APPROVED,
        data: { review },
      });
    },

    // POST /api/v1/admin/reviews/:id/reject — ADMIN.
    rejectReview: async (req, res) => {
      const { value } = validateReviewInput(req.body);
      const review = await reviewService.rejectReview({
        reviewId: req.params.id,
        performedBy: performedBy(req),
        note: value.note,
      });
      res.status(200).json({
        success: true,
        message: REVIEW_MESSAGES.REVIEW_REJECTED,
        data: { review },
      });
    },
  };
}

module.exports = { createAdminReviewController };
