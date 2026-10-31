'use strict';

process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');

const { NotificationService } = require('../../src/modules/notifications/notification.service');
const { NOTIFICATION_EVENT_TYPES, NOTIFICATION_STATUSES } = require('../../src/modules/notifications/notification.constants');
const { notificationTemplates } = require('../../src/modules/notifications/templates');
const { createMemoryNotificationRepository } = require('../../tests/helpers/notification-stubs');
const { createMemoryEmailService } = require('../../src/integrations/email/email.mock');
const {
  V1,
  seedUsers,
  buildApp,
  request,
  checkoutBody,
  VALID_ADDRESS,
  setupAuth,
  guestHeaders,
} = require('../helpers/order-integration-fixtures');

const ADMIN_EMAIL = 'orders@taqwa.test';
const ADMIN_BASE_URL = 'https://admin.taqwa.com';

const BASE = '/api/v1/orders';
const CART = '/api/v1/cart';

const GUEST_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

let tokens;

before(async () => {
  tokens = await setupAuth();
});

function idempotencyHeaders(key) {
  return { 'Idempotency-Key': key };
}

/**
 * Builds an app whose OrderService is wired to a REAL NotificationService
 * (real templates, memory repos, memory email service, configured admin
 * email + dashboard base URL). The user repository reads live from the same
 * `users` array the app provisions guests into.
 */
function buildAdminEmailHarness() {
  const users = seedUsers();
  const emailService = createMemoryEmailService();
  const notificationRepository = createMemoryNotificationRepository();
  const notificationService = new NotificationService({
    notificationRepository,
    userRepository: {
      findById: async (id) => users.find((u) => String(u._id) === String(id)) || null,
    },
    templateRegistry: notificationTemplates,
    emailService,
    enabled: true,
    adminEmail: ADMIN_EMAIL,
    adminDashboardBaseUrl: ADMIN_BASE_URL,
  });
  const built = buildApp({ users, notificationService });
  return { ...built, emailService, notificationRepository };
}

