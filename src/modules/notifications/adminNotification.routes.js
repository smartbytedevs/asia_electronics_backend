'use strict';

const { Router } = require('express');
const { ROLES } = require('../../constants');
const { createAdminNotificationController } = require('./adminNotification.controller');
const { defaultNotificationService } = require('./notification.routes');
const { defaultUserService } = require('../users/user.routes');
const authenticate = require('../../middlewares/authenticate');
const resolveCurrentUser = require('../../middlewares/resolveCurrentUser');
const authorizeRoles = require('../../middlewares/authorizeRoles');

/**
 * Admin notification router, mounted at /api/v1/admin/notifications.
 *
 * ADMIN-only READ surface (list + detail) over the internal notification audit
 * trail. STAFF/CUSTOMER → 403; anonymous → 401. There are no notification
 * write/management endpoints — delivery is triggered internally by business
 * services, and the Notification document has no read/unread state.
 */
function createAdminNotificationRouter({
  notificationService = defaultNotificationService,
  userService = defaultUserService,
  verifier,
} = {}) {
  const router = Router();
  const controller = createAdminNotificationController({ notificationService });

  const admin = [
    authenticate(verifier),
    resolveCurrentUser({ userService }),
    authorizeRoles(ROLES.ADMIN),
  ];

  router.get('/', admin, controller.listNotifications);
  router.get('/:id', admin, controller.getNotification);

  return router;
}

const defaultAdminRouter = createAdminNotificationRouter();

module.exports = { createAdminNotificationRouter, defaultAdminRouter };
