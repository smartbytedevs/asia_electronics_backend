'use strict';

process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createExpenseRouter } = require('../../src/modules/expenses/expense.routes');
const { ExpenseService } = require('../../src/modules/expenses/expense.service');
const { createMemoryExpenseRepository } = require('../../tests/helpers/expense-stubs');
const { createAnalyticsRouter } = require('../../src/modules/analytics/analytics.routes');
const { AnalyticsService } = require('../../src/modules/analytics/analytics.service');
const { createMemoryAnalyticsRepository } = require('../../tests/helpers/analytics-stubs');
const { UserService } = require('../../src/modules/users/user.service');
const { ROLES, ACCOUNT_STATUSES, ERROR_CODES } = require('../../src/constants');
const notFound = require('../../src/middlewares/notFound');
const errorHandler = require('../../src/middlewares/errorHandler');
const { createJwtVerifier } = require('../../src/integrations/auth/jwtVerifier');
const { createKeyPair, signToken } = require('../../tests/helpers/jwt-fixtures');

const ISSUER = 'taqwa-frontend';
const AUDIENCE = 'taqwa-backend';
const ALGORITHMS = ['RS256'];

const CUSTOMER_ID = '507f1f77bcf86cd799439301';
const STAFF_ID = '507f1f77bcf86cd799439302';
const ADMIN_ID = '507f1f77bcf86cd799439303';
const EXPENSE_ID = '507f1f77bcf86cd799439304';

function at(iso) {
  return new Date(iso);
}

function userDoc(overrides = {}) {
  const authProviderId = overrides.authProviderId || 'auth-customer-1';
  const ids = {
    'auth-customer-1': CUSTOMER_ID,
    'auth-staff-1': STAFF_ID,
    'auth-admin-1': ADMIN_ID,
  };
  return {
    _id: ids[authProviderId] || authProviderId,
    authProviderId,
    email: 'amina@example.com',
    displayName: 'Amina Rahman',
    phone: '+8801712345678',
    role: ROLES.CUSTOMER,
    status: ACCOUNT_STATUSES.ACTIVE,
    ...overrides,
  };
}

function createStubUserRepository(users) {
  return {
    findByAuthProviderId: async (authProviderId) =>
      users.find((u) => u.authProviderId === authProviderId) || null,
    create: async (data) => {
      const created = { _id: `generated-${data.authProviderId}`, ...data };
      users.push(created);
      return created;
    },
  };
}

function seedUsers() {
  return [
    userDoc(),
    userDoc({
      authProviderId: 'auth-staff-1',
      email: 'staff@example.com',
      displayName: 'Staff Person',
      role: ROLES.STAFF,
    }),
    userDoc({
      authProviderId: 'auth-admin-1',
      email: 'admin@example.com',
      displayName: 'Admin Person',
      role: ROLES.ADMIN,
    }),
  ];
}

function buildApp({
  users,
  expenses = [],
  orders = [],
  payments = [],
  refunds = [],
  products = [],
  variants = [],
  verifier: appVerifier,
} = {}) {
  const effectiveVerifier = appVerifier || verifier;
  const userService = new UserService({
    repository: createStubUserRepository(users),
    autoProvisionCustomers: true,
  });

  const expenseRepo = createMemoryExpenseRepository(expenses);
  const expenseService = new ExpenseService({ expenseRepository: expenseRepo });

  const analyticsRepo = createMemoryAnalyticsRepository({
    orders,
    payments,
    refunds,
    expenses: expenseRepo.docs,
    products,
    variants,
  });
  const analyticsService = new AnalyticsService({ analyticsRepository: analyticsRepo });

  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/admin/expenses',
    createExpenseRouter({ expenseService, userService, verifier: effectiveVerifier })
  );
  app.use(
    '/api/v1/admin/analytics',
    createAnalyticsRouter({ analyticsService, userService, verifier: effectiveVerifier })
  );
  app.use(notFound);
  app.use(errorHandler);

  return { app, repos: { expenseRepo, analyticsRepo } };
}

