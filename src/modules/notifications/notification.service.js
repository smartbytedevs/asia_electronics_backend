'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const { normalizePagination } = require('../../utils/pagination');
const { assertObjectId } = require('./notification.validation');
const { toNotificationOutput } = require('./notification.serializer');
const { NOTIFICATION_CHANNELS, NOTIFICATION_STATUSES, NOTIFICATION_MESSAGES } = require('./notification.constants');
const { maskRecipient, recipientDomain } = require('../../integrations/email/email.safe-log');
const {
  NOTIFICATION_ERROR_CODES,
  NotificationError,
} = require('./notification.errors');

const DEFAULT_DEDUPE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const ERROR_MESSAGE_MAX = 500;

/**
 * Best-effort notification dispatcher factory (Phase 11, ADR-0019).
 *
 * Business services inject an optional notificationService and call
 * `maybeNotify({ userId, eventType, data })` AFTER their own transaction has
 * committed. This wrapper is the canonical "side effect that must never fail
 * the primary operation" pattern (the same shape as
 * AdminOrderService.maybeAutoDispatch): a missing notificationService is a
 * no-op, and provider/render errors are logged and swallowed.
 */
function createMaybeNotify(notificationService) {
  if (!notificationService || typeof notificationService.notify !== 'function') {
    return async function maybeNotify() {
      return null;
    };
  }
  return async function maybeNotify({ userId, eventType, data }) {
    try {
      return await notificationService.notify({ userId, eventType, data });
    } catch (err) {
      console.error('[notifications] failed to notify', {
        eventType,
        userId,
        error: err && err.message ? err.message : String(err),
      });
      return null;
    }
  };
}

/**
 * Best-effort ADMIN notification dispatcher factory. Mirrors `createMaybeNotify`
 * but targets `notifyAdmin` (ADMIN channel — admin dashboard events). A missing
 * notificationService is a no-op and provider/render errors are swallowed.
 */
function createMaybeNotifyAdmin(notificationService) {
  if (!notificationService || typeof notificationService.notifyAdmin !== 'function') {
    return async function maybeNotifyAdmin() {
      return null;
    };
  }
  return async function maybeNotifyAdmin({ userId, eventType, data }) {
    try {
      return await notificationService.notifyAdmin({ userId, eventType, data });
    } catch (err) {
      console.error('[notifications] failed to notify admin', {
        eventType,
        userId,
        error: err && err.message ? err.message : String(err),
      });
      return null;
    }
  };
}

/**
 * Best-effort ADMIN EMAIL dispatcher factory (Phase 11, ADR-0019). Mirrors
 * `createMaybeNotify` but targets `notifyAdminEmail` (EMAIL channel sent to the
 * configured admin address — e.g. the "new order received" email). A missing
 * notificationService is a no-op and provider/render errors are swallowed, so
 * the admin email can never affect the business operation that triggered it.
 */
function createMaybeNotifyAdminEmail(notificationService) {
  if (!notificationService || typeof notificationService.notifyAdminEmail !== 'function') {
    return async function maybeNotifyAdminEmail() {
      return null;
    };
  }
  return async function maybeNotifyAdminEmail({ userId, to, eventType, data, persist }) {
    try {
      return await notificationService.notifyAdminEmail({ userId, to, eventType, data, persist });
    } catch (err) {
      console.error('[notifications] failed to notify admin by email', {
        eventType,
        userId,
        error: err && err.message ? err.message : String(err),
      });
      return null;
    }
  };
}

/**
 * Builds the admin order deep-link for the "new order received" email.
 *
 * `adminDashboardBaseUrl` (ADMIN_DASHBOARD_BASE_URL) points at the dashboard
 * page (e.g. https://www.taqwactg.com/admin/dashboard). The deep link targets
 * the real admin order route, so the path is derived from the SITE ORIGIN of
 * the dashboard URL — never appended after the dashboard path (that would
 * produce ".../admin/dashboard/admin/orders/<id>").
 */
