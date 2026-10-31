'use strict';

const { validateNotificationListQuery } = require('./notification.validation');
const { NOTIFICATION_MESSAGES } = require('./notification.constants');

/**
 * Thin admin notification controller (read-only audit list + detail). Filters
 * come from validated query params only; the serializer never exposes the
 * internal `payload` snapshot.
 */
function createAdminNotificationController({ notificationService }) {
  if (
    !notificationService ||
    typeof notificationService.listNotifications !== 'function' ||
    typeof notificationService.getNotification !== 'function'
  ) {
    throw new Error('createAdminNotificationController requires a notificationService');
  }

  return {
    // GET /api/v1/admin/notifications — ADMIN.
    listNotifications: async (req, res) => {
      const { filter } = validateNotificationListQuery(req.query);
      const data = await notificationService.listNotifications({
        ...filter,
        page: req.query.page,
        limit: req.query.limit,
      });
      res.status(200).json({
        success: true,
        message: NOTIFICATION_MESSAGES.NOTIFICATIONS_FETCHED,
        data,
      });
    },

    // GET /api/v1/admin/notifications/:id — ADMIN.
    getNotification: async (req, res) => {
      const notification = await notificationService.getNotification(req.params.id);
      res.status(200).json({
        success: true,
        message: NOTIFICATION_MESSAGES.NOTIFICATION_FETCHED,
        data: { notification },
      });
    },
  };
}

module.exports = { createAdminNotificationController };
