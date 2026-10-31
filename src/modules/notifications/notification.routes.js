'use strict';

const config = require('../../config');
const Notification = require('./notification.model');
const User = require('../users/user.model');
const { createNotificationRepository } = require('./notification.repository');
const { createUserRepository } = require('../users/user.repository');
const { NotificationService, createMaybeNotify } = require('./notification.service');
const { notificationTemplates } = require('./templates');
const { createEmailProvider } = require('../../integrations/email');

/**
 * Default notification service bound to the central config (Phase 11,
 * ADR-0019).
 *
 * This is the COMPOSITION point: every business module that wants notifications
 * imports `defaultNotificationService` from here (or overrides it in tests with
 * a stub/real service + mock email provider). Only DB operations happen at
 * request time — module load is connection-free. The email provider is selected
 * from `config.email.provider` (mock in development/tests, SMTP in production)
 * and sending is best-effort.
 */
const defaultEmailService = createEmailProvider(config.email);

if (config.email.provider === 'smtp') {
  console.log(
    `[email] provider=smtp host=${config.email.host || '(unset)'}:${config.email.port} ` +
      `transport=${config.email.secure ? 'implicit-tls' : 'starttls'} from=${config.email.from || '(unset)'}`
  );
} else {
  console.log(
    `[email] provider=${config.email.provider || 'mock'} (mock discards every email; no real messages are sent)`
  );
}

const defaultNotificationService = new NotificationService({
  notificationRepository: createNotificationRepository(Notification),
  userRepository: createUserRepository(User),
  templateRegistry: notificationTemplates,
  emailService: defaultEmailService,
  enabled: config.notifications.enabled,
  dedupeWindowMs: config.notifications.dedupeWindowMs,
  // Destination + dashboard deep-link base for the admin NEW ORDER email
  // (ADMIN_ORDER_PLACED_EMAIL). Empty ADMIN_EMAIL simply disables it.
  adminEmail: config.admin.email,
  adminDashboardBaseUrl: config.admin.dashboardBaseUrl,
  // Storefront base URL for the customer "Track Your Order" link in the
  // ORDER_PLACED email. Empty simply leaves the CTA out of the email.
  storefrontBaseUrl: config.storefront.baseUrl,
});

module.exports = {
  defaultNotificationService,
  defaultEmailService,
  NotificationService,
  createMaybeNotify,
};