function buildAdminOrderUrl(dashboardBaseUrl, entityRef) {
  const origin = new URL(dashboardBaseUrl).origin;
  return `${origin}/admin/orders/${String(entityRef)}`;
}

/**
 * Notification business logic (Phase 11, ADR-0019).
 *
 * Creates a Notification audit record and attempts best-effort delivery. Two
 * channels share this service:
 *
 *   - `notify`     (EMAIL) — customer-facing transactional email. The record
 *     starts QUEUED (the retry safety net) and is moved to SENT / FAILED /
 *     SKIPPED by the email provider outcome.
 *   - `notifyAdmin` (ADMIN) — admin dashboard event. There is no email; the
 *     record is persisted directly as SENT ("available in the admin
 *     notification list") with a rendered `title`/`message`.
 *   - `notifyAdminEmail` (EMAIL) — admin-facing transactional email (e.g. the
 *     "new order received" email). Same EMAIL delivery pipeline as `notify`,
 *     but the destination is the configured ADMIN_EMAIL (or an explicit `to`)
 *     and the recipient of the audit record is the user whose action triggered
 *     it (so per-order dedupe matches the other admin channels). Callers pass
 *     `persist: false` for email-only events (ADMIN_ORDER_PLACED_EMAIL) so the
 *     message is delivered WITHOUT creating an in-app Notification record.
 *
 * The business operation that triggered a notification is NEVER affected:
 *
 *   - disabled / unknown channel / unknown recipient (no user) → nothing
 *     persisted.
 *   - user without an email: falls back to the checkout-provided
 *     `data.customerEmail` (guest checkout); if neither exists → nothing
 *     persisted (no deliverable address).
 *   - unknown event type / template render bug → NotificationError (callers
 *     swallow via maybeNotify and log).
 *   - provider failure → the Notification is marked FAILED with the provider
 *     error recorded; retryable via a future retry worker.
 *   - no email service configured → the Notification is marked SKIPPED.
 *
 * Within-window deduplication: identical { recipient, eventType, entityRef }
 * notifications created inside `dedupeWindowMs` are skipped — defense-in-depth
 * on top of the business services' own idempotency short-circuits.
 */
class NotificationService {
  constructor({
    notificationRepository,
    userRepository,
    templateRegistry = {},
    emailService = null,
    enabled = true,
    dedupeWindowMs = DEFAULT_DEDUPE_WINDOW_MS,
    now = Date.now,
    adminEmail = null,
    adminDashboardBaseUrl = null,
    storefrontBaseUrl = null,
  }) {
    if (!notificationRepository || typeof notificationRepository.create !== 'function') {
      throw new Error('NotificationService requires a notificationRepository');
    }
    if (!userRepository || typeof userRepository.findById !== 'function') {
      throw new Error('NotificationService requires a userRepository');
    }
    this.notificationRepository = notificationRepository;
    this.userRepository = userRepository;
    this.templateRegistry = templateRegistry;
    this.emailService = emailService;
    this.enabled = Boolean(enabled);
    this.dedupeWindowMs = Number(dedupeWindowMs) || 0;
    this.now = now;
    // Destination of the admin NEW ORDER email (ADMIN_ORDER_PLACED_EMAIL).
    // Empty disables the admin email (the order flow never fails because of
    // it). `adminDashboardBaseUrl` builds the "View Order in Admin Dashboard"
    // deep link from the order's entityRef.
    this.adminEmail = adminEmail || null;
    this.adminDashboardBaseUrl = adminDashboardBaseUrl
      ? String(adminDashboardBaseUrl).replace(/\/+$/, '')
      : null;
    // Base URL of the public customer storefront, used to build the "Track Your
    // Order" link (`<base>/track/<orderNumber>`) that the customer ORDER_PLACED
    // template renders. The order number is customer-safe (never a Mongo id).
    this.storefrontBaseUrl = storefrontBaseUrl
      ? String(storefrontBaseUrl).replace(/\/+$/, '')
      : null;
  }

