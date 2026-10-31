'use strict';

const orderTemplates = require('./order.templates');
const paymentTemplates = require('./payment.templates');
const courierTemplates = require('./courier.templates');
const returnTemplates = require('./return.templates');
const refundTemplates = require('./refund.templates');
const adminTemplates = require('./admin.templates');
const adminOrderEmailTemplates = require('./admin-order-email.template');

/**
 * Notification template registry (Phase 11, ADR-0019).
 *
 * Maps NOTIFICATION_EVENT_TYPES → `{ key, category, render }`. EMAIL-channel
 * `render` takes `{ customer, data }` and returns `{ subject, html, text }`;
 * ADMIN-channel `render` takes `{ data }` and returns `{ title, message }`
 * (see admin.templates.js). The registry is injected into the
 * NotificationService, so tests can substitute a stub registry.
 */
const notificationTemplates = Object.freeze({
  ...orderTemplates,
  ...paymentTemplates,
  ...courierTemplates,
  ...returnTemplates,
  ...refundTemplates,
  ...adminTemplates,
  ...adminOrderEmailTemplates,
});

const TEMPLATE_KEYS = Object.freeze(Object.keys(notificationTemplates));

module.exports = { notificationTemplates, TEMPLATE_KEYS };