function withHarness(fn) {
  return async () => {
    const harness = buildAdminEmailHarness();
    const server = harness.app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    try {
      await fn(`http://127.0.0.1:${port}`, harness);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

async function customerCheckout(baseUrl, token, key, body = checkoutBody()) {
  const res = await request('POST', `${baseUrl}${BASE}/checkout`, token, body, idempotencyHeaders(key));
  return res;
}

async function guestCheckout(baseUrl, guestId, key, body = checkoutBody()) {
  const res = await request('POST', `${baseUrl}${BASE}/checkout`, null, body, {
    ...guestHeaders(guestId),
    ...idempotencyHeaders(key),
  });
  return res;
}

test('checkout sends the customer confirmation AND the admin new-order email', withHarness(async (baseUrl, harness) => {
  await request('POST', `${baseUrl}${CART}/items`, tokens.tokenCustomer, {
    productVariantId: V1,
    quantity: 1,
  });

  const res = await customerCheckout(baseUrl, tokens.tokenCustomer, 'idem-customer-1');
  assert.equal(res.status, 201);
  const order = (await res.json()).data.order;

  const emails = harness.emailService.calls.sends;
  assert.equal(emails.length, 2, 'customer + admin email');
  assert.ok(emails.some((e) => e.to === 'amina@example.com'), 'customer confirmation sent');
  const adminEmail = emails.find((e) => e.to === ADMIN_EMAIL);
  assert.ok(adminEmail, 'admin new-order email sent');

  assert.match(adminEmail.subject, /New order .* received/);
  assert.ok(adminEmail.html.includes('New Order Received'));
  assert.ok(adminEmail.html.includes(order.orderNumber));
  assert.ok(adminEmail.html.includes('Amina Rahman'));
  assert.ok(adminEmail.html.includes('+8801712345678'));
  assert.ok(adminEmail.html.includes('House 12, Road 5'));
  assert.ok(adminEmail.html.includes('Chattogram'));
  assert.ok(adminEmail.html.includes('COD'));
  assert.ok(adminEmail.html.includes('Pending'));
  assert.ok(adminEmail.html.includes('Abaya'));
  assert.ok(adminEmail.html.includes('৳1,000.00'));
  assert.ok(adminEmail.html.includes('View Order in Admin Dashboard'));
  assert.ok(adminEmail.html.includes(`${ADMIN_BASE_URL}/admin/orders/${order.id}`));

  const withoutHrefs = adminEmail.html.replace(/href="[^"]*"/g, '');
  assert.ok(
    !withoutHrefs.includes(order.id),
    'the Mongo order id appears only inside the dashboard button URL'
  );

  const emailRecords = harness.notificationRepository.docs.filter(
    (d) => d.eventType === NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED_EMAIL
  );
  assert.equal(
    emailRecords.length,
    0,
    'the admin new-order email is delivered but never persisted as an in-app notification'
  );

  const customerRecords = harness.notificationRepository.docs.filter(
    (d) => d.eventType === NOTIFICATION_EVENT_TYPES.ORDER_PLACED
  );
  assert.equal(customerRecords.length, 1, 'the customer "Order placed" notification is recorded');
  assert.equal(customerRecords[0].status, NOTIFICATION_STATUSES.SENT);

  const inAppAdminRecords = harness.notificationRepository.docs.filter(
    (d) => d.eventType === NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED
  );
  assert.equal(inAppAdminRecords.length, 1, 'the in-app "New order" admin notification is recorded');
  assert.equal(inAppAdminRecords[0].status, NOTIFICATION_STATUSES.SENT);
  assert.equal(
    String(inAppAdminRecords[0].entityRef),
    order.id,
    'the in-app admin notification correlates with the placed order'
  );
}));

test('guest checkout without an email still sends the admin new-order email', withHarness(async (baseUrl, harness) => {
  await request('POST', `${baseUrl}${CART}/items`, null, { productVariantId: V1, quantity: 1 }, guestHeaders(GUEST_A));

  const res = await guestCheckout(baseUrl, GUEST_A, 'idem-guest-1');
  assert.equal(res.status, 201);

  const emails = harness.emailService.calls.sends;
  assert.equal(emails.length, 1, 'no customer confirmation (guest has no email), only the admin email');
  assert.equal(emails[0].to, ADMIN_EMAIL);
  assert.ok(emails[0].html.includes('Amina Rahman'), 'admin email carries the guest checkout name');
  assert.ok(emails[0].html.includes('+8801712345678'));

  const docs = harness.notificationRepository.docs;
  assert.equal(
    docs.filter((d) => d.eventType === NOTIFICATION_EVENT_TYPES.ORDER_PLACED).length,
    0,
    'no customer notification is recorded for an emailless guest'
  );
  const adminRecords = docs.filter(
    (d) => d.eventType === NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED_EMAIL
  );
  assert.equal(
    adminRecords.length,
    0,
    'the guest admin email is delivered but never persisted as an in-app notification'
  );
  const inAppAdminRecords = docs.filter(
    (d) => d.eventType === NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED
  );
  assert.equal(
    inAppAdminRecords.length,
    1,
    'the guest order still records the in-app "New order" notification'
  );
}));

test('a checkout retry (same idempotency key) does not send a duplicate admin email', withHarness(async (baseUrl, harness) => {
  await request('POST', `${baseUrl}${CART}/items`, tokens.tokenCustomer, {
    productVariantId: V1,
    quantity: 1,
  });

  const first = await customerCheckout(baseUrl, tokens.tokenCustomer, 'idem-retry-1');
  assert.equal(first.status, 201);
  const retried = await customerCheckout(baseUrl, tokens.tokenCustomer, 'idem-retry-1');
  assert.equal(retried.status, 200, 'idempotent retry returns the existing order');

  assert.equal(harness.emailService.calls.sends.length, 2, 'no duplicate emails on retry');
  assert.equal(
    harness.notificationRepository.docs.filter(
      (d) => d.eventType === NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED_EMAIL
    ).length,
    0,
    'a retry never creates an ADMIN_ORDER_PLACED_EMAIL record'
  );
  assert.equal(
    harness.notificationRepository.docs.filter(
      (d) => d.eventType === NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED
    ).length,
    1,
    'the retry does not duplicate the in-app admin notification'
  );
}));

test('email failure never fails checkout: the order is created and the notification is marked FAILED', withHarness(async (baseUrl, harness) => {
  await request('POST', `${baseUrl}${CART}/items`, tokens.tokenCustomer, {
    productVariantId: V1,
    quantity: 1,
  });

  harness.emailService.failNextSendWith(Object.assign(new Error('SMTP down'), { code: 'SMTP_CONNECTION_FAILED' }));

  const res = await customerCheckout(baseUrl, tokens.tokenCustomer, 'idem-fail-1');
  assert.equal(res.status, 201, 'checkout succeeds despite the email failure');

  const docs = harness.notificationRepository.docs;
  const customerRecord = docs.find((d) => d.eventType === NOTIFICATION_EVENT_TYPES.ORDER_PLACED);
  assert.ok(customerRecord, 'customer notification record exists');
  assert.equal(customerRecord.status, NOTIFICATION_STATUSES.FAILED);
  assert.equal(customerRecord.lastError.code, 'SMTP_CONNECTION_FAILED');

  const adminEmailRecords = docs.filter(
    (d) => d.eventType === NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED_EMAIL
  );
  assert.equal(
    adminEmailRecords.length,
    0,
    'the admin email still goes out but no ADMIN_ORDER_PLACED_EMAIL record is created'
  );
  assert.ok(
    docs.some((d) => d.eventType === NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED),
    'the in-app admin "New order" notification is still recorded'
  );

  assert.equal(
    harness.emailService.calls.sends.filter((e) => e.to === ADMIN_EMAIL).length,
    1,
    'the admin email still goes out when only the customer send failed'
  );
}));