function withServer(build, fn) {
  return async () => {
    const { app, repos } = build();
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    try {
      await fn(`http://127.0.0.1:${port}`, repos);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

function request(method, url, token, body) {
  return fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

let verifier;
let tokenCustomer;
let tokenStaff;
let tokenAdmin;
let tokenAdminClaimSpoof;

before(async () => {
  const { privateKey, publicJwk } = await createKeyPair();
  verifier = createJwtVerifier({
    keys: [publicJwk],
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ALGORITHMS,
  });

  tokenCustomer = await signToken({
    privateKey,
    subject: 'auth-customer-1',
    claims: { email: 'amina@example.com', name: 'Amina Rahman' },
  });
  tokenStaff = await signToken({
    privateKey,
    subject: 'auth-staff-1',
    claims: { email: 'staff@example.com', name: 'Staff Person' },
  });
  tokenAdmin = await signToken({
    privateKey,
    subject: 'auth-admin-1',
    claims: { email: 'admin@example.com', name: 'Admin Person' },
  });
  tokenAdminClaimSpoof = await signToken({
    privateKey,
    subject: 'auth-customer-1',
    claims: { role: 'ADMIN', email: 'amina@example.com', name: 'Amina Rahman' },
  });
});

test('expenses: ADMIN only — 401 unauthenticated, 403 for staff/customer/spoofed-role', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl) => {
    const base = `${baseUrl}/api/v1/admin/expenses`;
    const payload = { amountMinorUnits: 50000, description: 'Rent' };

    const anon = await request('POST', base, null, payload);
    assert.equal(anon.status, 401);

    for (const token of [tokenCustomer, tokenStaff, tokenAdminClaimSpoof]) {
      const res = await request('POST', base, token, payload);
      assert.equal(res.status, 403);
      assert.equal((await res.json()).error.code, ERROR_CODES.FORBIDDEN);
    }

    const listAnon = await request('GET', base, null);
    assert.equal(listAnon.status, 401);
    const listStaff = await request('GET', base, tokenStaff);
    assert.equal(listStaff.status, 403);
  }
));

test('expenses: admin creates an expense with identity from the token only', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl, { expenseRepo }) => {
    const res = await request(
      'POST',
      `${baseUrl}/api/v1/admin/expenses`,
      tokenAdmin,
      { amountMinorUnits: 50000, description: 'August shop rent', category: 'Rent', expenseDate: '2026-08-01' }
    );
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.expense.amountMinorUnits, 50000);
    assert.equal(body.data.expense.category, 'Rent');
    assert.equal(body.data.expense.description, 'August shop rent');
    assert.equal(body.data.expense.expenseDate, '2026-08-01T00:00:00.000Z');
    assert.equal(body.data.expense.createdBy.id, ADMIN_ID);

    const doc = expenseRepo.docs[0];
    assert.equal(doc.createdBy, ADMIN_ID, 'identity always from the token, never the body');
  }
));

test('expenses: admin create rejects spoofed identity/immutable/operator keys (400, nothing persisted)', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl, { expenseRepo }) => {
    const res = await request(
      'POST',
      `${baseUrl}/api/v1/admin/expenses`,
      tokenAdmin,
      { amountMinorUnits: 50000, description: 'Rent', createdBy: 'attacker', status: 'VERIFIED', $set: { amountMinorUnits: 1 } }
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, ERROR_CODES.INVALID_EXPENSE);
    assert.equal(expenseRepo.docs.length, 0);
  }
));

test('expenses: admin create rejects invalid bodies (400 INVALID_EXPENSE)', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl) => {
    const base = `${baseUrl}/api/v1/admin/expenses`;
    for (const payload of [
      {},
      { amountMinorUnits: 0, description: 'Rent' },
      { amountMinorUnits: 5000.5, description: 'Rent' },
      { amountMinorUnits: '5000', description: 'Rent' },
      { amountMinorUnits: 50000 },
      { amountMinorUnits: 50000, description: '   ' },
      { amountMinorUnits: 50000, description: 'Rent', expenseDate: 'banana' },
      { amountMinorUnits: 50000, description: 'Rent', bogus: true },
    ]) {
      const res = await request('POST', base, tokenAdmin, payload);
      assert.equal(res.status, 400, JSON.stringify(payload));
      assert.equal((await res.json()).error.code, ERROR_CODES.INVALID_EXPENSE);
    }
  }
));