  isEnabled() {
    return this.enabled;
  }

  /**
   * Builds and dispatches one notification. Returns the Notification document
   * when one was created, or `null` when there was nothing to do (disabled,
   * unknown channel, no recipient, or deduplicated).
   */
  async notify({ userId, eventType, data = {}, channel = NOTIFICATION_CHANNELS.EMAIL }) {
    if (!this.enabled || channel !== NOTIFICATION_CHANNELS.EMAIL) {
      return null;
    }

    const template = this.templateRegistry[eventType];
    if (!template) {
      throw new NotificationError(
        NOTIFICATION_ERROR_CODES.UNKNOWN_EVENT_TYPE,
        `Unknown notification event type: ${eventType}`
      );
    }

    const user = await this.userRepository.findById(userId);
    if (!user) {
      return null; // no known recipient identity — nothing to record
    }
    // Recipient resolution: the account email wins (signed-in customers keep
    // their existing email). A user without an account email may still provide
    // a checkout-time email (`data.customerEmail`, e.g. guest checkout) which
    // is used as the fallback deliverable address.
    const email = user.email || (data && data.customerEmail) || null;
    if (!email) {
      return null; // no deliverable address — nothing to record
    }

    const entityRef = data.entityRef ? String(data.entityRef) : null;
    if (entityRef && this.dedupeWindowMs > 0) {
      const since = new Date(this.now() - this.dedupeWindowMs);
      const existing = await this.notificationRepository.findRecentDuplicate(
        userId,
        eventType,
        entityRef,
        since
      );
      if (existing) {
        return null; // already notified for this entity within the window
      }
    }

    const customer = {
      name: user.displayName || email,
      email,
      phone: user.phone || null,
    };

    // When the storefront base URL is configured and the event carries an order
    // number, append the customer-facing "Track Your Order" deep link. It is
    // built from the public order number only — never a Mongo id — and is
    // harmless to carry on other order-scoped events (payment/courier) whose
    // templates simply ignore it.
    let renderData = data;
    const orderNumber = data.order && data.order.orderNumber;
    if (this.storefrontBaseUrl && orderNumber) {
      renderData = {
        ...data,
        trackOrderUrl: `${this.storefrontBaseUrl}/track/${String(orderNumber)}`,
      };
    }

    let rendered;
    try {
      rendered = template.render({ customer, data: renderData });
    } catch (err) {
      throw new NotificationError(
        NOTIFICATION_ERROR_CODES.RENDER_FAILED,
        `Template render failed for ${eventType}: ${err.message || String(err)}`,
        err
      );
    }

    const now = new Date();
    const notification = await this.notificationRepository.create({
      recipient: userId,
      recipientEmail: email,
      channel,
      eventType,
      templateKey: template.key || eventType,
      entityRef,
      payload: renderData,
      status: 'QUEUED',
      attempts: 0,
    });

    if (!this.emailService || typeof this.emailService.sendEmail !== 'function') {
      await this.notificationRepository.markSkipped(notification._id, {
        reason: 'No email provider configured',
        at: now,
      });
      console.warn('[notifications] email skipped', {
        eventType,
        channel,
        recipientType: 'customer',
        recipientDomain: recipientDomain(email),
        provider: null,
        reason: 'No email provider configured',
      });
      return notification;
    }

    const startedAt = Date.now();
    try {
      const result = await this.emailService.sendEmail({
        to: customer.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
      await this.notificationRepository.markSent(notification._id, {
        provider: (result && result.provider) || this.emailService.provider || null,
        providerRef: (result && result.messageId) || null,
        deliveredAt: now,
      });
      console.info('[notifications] email delivered', {
        eventType,
        channel,
        recipientType: 'customer',
        recipientDomain: recipientDomain(email),
        provider: (result && result.provider) || this.emailService.provider || null,
        messageId: (result && result.messageId) || null,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      await this.notificationRepository.markFailed(notification._id, {
        code: (err && err.code) || 'EMAIL_SEND_FAILED',
        message: String((err && err.message) || err).slice(0, ERROR_MESSAGE_MAX),
        at: now,
      });
      console.error('[notifications] email delivery failed', {
        eventType,
        channel,
        recipientType: 'customer',
        recipientDomain: recipientDomain(email),
        provider: this.emailService.provider || null,
        error: {
          code: (err && err.code) || 'EMAIL_SEND_FAILED',
          message: String((err && err.message) || err).slice(0, ERROR_MESSAGE_MAX),
        },
        durationMs: Date.now() - startedAt,
      });
    }

    return notification;
  }

  /**
   * Records an ADMIN-channel notification (admin dashboard event — new order,
   * new customer review). Unlike `notify` there is no email: the template
   * renders a short human-readable `{ title, message }` and the record is
   * persisted directly as SENT (deliveredAt = now) so it appears immediately
   * in the ADMIN notification list.
   *
   * `userId` is the authenticated user whose action triggered the event (used
   * as the recipient for the dedupe guard); it is never emailed and never
   * rendered as text. Returns the Notification document, or `null` when
   * disabled or deduplicated within the window.
   */
  async notifyAdmin({ userId, eventType, data = {} }) {
    if (!this.enabled) {
      return null;
    }
    const template = this.templateRegistry[eventType];
    if (!template) {
      throw new NotificationError(
        NOTIFICATION_ERROR_CODES.UNKNOWN_EVENT_TYPE,
        `Unknown notification event type: ${eventType}`
      );
    }

    const entityRef = data.entityRef ? String(data.entityRef) : null;
    if (entityRef && this.dedupeWindowMs > 0) {
      const since = new Date(this.now() - this.dedupeWindowMs);
      const existing = await this.notificationRepository.findRecentDuplicate(
        userId,
        eventType,
        entityRef,
        since
      );
      if (existing) {
        return null; // already notified for this entity within the window
      }
    }

    let rendered;
    try {
      rendered = template.render({ data });
    } catch (err) {
      throw new NotificationError(
        NOTIFICATION_ERROR_CODES.RENDER_FAILED,
        `Template render failed for ${eventType}: ${err.message || String(err)}`,
        err
      );
    }

    const now = new Date();
    const notification = await this.notificationRepository.create({
      recipient: userId,
      channel: NOTIFICATION_CHANNELS.ADMIN,
      eventType,
      templateKey: template.key || eventType,
      entityRef,
      payload: {
        title: rendered.title || null,
        message: rendered.message || null,
        ...data,
      },
      status: NOTIFICATION_STATUSES.SENT,
      attempts: 1,
      deliveredAt: now,
    });
    return notification;
  }

  /**
   * Sends an admin-facing EMAIL notification (e.g. ADMIN_ORDER_PLACED_EMAIL —
   * "new order received"). Uses the same best-effort EMAIL pipeline as
   * `notify`, but:
   *
   *   - the destination is `to` (when provided) or the configured `adminEmail`;
   *   - the audit record's `recipient` is `userId` — the user whose action
   *     triggered the event (the customer who placed the order), so the
   *     within-window dedupe guard covers exactly one notification per
   *     { customer, event, entity };
   *   - `recipientEmail` records the actual admin address it was sent to;
   *   - when `adminDashboardBaseUrl` is set, `data.adminOrderUrl` is appended
   *     to the rendered payload so templates can deep-link to the admin
   *     dashboard without knowing the base URL themselves.
   *
   * Best-effort: a missing/empty admin email returns null (nothing recorded);
   * provider failures are recorded as FAILED and never thrown.
   *
   * `persist` (default true) controls whether a Notification audit record is
   * created. The admin NEW ORDER email (ADMIN_ORDER_PLACED_EMAIL) is an
   * email-only side effect — it must be delivered, but it is NOT an in-app
   * notification, so OrderService calls it with `persist: false` and no
   * Notification document is ever persisted for it (it therefore cannot show
   * up in the admin notification center).
   */
  async notifyAdminEmail({ userId, eventType, to = null, data = {}, persist = true }) {
    if (!this.enabled) {
      return null;
    }
    const template = this.templateRegistry[eventType];
    if (!template) {
      throw new NotificationError(
        NOTIFICATION_ERROR_CODES.UNKNOWN_EVENT_TYPE,
        `Unknown notification event type: ${eventType}`
      );
    }
    const recipientEmail = (to || this.adminEmail || '').trim();
    if (!recipientEmail) {
      console.warn('[notifications] admin email skipped: no admin email configured', { eventType });
      return null;
    }

    const entityRef = data.entityRef ? String(data.entityRef) : null;
    // Only persisted admin emails participate in the within-window dedupe
    // guard — an email-only event has no audit row to dedupe against (the
    // business services' own idempotency short-circuits cover that).
    if (persist && entityRef && this.dedupeWindowMs > 0) {
      const since = new Date(this.now() - this.dedupeWindowMs);
      const existing = await this.notificationRepository.findRecentDuplicate(
        userId,
        eventType,
        entityRef,
        since
      );
      if (existing) {
        return null; // already notified for this entity within the window
      }
    }

    let renderData = data;
    if (this.adminDashboardBaseUrl && entityRef) {
      renderData = {
        ...data,
        adminOrderUrl: buildAdminOrderUrl(this.adminDashboardBaseUrl, entityRef),
      };
    }

    let rendered;
    try {
      rendered = template.render({ data: renderData });
    } catch (err) {
      throw new NotificationError(
        NOTIFICATION_ERROR_CODES.RENDER_FAILED,
        `Template render failed for ${eventType}: ${err.message || String(err)}`,
        err
      );
    }

    // Email-only admin events (ADMIN_ORDER_PLACED_EMAIL): deliver the email but
    // persist NO Notification audit record, so the event never appears in the
    // in-app admin notification center. Delivery stays best-effort and never
    // throws.
    if (!persist) {
      if (!this.emailService || typeof this.emailService.sendEmail !== 'function') {
        console.warn('[notifications] admin email skipped (email-only, no audit record)', {
          eventType,
          channel: NOTIFICATION_CHANNELS.EMAIL,
          recipientType: 'admin',
          recipientDomain: recipientDomain(recipientEmail),
          provider: null,
          reason: 'No email provider configured',
        });
        return null;
      }
      const startedAt = Date.now();
      try {
        const result = await this.emailService.sendEmail({
          to: recipientEmail,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
        });
        console.info('[notifications] admin email delivered (email-only, no audit record)', {
          eventType,
          channel: NOTIFICATION_CHANNELS.EMAIL,
          recipientType: 'admin',
          recipientDomain: recipientDomain(recipientEmail),
          provider: (result && result.provider) || this.emailService.provider || null,
          messageId: (result && result.messageId) || null,
          durationMs: Date.now() - startedAt,
        });
        return {
          sent: true,
          to: recipientEmail,
          provider: (result && result.provider) || this.emailService.provider || null,
          providerRef: (result && result.messageId) || null,
        };
      } catch (err) {
        console.error('[notifications] admin email delivery failed (email-only, no audit record)', {
          eventType,
          channel: NOTIFICATION_CHANNELS.EMAIL,
          recipientType: 'admin',
          recipientDomain: recipientDomain(recipientEmail),
          provider: this.emailService.provider || null,
          error: {
            code: (err && err.code) || 'EMAIL_SEND_FAILED',
            message: String((err && err.message) || err).slice(0, ERROR_MESSAGE_MAX),
          },
          durationMs: Date.now() - startedAt,
        });
        return {
          sent: false,
          to: recipientEmail,
          error: {
            code: (err && err.code) || 'EMAIL_SEND_FAILED',
            message: String((err && err.message) || err).slice(0, ERROR_MESSAGE_MAX),
          },
        };
      }
    }

    const now = new Date();
    const notification = await this.notificationRepository.create({
      recipient: userId,
      recipientEmail,
      channel: NOTIFICATION_CHANNELS.EMAIL,
      eventType,
      templateKey: template.key || eventType,
      entityRef,
      payload: renderData,
      status: NOTIFICATION_STATUSES.QUEUED,
      attempts: 0,
    });

    if (!this.emailService || typeof this.emailService.sendEmail !== 'function') {
      await this.notificationRepository.markSkipped(notification._id, {
        reason: 'No email provider configured',
        at: now,
      });
      console.warn('[notifications] email skipped', {
        eventType,
        channel: NOTIFICATION_CHANNELS.EMAIL,
        recipientType: 'admin',
        recipientDomain: recipientDomain(recipientEmail),
        provider: null,
        reason: 'No email provider configured',
      });
      return notification;
    }

    const startedAt = Date.now();
    try {
      const result = await this.emailService.sendEmail({
        to: recipientEmail,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
      await this.notificationRepository.markSent(notification._id, {
        provider: (result && result.provider) || this.emailService.provider || null,
        providerRef: (result && result.messageId) || null,
        deliveredAt: now,
      });
      console.info('[notifications] email delivered', {
        eventType,
        channel: NOTIFICATION_CHANNELS.EMAIL,
        recipientType: 'admin',
        recipientDomain: recipientDomain(recipientEmail),
        provider: (result && result.provider) || this.emailService.provider || null,
        messageId: (result && result.messageId) || null,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      await this.notificationRepository.markFailed(notification._id, {
        code: (err && err.code) || 'EMAIL_SEND_FAILED',
        message: String((err && err.message) || err).slice(0, ERROR_MESSAGE_MAX),
        at: now,
      });
      console.error('[notifications] email delivery failed', {
        eventType,
        channel: NOTIFICATION_CHANNELS.EMAIL,
        recipientType: 'admin',
        recipientDomain: recipientDomain(recipientEmail),
        provider: this.emailService.provider || null,
        error: {
          code: (err && err.code) || 'EMAIL_SEND_FAILED',
          message: String((err && err.message) || err).slice(0, ERROR_MESSAGE_MAX),
        },
        durationMs: Date.now() - startedAt,
      });
    }

    return notification;
  }

  // ---------------------------------------------------------------------
  // Admin surface (ADMIN-only read audit trail)
  // ---------------------------------------------------------------------

  notificationNotFound() {
    return new ApiError(
      404,
      NOTIFICATION_MESSAGES.NOTIFICATION_NOT_FOUND,
      ERROR_CODES.NOTIFICATION_NOT_FOUND
    );
  }

  /**
   * ADMIN list of notifications (newest first), optionally filtered by the
   * validated `status` / `eventType` filters from the controller. Only the
   * safe `toNotificationOutput` shape is ever serialized — `payload` is an
   * internal audit snapshot and never leaves the backend.
   */
  async listNotifications({ status, eventType, page, limit }) {
    const filter = {};
    if (status !== undefined && status !== null && status !== '') {
      filter.status = status;
    }
    if (eventType !== undefined && eventType !== null && eventType !== '') {
      filter.eventType = eventType;
    }
    const { page: safePage, limit: safeLimit, skip } = normalizePagination({ page, limit });
    const [docs, total] = await Promise.all([
      this.notificationRepository.findMany(filter, {
        sort: { createdAt: -1 },
        skip,
        limit: safeLimit,
      }),
      this.notificationRepository.count(filter),
    ]);
    return {
      notifications: docs.map((doc) => toNotificationOutput(doc)),
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit),
      },
    };
  }

  /**
   * ADMIN detail of one notification. 404 when the id is malformed or no
   * matching notification exists.
   */
  async getNotification(id) {
    assertObjectId(id, 'id');
    const doc = await this.notificationRepository.findById(id);
    if (!doc) {
      throw this.notificationNotFound();
    }
    return toNotificationOutput(doc);
  }
}

module.exports = {
  NotificationService,
  createMaybeNotify,
  createMaybeNotifyAdmin,
  createMaybeNotifyAdminEmail,
};
