'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { NotificationService, createMaybeNotify, createMaybeNotifyAdmin, createMaybeNotifyAdminEmail } = require('../../../src/modules/notifications/notification.service');
const {
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_STATUSES,
} = require('../../../src/modules/notifications/notification.constants');
const {
  NOTIFICATION_ERROR_CODES,
} = require('../../../src/modules/notifications/notification.errors');
const { notificationTemplates } = require('../../../src/modules/notifications/templates');
const { createMemoryEmailService } = require('../../../src/integrations/email/email.mock');

const CUSTOMER = '507f1f77bcf86cd799439111';

function makeUser(overrides = {}) {
  return {
    _id: CUSTOMER,
    email: 'customer@taqwa.test',
    displayName: 'Ayesha Customer',
    phone: '+971501234567',
    ...overrides,
  };
}

function createMemoryNotificationRepository(initial = []) {
  const docs = [...initial];
  let seq = 0;

  const find = (id) => docs.find((d) => String(d._id) === String(id)) || null;

  return {
    docs,

    async create(data) {
      const now = new Date();
      const doc = {
        _id: `notif-${++seq}`,
        status: NOTIFICATION_STATUSES.QUEUED,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      docs.push(doc);
      return doc;
    },

    async findRecentDuplicate(recipient, eventType, entityRef, since) {
      const found = docs.find(
        (d) =>
          String(d.recipient) === String(recipient) &&
          d.eventType === eventType &&
          d.entityRef === String(entityRef) &&
          new Date(d.createdAt) >= new Date(since)
      );
      return found || null;
    },

    async markSent(id, { provider, providerRef, deliveredAt }) {
      const doc = find(id);
      Object.assign(doc, {
        status: NOTIFICATION_STATUSES.SENT,
        provider: provider || null,
        providerRef: providerRef || null,
        deliveredAt,
        attempts: doc.attempts + 1,
      });
      return doc;
    },

    async markFailed(id, { code, message, at }) {
      const doc = find(id);
      Object.assign(doc, {
        status: NOTIFICATION_STATUSES.FAILED,
        lastAttemptAt: at || new Date(),
        lastError: { code, message },
        attempts: doc.attempts + 1,
      });
      return doc;
    },

    async markSkipped(id, { reason, at }) {
      const doc = find(id);
      Object.assign(doc, {
        status: NOTIFICATION_STATUSES.SKIPPED,
        lastAttemptAt: at || new Date(),
        lastError: { code: 'SKIPPED', message: reason || null },
        attempts: doc.attempts + 1,
      });
      return doc;
    },
  };
}

function createMemoryUserRepository(users) {
  return {
    async findById(id) {
      return users.find((u) => String(u._id) === String(id)) || null;
    },
  };
}

function createHarness({
  users = [makeUser()],
  notifications = [],
  emailService = createMemoryEmailService(),
  enabled = true,
  dedupeWindowMs = 60 * 60 * 1000,
  templateRegistry = notificationTemplates,
  adminEmail = null,
  adminDashboardBaseUrl = null,
  storefrontBaseUrl = null,
} = {}) {
  const notificationRepo = createMemoryNotificationRepository(notifications);
  const userRepo = createMemoryUserRepository(users);
  const service = new NotificationService({
    notificationRepository: notificationRepo,
    userRepository: userRepo,
    templateRegistry,
    emailService,
    enabled,
    dedupeWindowMs,
    adminEmail,
    adminDashboardBaseUrl,
    storefrontBaseUrl,
  });
  return { service, notificationRepo, userRepo, emailService };
}

function paymentEventData(overrides = {}) {
  return {
    entityRef: 'pay-1',
    order: { orderNumber: 'TAQ-20260808-000001' },
    payment: { transactionReference: 'REF-1', amountMinorUnits: 248000 },
    ...overrides,
  };
}

test('notify renders the template, sends email, and marks the record SENT', async () => {
  const { service, notificationRepo, emailService } = createHarness();
  const notification = await service.notify({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.PAYMENT_VERIFIED,
    data: paymentEventData(),
  });

  assert.ok(notification);
  assert.equal(notification.status, NOTIFICATION_STATUSES.SENT);
  assert.equal(notification.eventType, NOTIFICATION_EVENT_TYPES.PAYMENT_VERIFIED);
  assert.equal(notification.recipient, CUSTOMER);
  assert.equal(notification.attempts, 1);
  assert.equal(notification.provider, 'mock');

  assert.equal(emailService.calls.sends.length, 1);
  const sent = emailService.calls.sends[0];
  assert.equal(sent.to, 'customer@taqwa.test');
  assert.match(sent.subject, /Payment verified for order TAQ-20260808-000001/);
  assert.match(sent.text, /2,480\.00/); // formatted minor units
  assert.equal(notificationRepo.docs[0].status, NOTIFICATION_STATUSES.SENT);
});

test('disabled service is a no-op: nothing persisted, nothing sent', async () => {
  const { service, notificationRepo, emailService } = createHarness({ enabled: false });
  const result = await service.notify({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.PAYMENT_SUBMITTED,
    data: paymentEventData(),
  });
  assert.equal(result, null);
  assert.equal(notificationRepo.docs.length, 0);
  assert.equal(emailService.calls.sends.length, 0);
});

test('unknown event type throws a controlled NotificationError', async () => {
  const { service } = createHarness();
  await assert.rejects(
    () => service.notify({ userId: CUSTOMER, eventType: 'NOT_A_REAL_EVENT', data: {} }),
    (err) =>
      err.code === NOTIFICATION_ERROR_CODES.UNKNOWN_EVENT_TYPE &&
      /Unknown notification event type/.test(err.message)
  );
});

test('a recipient without an email address is skipped silently', async () => {
  const { service, notificationRepo, emailService } = createHarness({
    users: [makeUser({ email: undefined })],
  });
  const result = await service.notify({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.PAYMENT_SUBMITTED,
    data: paymentEventData(),
  });
  assert.equal(result, null);
  assert.equal(notificationRepo.docs.length, 0);
  assert.equal(emailService.calls.sends.length, 0);
});

test('a user without an email still receives email sent to data.customerEmail (guest checkout)', async () => {
  const { service, notificationRepo, emailService } = createHarness({
    users: [makeUser({ email: undefined })],
  });
  const notification = await service.notify({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.ORDER_PLACED,
    data: {
      entityRef: 'order-1',
      customerEmail: 'guest@example.com',
      order: { orderNumber: 'TAQ-20260808-000001', paymentMethod: 'COD' },
    },
  });

  assert.ok(notification);
  assert.equal(notification.status, NOTIFICATION_STATUSES.SENT);
  assert.equal(notification.eventType, NOTIFICATION_EVENT_TYPES.ORDER_PLACED);
  assert.equal(notification.recipient, CUSTOMER);
  assert.equal(notificationRepo.docs.length, 1);
  assert.equal(emailService.calls.sends.length, 1);
  const sent = emailService.calls.sends[0];
  assert.equal(sent.to, 'guest@example.com');
  assert.match(sent.subject, /Order TAQ-20260808-000001 received/);
});

test('the account email wins over data.customerEmail (signed-in customers)', async () => {
  const { service, notificationRepo, emailService } = createHarness();
  const notification = await service.notify({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.ORDER_PLACED,
    data: {
      entityRef: 'order-1',
      customerEmail: 'guest@example.com',
      order: { orderNumber: 'TAQ-20260808-000001', paymentMethod: 'COD' },
    },
  });

  assert.ok(notification);
  assert.equal(notification.recipient, CUSTOMER);
  assert.equal(emailService.calls.sends.length, 1);
  assert.equal(emailService.calls.sends[0].to, 'customer@taqwa.test');
  assert.equal(notificationRepo.docs[0].payload.customerEmail, 'guest@example.com');
});

test('notify appends the trackOrderUrl deep link when the storefront base URL is configured', async () => {
  const { service, notificationRepo, emailService } = createHarness({
    storefrontBaseUrl: 'https://taqwactg.com/',
  });
  const notification = await service.notify({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.ORDER_PLACED,
    data: {
      entityRef: 'order-1',
      customerEmail: 'guest@example.com',
      order: { orderNumber: 'TAQ-20260808-000001', paymentMethod: 'COD' },
    },
  });

  assert.ok(notification);
  assert.equal(
    notificationRepo.docs[0].payload.trackOrderUrl,
    'https://taqwactg.com/track/TAQ-20260808-000001'
  );
  const sent = emailService.calls.sends[0];
  assert.ok(sent.html.includes('https://www.asiaelectronicsonline.com/track-order'));
  assert.ok(sent.html.includes('Track Your Order'));
  assert.match(sent.text, /Track your order: https:\/\/www\.asiaelectronicsonline\.com\/track-order/);
});

test('notify does not add a trackOrderUrl without a storefront base URL or order number', async () => {
  const { service, notificationRepo } = createHarness();
  await service.notify({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.ORDER_PLACED,
    data: {
      entityRef: 'order-1',
      customerEmail: 'guest@example.com',
      order: { paymentMethod: 'COD' },
    },
  });
  assert.equal(notificationRepo.docs[0].payload.trackOrderUrl, undefined);
});

test('no email service configured → record is marked SKIPPED', async () => {
  const { service, notificationRepo } = createHarness({ emailService: null });
  const notification = await service.notify({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.PAYMENT_SUBMITTED,
    data: paymentEventData(),
  });
  assert.equal(notification.status, NOTIFICATION_STATUSES.SKIPPED);
  assert.equal(notificationRepo.docs[0].status, NOTIFICATION_STATUSES.SKIPPED);
});

test('provider failure → record is marked FAILED with the error, never throws', async () => {
  const { service, notificationRepo, emailService } = createHarness();
  emailService.failNextSendWith(Object.assign(new Error('SMTP down'), { code: 'SMTP_CONNECTION_FAILED' }));

  const notification = await service.notify({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.PAYMENT_REJECTED,
    data: paymentEventData({ note: 'unclear proof' }),
  });

  assert.equal(notification.status, NOTIFICATION_STATUSES.FAILED);
  assert.equal(notificationRepo.docs[0].status, NOTIFICATION_STATUSES.FAILED);
  assert.equal(notificationRepo.docs[0].lastError.code, 'SMTP_CONNECTION_FAILED');
  assert.match(notificationRepo.docs[0].lastError.message, /SMTP down/);
  assert.equal(notification.attempts, 1);
});

test('within-window dedupe suppresses an identical resend', async () => {
  const { service, emailService } = createHarness();
  const first = await service.notify({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.PAYMENT_SUBMITTED,
    data: paymentEventData(),
  });
  const second = await service.notify({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.PAYMENT_SUBMITTED,
    data: paymentEventData(),
  });

  assert.ok(first);
  assert.equal(second, null);
  assert.equal(emailService.calls.sends.length, 1, 'only one email is delivered');
});

test('dedupe does not suppress a different entity', async () => {
  const { service, emailService } = createHarness();
  await service.notify({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.PAYMENT_SUBMITTED,
    data: paymentEventData({ entityRef: 'pay-1' }),
  });
  await service.notify({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.PAYMENT_SUBMITTED,
    data: paymentEventData({ entityRef: 'pay-2' }),
  });
  assert.equal(emailService.calls.sends.length, 2);
});

test('createMaybeNotify is a no-op without a notification service', async () => {
  const maybeNotify = createMaybeNotify(null);
  const result = await maybeNotify({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.PAYMENT_SUBMITTED,
    data: paymentEventData(),
  });
  assert.equal(result, null);
});

test('createMaybeNotify swallows and logs notification-service failures', async () => {
  const failingService = {
    async notify() {
      throw new Error('boom');
    },
  };
  const maybeNotify = createMaybeNotify(failingService);
  const result = await maybeNotify({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.PAYMENT_SUBMITTED,
    data: paymentEventData(),
  });
  assert.equal(result, null);
});

function adminOrderData(overrides = {}) {
  return {
    entityRef: 'order-1',
    orderNumber: 'TAQ-20260808-000001',
    customerName: 'Ayesha Customer',
    itemCount: 3,
    grandTotalMinorUnits: 248000,
    paymentMethod: 'COD',
    ...overrides,
  };
}

test('notifyAdmin records an ADMIN-channel SENT notification with a readable title/message, no email sent', async () => {
  const { service, notificationRepo, emailService } = createHarness();
  const notification = await service.notifyAdmin({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED,
    data: adminOrderData(),
  });

  assert.ok(notification);
  assert.equal(notification.channel, 'ADMIN');
  assert.equal(notification.eventType, NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED);
  assert.equal(notification.recipient, CUSTOMER);
  assert.equal(notification.entityRef, 'order-1');
  assert.equal(notification.status, NOTIFICATION_STATUSES.SENT);
  assert.ok(notification.deliveredAt, 'admin notifications are immediately available');
  assert.equal(emailService.calls.sends.length, 0, 'no email is sent for the ADMIN channel');

  assert.match(notification.payload.title, /TAQ-20260808-000001/);
  assert.match(notification.payload.message, /Ayesha Customer/);
  assert.match(notification.payload.message, /2,480\.00/);

  assert.equal(notificationRepo.docs[0].status, NOTIFICATION_STATUSES.SENT);
});

test('notifyAdmin deduplicates an identical event+entity within the window', async () => {
  const { service, notificationRepo } = createHarness();
  const first = await service.notifyAdmin({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.ADMIN_REVIEW_SUBMITTED,
    data: { entityRef: 'review-1', productName: 'Abaya', customerName: 'Ayesha', rating: 5 },
  });
  const second = await service.notifyAdmin({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.ADMIN_REVIEW_SUBMITTED,
    data: { entityRef: 'review-1', productName: 'Abaya', customerName: 'Ayesha', rating: 5 },
  });

  assert.ok(first);
  assert.equal(second, null);
  assert.equal(notificationRepo.docs.length, 1);
});

test('notifyAdmin does not deduplicate a different entity', async () => {
  const { service, notificationRepo } = createHarness();
  await service.notifyAdmin({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED,
    data: adminOrderData({ entityRef: 'order-1' }),
  });
  await service.notifyAdmin({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED,
    data: adminOrderData({ entityRef: 'order-2', orderNumber: 'TAQ-20260808-000002' }),
  });
  assert.equal(notificationRepo.docs.length, 2);
});

test('disabled service skips notifyAdmin: nothing persisted', async () => {
  const { service, notificationRepo } = createHarness({ enabled: false });
  const result = await service.notifyAdmin({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED,
    data: adminOrderData(),
  });
  assert.equal(result, null);
  assert.equal(notificationRepo.docs.length, 0);
});

test('notifyAdmin with an unknown event type throws a controlled NotificationError', async () => {
  const { service } = createHarness();
  await assert.rejects(
    () => service.notifyAdmin({ userId: CUSTOMER, eventType: 'NOT_A_REAL_EVENT', data: {} }),
    (err) =>
      err.code === NOTIFICATION_ERROR_CODES.UNKNOWN_EVENT_TYPE &&
      /Unknown notification event type/.test(err.message)
  );
});

test('createMaybeNotifyAdmin is a no-op without a notification service', async () => {
  const maybeNotifyAdmin = createMaybeNotifyAdmin(null);
  const result = await maybeNotifyAdmin({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED,
    data: adminOrderData(),
  });
  assert.equal(result, null);
});

test('createMaybeNotifyAdmin swallows and logs notifyAdmin failures', async () => {
  const failingService = {
    async notifyAdmin() {
      throw new Error('boom');
    },
  };
  const maybeNotifyAdmin = createMaybeNotifyAdmin(failingService);
  const result = await maybeNotifyAdmin({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED,
    data: adminOrderData(),
  });
  assert.equal(result, null);
});

test('notify records the resolved recipient email on the audit record', async () => {
  const { service, notificationRepo } = createHarness();
  await service.notify({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.PAYMENT_SUBMITTED,
    data: paymentEventData(),
  });
  assert.equal(notificationRepo.docs[0].recipientEmail, 'customer@taqwa.test');
});

function adminEmailData(overrides = {}) {
  return {
    entityRef: 'order-1',
    orderNumber: 'TAQ-20260808-000001',
    createdAt: new Date('2026-08-08T10:00:00Z'),
    status: 'PENDING',
    paymentMethod: 'COD',
    paymentStatus: 'Pending — collect on delivery',
    customerName: 'Ayesha Customer',
    customerPhone: '+971501234567',
    customerEmail: null,
    address: { line1: 'House 12', city: 'Chattogram', district: 'Chattogram', postalCode: '4000' },
    notes: null,
    totals: {
      itemsSubtotalMinorUnits: 100000,
      totalDiscountMinorUnits: 0,
      deliveryFeeMinorUnits: 0,
      grandTotalMinorUnits: 100000,
    },
    items: [
      { productName: 'Abaya', variantAttributes: { size: '52' }, quantity: 1, unitPriceMinorUnits: 100000, lineTotalMinorUnits: 100000 },
    ],
    ...overrides,
  };
}

test('notifyAdminEmail builds the admin order URL from the SITE ORIGIN even when the dashboard base URL has a path', async () => {
  const { service, notificationRepo } = createHarness({
    adminEmail: 'orders@taqwa.test',
    adminDashboardBaseUrl: 'https://www.taqwactg.com/admin/dashboard',
  });
  const notification = await service.notifyAdminEmail({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED_EMAIL,
    data: adminEmailData(),
  });

  assert.ok(notification);
  assert.equal(
    notification.payload.adminOrderUrl,
    'https://www.taqwactg.com/admin/orders/order-1'
  );
  assert.ok(
    !notification.payload.adminOrderUrl.includes('/admin/dashboard'),
    'the dashboard path must not be duplicated into the deep link'
  );
});

test('notifyAdminEmail renders the template, sends to the configured admin email, and marks the record SENT', async () => {
  const { service, notificationRepo, emailService } = createHarness({
    adminEmail: 'orders@taqwa.test',
    adminDashboardBaseUrl: 'https://admin.taqwa.com',
  });
  const notification = await service.notifyAdminEmail({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED_EMAIL,
    data: adminEmailData(),
  });

  assert.ok(notification);
  assert.equal(notification.channel, 'EMAIL');
  assert.equal(notification.eventType, NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED_EMAIL);
  assert.equal(notification.recipient, CUSTOMER, 'recipient is the user who triggered the event');
  assert.equal(notification.recipientEmail, 'orders@taqwa.test');
  assert.equal(notification.status, NOTIFICATION_STATUSES.SENT);
  assert.equal(notification.payload.adminOrderUrl, 'https://admin.taqwa.com/admin/orders/order-1');

  assert.equal(emailService.calls.sends.length, 1);
  const sent = emailService.calls.sends[0];
  assert.equal(sent.to, 'orders@taqwa.test');
  assert.match(sent.subject, /New order TAQ-20260808-000001 received/);
  assert.match(sent.html, /New Order Received/);
  assert.match(sent.html, /Ayesha Customer/);
  assert.match(sent.html, /admin\.taqwa\.com\/admin\/orders\/order-1/);
  assert.ok(!sent.html.includes('undefined'), 'no raw undefined in the HTML');
  assert.match(sent.text, /Grand total: \u09F31,000\.00/);
});

test('notifyAdminEmail honors an explicit to over the configured admin email', async () => {
  const { service, emailService } = createHarness({
    adminEmail: 'orders@taqwa.test',
  });
  await service.notifyAdminEmail({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED_EMAIL,
    to: 'backup@taqwa.test',
    data: adminEmailData(),
  });
  assert.equal(emailService.calls.sends[0].to, 'backup@taqwa.test');
});

test('notifyAdminEmail with persist: false delivers the email but never persists a record', async () => {
  const { service, notificationRepo, emailService } = createHarness({
    adminEmail: 'orders@taqwa.test',
    adminDashboardBaseUrl: 'https://admin.taqwa.com',
  });
  const result = await service.notifyAdminEmail({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED_EMAIL,
    data: adminEmailData(),
    persist: false,
  });

  assert.equal(notificationRepo.docs.length, 0, 'no Notification record is created');
  assert.equal(emailService.calls.sends.length, 1, 'the admin email is still delivered');
  const sent = emailService.calls.sends[0];
  assert.equal(sent.to, 'orders@taqwa.test');
  assert.match(sent.subject, /New order TAQ-20260808-000001 received/);
  assert.match(sent.html, /admin\.taqwa\.com\/admin\/orders\/order-1/);
  assert.equal(result.sent, true);
  assert.equal(result.to, 'orders@taqwa.test');
  assert.equal(result.provider, 'mock');
});

test('notifyAdminEmail with persist: false and no email provider returns null without a record', async () => {
  const { service, notificationRepo } = createHarness({
    adminEmail: 'orders@taqwa.test',
    emailService: null,
  });
  const result = await service.notifyAdminEmail({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED_EMAIL,
    data: adminEmailData(),
    persist: false,
  });
  assert.equal(result, null);
  assert.equal(notificationRepo.docs.length, 0);
});

test('notifyAdminEmail with persist: false swallows provider failures without a record', async () => {
  const { service, notificationRepo, emailService } = createHarness({
    adminEmail: 'orders@taqwa.test',
  });
  emailService.failNextSendWith(Object.assign(new Error('SMTP down'), { code: 'SMTP_CONNECTION_FAILED' }));

  const result = await service.notifyAdminEmail({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED_EMAIL,
    data: adminEmailData(),
    persist: false,
  });

  assert.equal(result.sent, false);
  assert.equal(result.error.code, 'SMTP_CONNECTION_FAILED');
  assert.equal(notificationRepo.docs.length, 0, 'no record is created for a failed email-only event');
});

test('notifyAdminEmail returns null (and records nothing) when no admin email is configured', async () => {
  const { service, notificationRepo, emailService } = createHarness();
  const result = await service.notifyAdminEmail({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED_EMAIL,
    data: adminEmailData(),
  });
  assert.equal(result, null);
  assert.equal(notificationRepo.docs.length, 0);
  assert.equal(emailService.calls.sends.length, 0);
});

test('notifyAdminEmail deduplicates an identical event+entity within the window', async () => {
  const { service, emailService, notificationRepo } = createHarness({ adminEmail: 'orders@taqwa.test' });
  const first = await service.notifyAdminEmail({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED_EMAIL,
    data: adminEmailData(),
  });
  const second = await service.notifyAdminEmail({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED_EMAIL,
    data: adminEmailData(),
  });

  assert.ok(first);
  assert.equal(second, null);
  assert.equal(emailService.calls.sends.length, 1, 'only one admin email is delivered');
  assert.equal(notificationRepo.docs.length, 1);
});

test('notifyAdminEmail does not deduplicate a different entity', async () => {
  const { service, emailService, notificationRepo } = createHarness({ adminEmail: 'orders@taqwa.test' });
  await service.notifyAdminEmail({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED_EMAIL,
    data: adminEmailData({ entityRef: 'order-1' }),
  });
  await service.notifyAdminEmail({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED_EMAIL,
    data: adminEmailData({ entityRef: 'order-2', orderNumber: 'TAQ-20260808-000002' }),
  });
  assert.equal(emailService.calls.sends.length, 2);
  assert.equal(notificationRepo.docs.length, 2);
});

test('notifyAdminEmail provider failure → record FAILED, never throws', async () => {
  const { service, notificationRepo, emailService } = createHarness({ adminEmail: 'orders@taqwa.test' });
  emailService.failNextSendWith(Object.assign(new Error('SMTP down'), { code: 'SMTP_CONNECTION_FAILED' }));

  const notification = await service.notifyAdminEmail({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED_EMAIL,
    data: adminEmailData(),
  });

  assert.equal(notification.status, NOTIFICATION_STATUSES.FAILED);
  assert.equal(notificationRepo.docs[0].lastError.code, 'SMTP_CONNECTION_FAILED');
  assert.match(notificationRepo.docs[0].lastError.message, /SMTP down/);
});

test('notifyAdminEmail without an email provider → record SKIPPED', async () => {
  const { service, notificationRepo } = createHarness({ adminEmail: 'orders@taqwa.test', emailService: null });
  const notification = await service.notifyAdminEmail({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED_EMAIL,
    data: adminEmailData(),
  });
  assert.equal(notification.status, NOTIFICATION_STATUSES.SKIPPED);
  assert.equal(notificationRepo.docs[0].status, NOTIFICATION_STATUSES.SKIPPED);
});

test('notifyAdminEmail with an unknown event type throws a controlled NotificationError', async () => {
  const { service } = createHarness({ adminEmail: 'orders@taqwa.test' });
  await assert.rejects(
    () => service.notifyAdminEmail({ userId: CUSTOMER, eventType: 'NOT_A_REAL_EVENT', data: {} }),
    (err) =>
      err.code === NOTIFICATION_ERROR_CODES.UNKNOWN_EVENT_TYPE &&
      /Unknown notification event type/.test(err.message)
  );
});

test('createMaybeNotifyAdminEmail is a no-op without a notification service', async () => {
  const maybeNotifyAdminEmail = createMaybeNotifyAdminEmail(null);
  const result = await maybeNotifyAdminEmail({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED_EMAIL,
    data: adminEmailData(),
  });
  assert.equal(result, null);
});

test('createMaybeNotifyAdminEmail forwards persist to notifyAdminEmail', async () => {
  let received = null;
  const spyService = {
    async notifyAdminEmail(opts) {
      received = opts;
      return { sent: true };
    },
  };
  const maybeNotifyAdminEmail = createMaybeNotifyAdminEmail(spyService);
  const result = await maybeNotifyAdminEmail({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED_EMAIL,
    data: adminEmailData(),
    persist: false,
  });
  assert.equal(received.persist, false);
  assert.deepEqual(result, { sent: true });
});

test('createMaybeNotifyAdminEmail swallows and logs notifyAdminEmail failures', async () => {
  const failingService = {
    async notifyAdminEmail() {
      throw new Error('boom');
    },
  };
  const maybeNotifyAdminEmail = createMaybeNotifyAdminEmail(failingService);
  const result = await maybeNotifyAdminEmail({
    userId: CUSTOMER,
    eventType: NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED_EMAIL,
    data: adminEmailData(),
  });
  assert.equal(result, null);
});