test('expenses: list/get with date range and category filters, 404 for unknown', withServer(
  () =>
    buildApp({
      users: seedUsers(),
      expenses: [
        { _id: EXPENSE_ID, amountMinorUnits: 50000, category: 'Rent', description: 'August rent', expenseDate: at('2026-08-02T00:00:00.000Z'), createdBy: ADMIN_ID, createdAt: at('2026-08-02T10:00:00.000Z'), updatedAt: at('2026-08-02T10:00:00.000Z') },
        { _id: '507f1f77bcf86cd799439305', amountMinorUnits: 12000, category: 'Utilities', description: 'Electricity', expenseDate: at('2026-08-10T00:00:00.000Z'), createdBy: ADMIN_ID, createdAt: at('2026-08-10T10:00:00.000Z'), updatedAt: at('2026-08-10T10:00:00.000Z') },
      ],
    }),
  async (baseUrl) => {
    const base = `${baseUrl}/api/v1/admin/expenses`;

    const all = await request('GET', base, tokenAdmin);
    assert.equal(all.status, 200);
    assert.equal((await all.json()).data.pagination.total, 2);

    const filtered = await request('GET', `${base}?dateFrom=2026-08-01&dateTo=2026-08-05`, tokenAdmin);
    const filteredBody = await filtered.json();
    assert.equal(filteredBody.data.pagination.total, 1);
    assert.equal(filteredBody.data.expenses[0].id, EXPENSE_ID);

    const byCategory = await request('GET', `${base}?category=Rent`, tokenAdmin);
    assert.equal((await byCategory.json()).data.pagination.total, 1);

    const badRange = await request('GET', `${base}?dateFrom=2026-08-10&dateTo=2026-08-01`, tokenAdmin);
    assert.equal(badRange.status, 400);
    assert.equal((await badRange.json()).error.code, ERROR_CODES.INVALID_EXPENSE);

    const detail = await request('GET', `${base}/${EXPENSE_ID}`, tokenAdmin);
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).data.expense.amountMinorUnits, 50000);

    const missing = await request('GET', `${base}/507f1f77bcf86cd799439999`, tokenAdmin);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, ERROR_CODES.EXPENSE_NOT_FOUND);
  }
));

test('analytics: ADMIN only — 401 unauthenticated, 403 for staff/customer/spoofed-role', withServer(
  () => buildApp({ users: seedUsers() }),
  async (baseUrl) => {
    for (const path of ['/summary', '/daily']) {
      const url = `${baseUrl}/api/v1/admin/analytics${path}`;
      const anon = await request('GET', url, null);
      assert.equal(anon.status, 401, path);
      for (const token of [tokenCustomer, tokenStaff, tokenAdminClaimSpoof]) {
        const res = await request('GET', url, token);
        assert.equal(res.status, 403, `${path} token`);
        assert.equal((await res.json()).error.code, ERROR_CODES.FORBIDDEN);
      }
    }
  }
));

test('analytics: summary nets verified sales, processed refunds, and expenses (API-created included)', withServer(
  () =>
    buildApp({
      users: seedUsers(),
      orders: [
        { _id: 'o1', status: 'CONFIRMED', createdAt: at('2026-08-02T00:00:00.000Z') },
        { _id: 'o2', status: 'PENDING', createdAt: at('2026-08-04T00:00:00.000Z') },
        { _id: 'o3', status: 'PENDING', createdAt: at('2026-08-06T00:00:00.000Z') },
      ],
      payments: [
        { _id: 'p1', status: 'VERIFIED', submittedAmountMinorUnits: 100000, verifiedAt: at('2026-08-02T00:00:00.000Z'), createdAt: at('2026-08-02T00:00:00.000Z') },
        { _id: 'p2', status: 'SUBMITTED', submittedAmountMinorUnits: 90000, verifiedAt: null, createdAt: at('2026-08-03T00:00:00.000Z') },
      ],
      refunds: [
        { _id: 'r1', status: 'PROCESSED', amount: 20000, processedAt: at('2026-08-03T00:00:00.000Z'), createdAt: at('2026-08-03T00:00:00.000Z') },
        { _id: 'r2', status: 'VOIDED', amount: 40000, processedAt: null, createdAt: at('2026-08-03T00:00:00.000Z') },
      ],
      expenses: [
        { _id: 'e1', amountMinorUnits: 10000, expenseDate: at('2026-08-02T00:00:00.000Z') },
      ],
    }),
  async (baseUrl) => {
    const created = await request(
      'POST',
      `${baseUrl}/api/v1/admin/expenses`,
      tokenAdmin,
      { amountMinorUnits: 5000, description: 'Packaging', expenseDate: '2026-08-04' }
    );
    assert.equal(created.status, 201, 'API-created expense feeds the analytics expense repo');

    const res = await request(
      'GET',
      `${baseUrl}/api/v1/admin/analytics/summary?dateFrom=2026-08-01&dateTo=2026-08-05`,
      tokenAdmin
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.totalOrders, 2, 'order outside range is ignored');
    assert.equal(body.data.totalSalesMinorUnits, 100000, 'SUBMITTED payment is not revenue');
    assert.equal(body.data.totalRefundsMinorUnits, 20000, 'VOIDED refund is not a payout');
    assert.equal(body.data.totalExpensesMinorUnits, 15000, 'seeded + API-created expense');
    assert.equal(body.data.netMinorUnits, 65000);
    assert.deepEqual(body.data.orderStatusCounts, { CONFIRMED: 1, PENDING: 1 });

    const invalid = await request(
      'GET',
      `${baseUrl}/api/v1/admin/analytics/summary?dateFrom=2026-08-10&dateTo=2026-08-01`,
      tokenAdmin
    );
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, ERROR_CODES.INVALID_ANALYTICS_RANGE);
  }
));

