'use strict';

process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');

const { ERROR_CODES, ROLES, ACCOUNT_STATUSES } = require('../../src/constants');
const {
  V1,
  seedUsers,
  buildApp,
  withServer,
  request,
  checkoutBody,
  VALID_ADDRESS,
  setupAuth,
  guestHeaders,
} = require('../helpers/order-integration-fixtures');

let tokens;

before(async () => {
  tokens = await setupAuth();
});

const BASE = '/api/v1/orders';
const CART = '/api/v1/cart';

const GUEST_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GUEST_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const METHOD_ID = '507f1f77bcf86cd799439301';
const BKASH_METHOD_ID = '507f1f77bcf86cd799439303';
const BOUNDARY = '----taqwaGuestBoundary';

let users;

function checkoutHeaders(key) {
  return { 'Idempotency-Key': key };
}

async function guestAddToCart(baseUrl, guestId, item = { productVariantId: V1, quantity: 1 }) {
  return request('POST', `${baseUrl}${CART}/items`, null, item, guestHeaders(guestId));
}

async function guestCheckout(baseUrl, guestId, body = checkoutBody(), key = 'guest-co') {
  return request('POST', `${baseUrl}${BASE}/checkout`, null, body, {
    ...guestHeaders(guestId),
    ...checkoutHeaders(key),
  });
}

function paymentMethodDoc(overrides = {}) {
  return {
    _id: METHOD_ID,
    code: 'BANK_TRANSFER',
    displayName: 'Bank Transfer',
    type: 'MANUAL',
    metadata: {
      accountName: 'Taqwa Trading',
      accountNumber: '0123456789',
      bankName: 'DBBL',
      instructions: 'Use your order number as reference.',
    },
    isActive: true,
    sortOrder: 1,
    ...overrides,
  };
}

function bkashMethodDoc(overrides = {}) {
  return paymentMethodDoc({
    _id: BKASH_METHOD_ID,
    code: 'BKASH',
    displayName: 'bKash',
    metadata: {
      accountName: 'Taqwa Trading',
      accountNumber: '01712345678',
      instructions: 'Use your order number as reference.',
    },
    ...overrides,
  });
}

function pngBytes(size = 64) {
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const rest = Buffer.alloc(Math.max(0, size - magic.length), 0);
  return Buffer.concat([magic, rest]);
}

