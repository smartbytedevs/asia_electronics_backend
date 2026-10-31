'use strict';

const { Router } = require('express');
const { ROLES } = require('../../constants');
const { createAdminReviewController } = require('./adminReview.controller');
const { defaultReviewService } = require('./review.routes');
const authenticate = require('../../middlewares/authenticate');
const resolveCurrentUser = require('../../middlewares/resolveCurrentUser');
const authorizeRoles = require('../../middlewares/authorizeRoles');
const { defaultUserService } = require('../users/user.routes');

/**
 * Admin review router, mounted at /api/v1/admin/reviews.
 *
 * ADMIN-only (ADMIN is the only role that may moderate reviews). The acting
 * id always comes from the authenticated user — never from the request body.
 * STAFF/CUSTOMER → 403.
 */
function createAdminReviewRouter({
  reviewService = defaultReviewService,
  userService = defaultUserService,
  verifier,
} = {}) {
  const router = Router();
  const controller = createAdminReviewController({ reviewService });

  const admin = [
    authenticate(verifier),
    resolveCurrentUser({ userService }),
    authorizeRoles(ROLES.ADMIN),
  ];

  router.get('/', admin, controller.listReviews);
  router.get('/:id', admin, controller.getReview);
  router.post('/:id/approve', admin, controller.approveReview);
  router.post('/:id/reject', admin, controller.rejectReview);

  return router;
}

const defaultAdminRouter = createAdminReviewRouter();

module.exports = { createAdminReviewRouter, defaultAdminRouter };