test('analytics: daily returns a zero-filled, correctly bucketed series', withServer(
  () =>
    buildApp({
      users: seedUsers(),
      orders: [{ _id: 'o1', status: 'CONFIRMED', createdAt: at('2026-08-02T00:00:00.000Z') }],
      payments: [{ _id: 'p1', status: 'VERIFIED', submittedAmountMinorUnits: 100000, verifiedAt: at('2026-08-02T00:00:00.000Z'), createdAt: at('2026-08-02T00:00:00.000Z') }],
      refunds: [{ _id: 'r1', status: 'PROCESSED', amount: 20000, processedAt: at('2026-08-03T00:00:00.000Z'), createdAt: at('2026-08-03T00:00:00.000Z') }],
      expenses: [{ _id: 'e1', amountMinorUnits: 10000, expenseDate: at('2026-08-02T00:00:00.000Z') }],
    }),
  async (baseUrl) => {
    const res = await request(
      'GET',
      `${baseUrl}/api/v1/admin/analytics/daily?dateFrom=2026-08-01&dateTo=2026-08-03`,
      tokenAdmin
    );
    assert.equal(res.status, 200);
    const { daily } = (await res.json()).data;
    assert.deepEqual(
      daily.map((d) => d.date),
      ['2026-08-01', '2026-08-02', '2026-08-03']
    );
    assert.deepEqual(daily[0], { date: '2026-08-01', orders: 0, sales: 0, cogs: 0, refunds: 0, expenses: 0, net: 0 });
    assert.deepEqual(daily[1], { date: '2026-08-02', orders: 1, sales: 100000, cogs: 0, refunds: 0, expenses: 10000, net: 90000 });
    assert.deepEqual(daily[2], { date: '2026-08-03', orders: 0, sales: 0, cogs: 0, refunds: 20000, expenses: 0, net: -20000 });
  }
));

test('analytics: summary reports COGS and gross profit for recognized revenue only', withServer(
  () =>
    buildApp({
      users: seedUsers(),
      orders: [
        {
          _id: 'o-cod',
          status: 'DELIVERED',
          paymentMethod: 'COD',
          totals: { grandTotalMinorUnits: 100000 },
          createdAt: at('2026-08-02T00:00:00.000Z'),
          statusHistory: [{ status: 'DELIVERED', at: at('2026-08-04T00:00:00.000Z'), by: 'admin', note: null }],
          items: [{ productId: 'p1', productVariantId: 'v1', quantity: 2 }],
        },
        {
          _id: 'o-pending',
          status: 'PENDING',
          paymentMethod: 'COD',
          totals: { grandTotalMinorUnits: 90000 },
          createdAt: at('2026-08-02T00:00:00.000Z'),
          items: [{ productId: 'p1', productVariantId: 'v2', quantity: 1 }],
        },
        {
          _id: 'o-manual',
          status: 'DELIVERED',
          paymentMethod: 'BKASH',
          totals: { grandTotalMinorUnits: 50000 },
          createdAt: at('2026-07-25T00:00:00.000Z'),
          items: [{ productId: 'p1', productVariantId: 'v2', quantity: 1 }],
        },
      ],
      payments: [
        {
          _id: 'p1',
          orderId: 'o-manual',
          status: 'VERIFIED',
          submittedAmountMinorUnits: 50000,
          verifiedAt: at('2026-08-03T00:00:00.000Z'),
          createdAt: at('2026-08-03T00:00:00.000Z'),
        },
      ],
      products: [{ _id: 'p1', purchasePrice: 30000 }],
      variants: [{ _id: 'v1', purchasePriceOverride: 12000 }],
    }),
  async (baseUrl) => {
    const res = await request(
      'GET',
      `${baseUrl}/api/v1/admin/analytics/summary?dateFrom=2026-08-01&dateTo=2026-08-05`,
      tokenAdmin
    );
    assert.equal(res.status, 200);
    const body = (await res.json()).data;
    assert.equal(body.totalOrders, 2, 'the manual order was created outside the range');
    assert.equal(body.totalSalesMinorUnits, 150000, 'COD delivered + VERIFIED manual payment');
    assert.equal(body.totalCogsMinorUnits, 54000, '2 x 12000 (v1 override) + 30000 (v2 product price)');
    assert.equal(body.grossProfitMinorUnits, 96000);
    assert.equal(body.netMinorUnits, 96000, 'no refunds/expenses in this window');
  }
));