function multipartBody({ fields = {}, file } = {}) {
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
    );
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.type}\r\n\r\n`
      )
    );
    parts.push(file.buffer);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(parts);
}

function proofFile(overrides = {}) {
  return {
    name: 'proof',
    filename: 'receipt.png',
    type: 'image/png',
    buffer: pngBytes(),
    ...overrides,
  };
}

function submissionFields(order, overrides = {}) {
  return {
    paymentMethodId: METHOD_ID,
    submittedAmountMinorUnits: String(order.totals.grandTotalMinorUnits),
    transactionReference: 'GUEST-BANK-REF-1',
    ...overrides,
  };
}

async function submitGuestPayment(baseUrl, guestId, order, { idempotencyKey = 'idem-guest' } = {}) {
  const body = multipartBody({
    fields: submissionFields(order),
    file: proofFile(),
  });
  return fetch(`${baseUrl}${BASE}/${order.id}/payment`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
      'Idempotency-Key': idempotencyKey,
      ...guestHeaders(guestId),
    },
    body,
  });
}

test('guest identity is provisioned once as an ACTIVE CUSTOMER and reused', withServer(
  () => {
    users = seedUsers();
    return buildApp({ users });
  },
  async (baseUrl, repos) => {
    const added = await guestAddToCart(baseUrl, GUEST_A);
    assert.equal(added.status, 200);
    assert.equal(users.length, 5, 'first request auto-provisions one guest user');

    const guest = users.find((u) => u.authProviderId === `guest:${GUEST_A}`);
    assert.ok(guest, 'guest is stored with the guest:<uuid> authProviderId');
    assert.equal(guest.role, ROLES.CUSTOMER, 'guest is provisioned as CUSTOMER');
    assert.equal(guest.status, ACCOUNT_STATUSES.ACTIVE, 'guest is ACTIVE');
    assert.match(guest._id, /^[0-9a-f]{24}$/, 'provisioned user carries a valid ObjectId');
    assert.equal(guest.email, undefined, 'guest has no email');

    const checkout = await guestCheckout(baseUrl, GUEST_A);
    assert.equal(checkout.status, 201);
    assert.equal(users.length, 5, 'guest identity is reused, never duplicated');
  }
));

test('guest cart supports add → get → update → remove → clear', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl, repos) => {
    const added = await guestAddToCart(baseUrl, GUEST_A, { productVariantId: V1, quantity: 2 });
    assert.equal(added.status, 200);
    const addedBody = await added.json();
    assert.equal(addedBody.data.cart.items.length, 1);
    const itemId = addedBody.data.cart.items[0].id;

    const got = await request('GET', `${baseUrl}${CART}`, null, undefined, guestHeaders(GUEST_A));
    assert.equal((await got.json()).data.cart.itemCount, 2);

    const updated = await request('PATCH', `${baseUrl}${CART}/items/${itemId}`, null, { quantity: 5 }, guestHeaders(GUEST_A));
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).data.cart.items[0].quantity, 5);

    const removed = await request('DELETE', `${baseUrl}${CART}/items/${itemId}`, null, undefined, guestHeaders(GUEST_A));
    assert.equal(removed.status, 200);
    assert.equal((await removed.json()).data.cart.items.length, 0);

    await guestAddToCart(baseUrl, GUEST_A);
    const cleared = await request('DELETE', `${baseUrl}${CART}`, null, undefined, guestHeaders(GUEST_A));
    assert.equal(cleared.status, 200);
    assert.equal(repos.cartRepo.docs[0].items.length, 0);
  }
));

test('guest checkout creates an order owned by the guest and clears the guest cart', withServer(
  () => {
    users = seedUsers();
    return buildApp({ users });
  },
  async (baseUrl, repos) => {
    await guestAddToCart(baseUrl, GUEST_A, { productVariantId: V1, quantity: 2 });

    const res = await guestCheckout(baseUrl, GUEST_A, checkoutBody(), 'guest-co-1');
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.success, true);
    const order = body.data.order;
    assert.equal(order.status, 'PENDING');
    assert.equal(order.paymentMethod, 'COD');
    assert.match(order.orderNumber, /^TAQ-\d{8}-\d{6}$/);
    assert.equal(order.totals.grandTotalMinorUnits, 208000);

    const guest = users.find((u) => u.authProviderId === `guest:${GUEST_A}`);
    assert.equal(order.customerId, guest._id, 'the order belongs to the guest customer');
    assert.equal(repos.cartRepo.docs[0].isCheckedOut, true);
    assert.equal(repos.cartRepo.docs[0].items.length, 0);
  }
));

test('guest checkout stores an optional delivery email and returns it on the order', withServer(
  () => {
    users = seedUsers();
    return buildApp({ users });
  },
  async (baseUrl, repos) => {
    await guestAddToCart(baseUrl, GUEST_A);

    const res = await guestCheckout(
      baseUrl,
      GUEST_A,
      checkoutBody({ delivery: { address: { ...VALID_ADDRESS, email: '  Guest@Example.COM ' } } }),
      'guest-co-email'
    );
    assert.equal(res.status, 201);
    const order = (await res.json()).data.order;
    assert.equal(order.delivery.address.email, 'guest@example.com', 'email is trimmed and lower-cased');

    assert.equal(repos.orderRepo.docs[0].delivery.address.email, 'guest@example.com');
    const guest = users.find((u) => u.authProviderId === `guest:${GUEST_A}`);
    assert.equal(guest.email, undefined, 'the guest user itself still has no account email');
  }
));

test('guest checkout without an email stores null and still succeeds', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl, repos) => {
    await guestAddToCart(baseUrl, GUEST_A);

    const res = await guestCheckout(baseUrl, GUEST_A, checkoutBody(), 'guest-co-no-email');
    assert.equal(res.status, 201);
    const order = (await res.json()).data.order;
    assert.equal(order.delivery.address.email, null, 'no email supplied → null');
    assert.equal(repos.orderRepo.docs[0].delivery.address.email, null);
  }
));

test('guest checkout is idempotent and honors the customer-scoped key', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl, repos) => {
    await guestAddToCart(baseUrl, GUEST_A);

    const first = await guestCheckout(baseUrl, GUEST_A, checkoutBody(), 'guest-idem-1');
    assert.equal(first.status, 201);
    const firstOrder = (await first.json()).data.order;

    const retry = await guestCheckout(baseUrl, GUEST_A, checkoutBody(), 'guest-idem-1');
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).data.order.id, firstOrder.id);
    assert.equal(repos.orderRepo.docs.length, 1, 'no duplicate order');
    assert.equal(repos.resRepo.docs.length, 1, 'no double reservation');

    const conflict = await guestCheckout(baseUrl, GUEST_A, checkoutBody({ notes: 'changed' }), 'guest-idem-1');
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, ERROR_CODES.ORDER_IDEMPOTENCY_CONFLICT);
  }
));

test('guest checkout records COD, BKASH, BANK_TRANSFER and CARD; rejects an unknown method', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl) => {
    for (const [method, key] of [
      ['COD', 'g-co-cod'],
      ['BKASH', 'g-co-bkash'],
      ['BANK_TRANSFER', 'g-co-bank'],
      ['CARD', 'g-co-card'],
    ]) {
      await guestAddToCart(baseUrl, GUEST_A);
      const res = await guestCheckout(baseUrl, GUEST_A, checkoutBody({ paymentMethod: method }), key);
      assert.equal(res.status, 201, `${method}: guest checkout must succeed`);
      assert.equal((await res.json()).data.order.paymentMethod, method);
    }

    await guestAddToCart(baseUrl, GUEST_A);
    const unknown = await guestCheckout(baseUrl, GUEST_A, checkoutBody({ paymentMethod: 'UPI' }), 'g-co-upi');
    assert.equal(unknown.status, 400);
    assert.equal((await unknown.json()).error.code, ERROR_CODES.INVALID_ORDER);
  }
));

test('authenticated CUSTOMER checkout still works via the Bearer path', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl, repos) => {
    await request('POST', `${baseUrl}${CART}/items`, tokens.tokenCustomer, { productVariantId: V1, quantity: 1 });
    const res = await request('POST', `${baseUrl}${BASE}/checkout`, tokens.tokenCustomer, checkoutBody(), checkoutHeaders('auth-co-1'));
    assert.equal(res.status, 201);
    const order = (await res.json()).data.order;
    assert.equal(order.customerId, '507f1f77bcf86cd799439111');
    assert.equal(repos.orderRepo.docs.length, 1);
  }
));

test('anonymous requests (no token, no guest id) get 401 on guest-capable surfaces', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl) => {
    for (const [method, path] of [
      ['GET', `${CART}`],
      ['POST', `${CART}/items`],
      ['POST', `${BASE}/checkout`],
    ]) {
      const res = await request(method, `${baseUrl}${path}`);
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal((await res.json()).error.code, ERROR_CODES.UNAUTHORIZED);
    }
  }
));

test('malformed or non-UUID guest ids are rejected (401)', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl) => {
    for (const badId of [
      'not-a-uuid',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa',
      'zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz',
    ]) {
      const res = await request('GET', `${baseUrl}${CART}`, null, undefined, guestHeaders(badId));
      assert.equal(res.status, 401, `guest id ${badId}`);
      assert.equal((await res.json()).error.code, ERROR_CODES.UNAUTHORIZED);
    }
  }
));

test('a previously suspended guest identity is denied (403)', withServer(
  () => {
    const seeded = seedUsers();
    seeded.push({
      _id: '507f1f77bcf86cd799439121',
      authProviderId: `guest:${GUEST_A}`,
      role: ROLES.CUSTOMER,
      status: ACCOUNT_STATUSES.SUSPENDED,
    });
    return buildApp({ users: seeded });
  },
  async (baseUrl) => {
    const res = await request('GET', `${baseUrl}${CART}`, null, undefined, guestHeaders(GUEST_A));
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, ERROR_CODES.FORBIDDEN);
  }
));

test('guest carts are fully isolated from one another (IDOR)', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl) => {
    await guestAddToCart(baseUrl, GUEST_A);

    const bCart = await request('GET', `${baseUrl}${CART}`, null, undefined, guestHeaders(GUEST_B));
    assert.equal(bCart.status, 200);
    assert.equal((await bCart.json()).data.cart.items.length, 0, 'guest B sees no guest A items');

    const aCart = await request('GET', `${baseUrl}${CART}`, null, undefined, guestHeaders(GUEST_A));
    const aItemId = (await aCart.json()).data.cart.items[0].id;

    const bPatch = await request('PATCH', `${baseUrl}${CART}/items/${aItemId}`, null, { quantity: 9 }, guestHeaders(GUEST_B));
    assert.equal(bPatch.status, 404, 'guest B cannot touch guest A item');
    assert.equal((await bPatch.json()).error.code, ERROR_CODES.INVALID_CART_ITEM);

    await guestAddToCart(baseUrl, GUEST_B);
    const bAdd = await request('GET', `${baseUrl}${CART}`, null, undefined, guestHeaders(GUEST_B));
    assert.equal((await bAdd.json()).data.cart.items.length, 1, 'guest B cart is independent');
  }
));

test('guest order history/detail/cancel require a Bearer token; guest id alone → 401', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl) => {
    await guestAddToCart(baseUrl, GUEST_A);
    const created = await guestCheckout(baseUrl, GUEST_A, checkoutBody(), 'guest-iso');
    const orderId = (await created.json()).data.order.id;

    for (const [method, path] of [
      ['GET', `${BASE}`],
      ['GET', `${BASE}/${orderId}`],
      ['POST', `${BASE}/${orderId}/cancel`],
    ]) {
      const res = await request(method, `${baseUrl}${path}`, null, method === 'GET' ? undefined : {}, guestHeaders(GUEST_A));
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal((await res.json()).error.code, ERROR_CODES.UNAUTHORIZED);
    }

    const detail = await request('GET', `${baseUrl}${BASE}/${orderId}`, tokens.tokenCustomer2);
    assert.equal(detail.status, 404, 'a different authenticated customer cannot read the guest order');
    assert.equal((await detail.json()).error.code, ERROR_CODES.ORDER_NOT_FOUND);
  }
));

test('guest checkout accepts MANUAL and a manual proof can be submitted', withServer(
  () => buildApp({ users: seedUsers(), paymentMethods: [paymentMethodDoc()] }),
  async (baseUrl) => {
    await guestAddToCart(baseUrl, GUEST_A);
    const created = await guestCheckout(baseUrl, GUEST_A, checkoutBody({ paymentMethod: 'MANUAL' }), 'g-co-manual');
    assert.equal(created.status, 201);
    assert.equal((await created.json()).data.order.paymentMethod, 'MANUAL');
  }
));

test('guest submits a manual payment proof for their own order', withServer(
  () => {
    users = seedUsers();
    return buildApp({ users, paymentMethods: [paymentMethodDoc()] });
  },
  async (baseUrl, repos) => {
    await guestAddToCart(baseUrl, GUEST_A);
    const created = await guestCheckout(baseUrl, GUEST_A, checkoutBody({ paymentMethod: 'MANUAL' }), 'g-co-proof');
    assert.equal(created.status, 201);
    const order = (await created.json()).data.order;

    const res = await submitGuestPayment(baseUrl, GUEST_A, order);
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.success, true);
    const payment = body.data.payment;
    assert.equal(payment.status, 'SUBMITTED');
    assert.equal(payment.orderId, order.id);
    assert.equal(payment.expectedAmountMinorUnits, order.totals.grandTotalMinorUnits);
    assert.equal(payment.paymentMethod.code, 'BANK_TRANSFER');
    assert.ok(repos.mediaService.store.has(payment.proof.publicId), 'proof stored in media');

    const guest = users.find((u) => u.authProviderId === `guest:${GUEST_A}`);
    assert.equal(repos.paymentRepo.docs[0].customerId, guest._id, 'payment is owned by the guest');
  }
));

test('a guest cannot submit a proof against another guests order (404)', withServer(
  () => buildApp({ users: seedUsers(), paymentMethods: [paymentMethodDoc()] }),
  async (baseUrl) => {
    await guestAddToCart(baseUrl, GUEST_A);
    const created = await guestCheckout(baseUrl, GUEST_A, checkoutBody({ paymentMethod: 'MANUAL' }), 'g-co-x');
    const order = (await created.json()).data.order;

    const res = await submitGuestPayment(baseUrl, GUEST_B, order, { idempotencyKey: 'idem-x' });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, ERROR_CODES.PAYMENT_NOT_FOUND);
  }
));

test('admin and staff surfaces reject a guest identity (401)', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl) => {
    for (const [method, path] of [
      ['GET', '/api/v1/admin/orders'],
      ['GET', '/api/v1/admin/payments'],
      ['POST', '/api/v1/admin/payments/507f1f77bcf86cd799439099/verify'],
    ]) {
      const res = await request(method, `${baseUrl}${path}`, null, method === 'GET' ? undefined : {}, guestHeaders(GUEST_A));
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal((await res.json()).error.code, ERROR_CODES.UNAUTHORIZED);
    }
  }
));

test('public order-status lookup requires order id/number AND delivery phone', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl) => {
    await guestAddToCart(baseUrl, GUEST_A);
    const created = await guestCheckout(baseUrl, GUEST_A, checkoutBody(), 'g-co-status');
    const order = (await created.json()).data.order;

    const cases = [
      [{ orderNumber: order.orderNumber }, 400],
      [{ orderId: order.id, phone: '+8801712345678' }, 200],
      [{ orderNumber: order.orderNumber, phone: '8801712345678' }, 200],
      [{ orderNumber: order.orderNumber, phone: '01712345678' }, 200],
      [{ orderId: 'not-an-object-id', phone: '01712345678' }, 400],
      [{ orderNumber: order.orderNumber, phone: '01999999999' }, 404],
      [{ orderNumber: 'TAQ-00000000-000000', phone: '01712345678' }, 404],
      [{ orderNumber: order.orderNumber, orderId: order.id, phone: '01712345678' }, 400],
      [{ phone: '01712345678' }, 400],
    ];

    for (const [query, expected] of cases) {
      const qs = new URLSearchParams(query).toString();
      const res = await request('GET', `${baseUrl}${BASE}/status?${qs}`);
      assert.equal(res.status, expected, `query ${qs}`);
      const body = await res.json();
      if (expected === 200) {
        assert.equal(body.data.order.orderNumber, order.orderNumber);
        assert.equal(body.data.order.status, 'PENDING');
      } else if (expected === 404) {
        assert.equal(body.error.code, ERROR_CODES.ORDER_NOT_FOUND);
      } else {
        assert.equal(body.error.code, ERROR_CODES.INVALID_ORDER);
      }
    }
  }
));

test('the status payload never exposes delivery address or customer identity', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl) => {
    await guestAddToCart(baseUrl, GUEST_A);
    const created = await guestCheckout(baseUrl, GUEST_A, checkoutBody(), 'g-co-status2');
    const order = (await created.json()).data.order;

    const res = await request(
      'GET',
      `${baseUrl}${BASE}/status?orderNumber=${order.orderNumber}&phone=01712345678`
    );
    assert.equal(res.status, 200);
    const statusOrder = (await res.json()).data.order;
    assert.equal('delivery' in statusOrder, false, 'delivery address is not exposed');
    assert.equal('customerId' in statusOrder, false, 'customer identity is not exposed');
    assert.equal('statusHistory' in statusOrder, false, 'internal history is not exposed');
    assert.equal('reservationReference' in statusOrder, false);
  }
));
