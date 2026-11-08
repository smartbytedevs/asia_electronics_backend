'use strict';

const { Router } = require('express');
const { ROLES } = require('../../constants');
const Review = require('./review.model');
const Product = require('../products/product.model');
const { createReviewRepository } = require('./review.repository');
const { createProductRepository } = require('../products/product.repository');
const { ReviewService } = require('./review.service');
const { createReviewController } = require('./review.controller');
const authenticate = require('../../middlewares/authenticate');
const resolveCurrentUser = require('../../middlewares/resolveCurrentUser');
const authorizeRoles = require('../../middlewares/authorizeRoles');
const { defaultUserService } = require('../users/user.routes');
const { defaultNotificationService } = require('../notifications/notification.routes');

/**
 * Default review service bound to the central config. Only DB operations
 * happen at request time — module load is connection-free.
 */
const defaultReviewService = new ReviewService({
  reviewRepository: createReviewRepository(Review),
  productRepository: createProductRepository(Product),
  notificationService: defaultNotificationService,
});

/**
 * Review router, mounted at /api/v1/products (routes are
 * /:productId/reviews...). Two surfaces on the same path:
 *   GET  /:productId/reviews — PUBLIC (APPROVED reviews only, no auth)
 *   POST /:productId/reviews — CUSTOMER (authenticated identity only)
 *
 * The product context comes from the URL (/:productId); the customer identity
 * ALWAYS comes from the authenticated user.
 */
function createReviewRouter({
  reviewService = defaultReviewService,
  userService = defaultUserService,
  verifier,
} = {}) {
  const router = Router();
  const controller = createReviewController({ reviewService });

  // Public batched rating summaries for catalog cards — no auth. Must be
  // declared before the parameterized review route.
  router.get('/ratings/summary', controller.listRatingSummaries);

  // Public read: APPROVED reviews only — no auth.
  router.get('/:productId/reviews', controller.listProductReviews);

  // Customer submission: PENDING by default — identity from req.user.
  router.post(
    '/:productId/reviews',
    authenticate(verifier),
    resolveCurrentUser({ userService }),
    authorizeRoles(ROLES.CUSTOMER),
    controller.createReview
  );

  return router;
}

const defaultRouter = createReviewRouter();

module.exports = { createReviewRouter, defaultRouter, defaultReviewService };
