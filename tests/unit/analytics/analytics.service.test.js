'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { AnalyticsService } = require('../../../src/modules/analytics/analytics.service');
const { createMemoryAnalyticsRepository } = require('../../helpers/analytics-stubs');

const DAY_MS = 24 * 60 * 60 * 1000;

function at(iso) {
  return new Date(iso);
}

function daysAgo(n) {
  return new Date(Date.now() - n * DAY_MS);
}

function payment(overrides = {}) {
  return {
    _id: 'p',
    orderId: 'o',
    status: 'VERIFIED',
    submittedAmountMinorUnits: 0,
    verifiedAt: null,
    createdAt: at('2026-08-02T00:00:00.000Z'),
    ...overrides,
  };
}

function refund(overrides = {}) {
  return {
    _id: 'r',
    status: 'PROCESSED',
    amount: 0,
    processedAt: null,
    createdAt: at('2026-08-03T00:00:00.000Z'),
    ...overrides,
  };
}

function expense(overrides = {}) {
  return {
    _id: 'e',
    amountMinorUnits: 0,
    expenseDate: at('2026-08-02T00:00:00.000Z'),
    ...overrides,
  };
}

function order(overrides = {}) {
  return {
    _id: 'o',
    status: 'CONFIRMED',
    createdAt: at('2026-08-02T00:00:00.000Z'),
    ...overrides,
  };
}

function codOrder(overrides = {}) {
  return {
    _id: 'o-cod',
    status: 'DELIVERED',
    paymentMethod: 'COD',
    totals: { grandTotalMinorUnits: 80000 },
    statusHistory: [{ status: 'DELIVERED', at: at('2026-08-03T00:00:00.000Z'), by: 'admin', note: null }],
    createdAt: at('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

function orderItem(overrides = {}) {
  return {
    productId: 'p1',
    productVariantId: 'v1',
    quantity: 1,
    ...overrides,
  };
}

function productDoc(overrides = {}) {
  return {
    _id: 'p1',
    purchasePrice: 30000,
    ...overrides,
  };
}

function variantDoc(overrides = {}) {
  return {
    _id: 'v1',
    purchasePriceOverride: null,
    ...overrides,
  };
}

function createHarness(seed = {}) {
  const repo = createMemoryAnalyticsRepository(seed);
  const service = new AnalyticsService({ analyticsRepository: repo });
  return { service, repo };
}

test('summary counts only VERIFIED payments as sales', async () => {
  const { service } = createHarness({
    payments: [
      payment({ submittedAmountMinorUnits: 100000, verifiedAt: at('2026-08-02T00:00:00.000Z') }),
      payment({ submittedAmountMinorUnits: 50000, verifiedAt: at('2026-08-04T00:00:00.000Z') }),
      payment({ status: 'SUBMITTED', submittedAmountMinorUnits: 90000, verifiedAt: null }),
      payment({ status: 'REJECTED', submittedAmountMinorUnits: 70000, verifiedAt: at('2026-08-03T00:00:00.000Z') }),
      payment({ status: 'UNPAID', submittedAmountMinorUnits: 1, verifiedAt: null }),
    ],
  });
  const summary = await service.getSummary({ dateFrom: '2026-08-01', dateTo: '2026-08-05' });
  assert.equal(summary.totalSalesMinorUnits, 150000);
});

test('summary deducts only PROCESSED refunds', async () => {
  const { service } = createHarness({
    refunds: [
      refund({ amount: 20000, processedAt: at('2026-08-03T00:00:00.000Z') }),
      refund({ status: 'PENDING', amount: 30000 }),
      refund({ status: 'VOIDED', amount: 40000 }),
    ],
  });
  const summary = await service.getSummary({ dateFrom: '2026-08-01', dateTo: '2026-08-05' });
  assert.equal(summary.totalRefundsMinorUnits, 20000);
});

test('summary nets sales minus refunds minus expenses and counts orders by status', async () => {
  const { service } = createHarness({
    orders: [
      order({ status: 'CONFIRMED', createdAt: at('2026-08-02T00:00:00.000Z') }),
      order({ status: 'PENDING', createdAt: at('2026-08-04T00:00:00.000Z') }),
      order({ status: 'PENDING', createdAt: at('2026-08-06T00:00:00.000Z') }),
    ],
    payments: [payment({ submittedAmountMinorUnits: 100000, verifiedAt: at('2026-08-02T00:00:00.000Z') })],
    refunds: [refund({ amount: 20000, processedAt: at('2026-08-03T00:00:00.000Z') })],
    expenses: [
      expense({ amountMinorUnits: 10000, expenseDate: at('2026-08-02T00:00:00.000Z') }),
      expense({ amountMinorUnits: 5000, expenseDate: at('2026-08-06T00:00:00.000Z') }),
    ],
  });
  const summary = await service.getSummary({ dateFrom: '2026-08-01', dateTo: '2026-08-05' });

  assert.deepEqual(summary.range, {
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-05T00:00:00.000Z',
  });
  assert.equal(summary.totalOrders, 2, 'order outside the range is ignored');
  assert.equal(summary.totalSalesMinorUnits, 100000);
  assert.equal(summary.totalRefundsMinorUnits, 20000);
  assert.equal(summary.totalExpensesMinorUnits, 10000, 'expense outside the range is ignored');
  assert.equal(summary.netMinorUnits, 70000);
  assert.deepEqual(summary.orderStatusCounts, { CONFIRMED: 1, PENDING: 1 });
});

test('summary with no params uses the trailing default window', async () => {
  const { service } = createHarness({
    payments: [
      payment({ submittedAmountMinorUnits: 60000, verifiedAt: daysAgo(5) }),
      payment({ submittedAmountMinorUnits: 999999, verifiedAt: daysAgo(45) }),
    ],
  });
  const summary = await service.getSummary({});
  assert.equal(summary.totalSalesMinorUnits, 60000, 'events outside the default window are ignored');
});

test('daily returns a zero-filled series covering every day in the range', async () => {
  const { service } = createHarness({
    orders: [order({ status: 'CONFIRMED', createdAt: at('2026-08-02T00:00:00.000Z') })],
    payments: [payment({ submittedAmountMinorUnits: 100000, verifiedAt: at('2026-08-02T00:00:00.000Z') })],
    refunds: [refund({ amount: 20000, processedAt: at('2026-08-03T00:00:00.000Z') })],
    expenses: [expense({ amountMinorUnits: 10000, expenseDate: at('2026-08-02T00:00:00.000Z') })],
  });

  const { daily, range } = await service.getDaily({ dateFrom: '2026-08-01', dateTo: '2026-08-03' });

  assert.deepEqual(
    daily.map((d) => d.date),
    ['2026-08-01', '2026-08-02', '2026-08-03']
  );
  assert.deepEqual(daily[0], { date: '2026-08-01', orders: 0, sales: 0, cogs: 0, refunds: 0, expenses: 0, net: 0 });
  assert.deepEqual(daily[1], { date: '2026-08-02', orders: 1, sales: 100000, cogs: 0, refunds: 0, expenses: 10000, net: 90000 });
  assert.deepEqual(daily[2], { date: '2026-08-03', orders: 0, sales: 0, cogs: 0, refunds: 20000, expenses: 0, net: -20000 });
  assert.equal(range.from, '2026-08-01T00:00:00.000Z');
  assert.equal(range.to, '2026-08-03T00:00:00.000Z');
});

test('daily buckets sales on the verifiedAt capture date, not createdAt', async () => {
  const { service } = createHarness({
    payments: [payment({ submittedAmountMinorUnits: 70000, createdAt: at('2026-08-01T00:00:00.000Z'), verifiedAt: at('2026-08-03T00:00:00.000Z') })],
  });
  const { daily } = await service.getDaily({ dateFrom: '2026-08-01', dateTo: '2026-08-03' });
  assert.equal(daily[2].sales, 70000, 'sale lands on the verified day');
  assert.equal(daily[0].sales, 0);
});

test('daily buckets refunds on the processedAt payout date', async () => {
  const { service } = createHarness({
    refunds: [refund({ amount: 15000, createdAt: at('2026-08-01T00:00:00.000Z'), processedAt: at('2026-08-02T00:00:00.000Z') })],
  });
  const { daily } = await service.getDaily({ dateFrom: '2026-08-01', dateTo: '2026-08-02' });
  assert.equal(daily[1].refunds, 15000);
});

test('daily buckets expenses on the expenseDate', async () => {
  const { service } = createHarness({
    expenses: [expense({ amountMinorUnits: 8000, expenseDate: at('2026-08-01T00:00:00.000Z') })],
  });
  const { daily } = await service.getDaily({ dateFrom: '2026-08-01', dateTo: '2026-08-02' });
  assert.equal(daily[0].expenses, 8000);
});

test('a delivered COD order appears in sales', async () => {
  const { service } = createHarness({
    orders: [
      codOrder({ status: 'DELIVERED', totals: { grandTotalMinorUnits: 80000 } }),
      codOrder({ _id: 'o-completed', status: 'COMPLETED', totals: { grandTotalMinorUnits: 25000 } }),
    ],
  });
  const summary = await service.getSummary({ dateFrom: '2026-08-01', dateTo: '2026-08-05' });
  assert.equal(summary.totalSalesMinorUnits, 105000, 'DELIVERED and COMPLETED COD orders both count');
});

test('an undelivered COD order does not appear in sales', async () => {
  const { service } = createHarness({
    orders: [
      codOrder({ _id: 'o-1', status: 'PENDING' }),
      codOrder({ _id: 'o-2', status: 'CONFIRMED' }),
      codOrder({ _id: 'o-3', status: 'PROCESSING' }),
      codOrder({ _id: 'o-4', status: 'SHIPPED' }),
      codOrder({ _id: 'o-5', status: 'CANCELLED' }),
    ],
  });
  const summary = await service.getSummary({ dateFrom: '2026-08-01', dateTo: '2026-08-05' });
  assert.equal(summary.totalSalesMinorUnits, 0);
});

test('a verified manual payment appears in sales', async () => {
  const { service } = createHarness({
    payments: [payment({ status: 'VERIFIED', submittedAmountMinorUnits: 50000, verifiedAt: at('2026-08-02T00:00:00.000Z') })],
  });
  const summary = await service.getSummary({ dateFrom: '2026-08-01', dateTo: '2026-08-05' });
  assert.equal(summary.totalSalesMinorUnits, 50000);
});

test('an unverified manual payment does not appear in sales', async () => {
  const { service } = createHarness({
    payments: [
      payment({ status: 'SUBMITTED', submittedAmountMinorUnits: 60000, verifiedAt: null }),
      payment({ status: 'REJECTED', submittedAmountMinorUnits: 70000, verifiedAt: null }),
    ],
  });
  const summary = await service.getSummary({ dateFrom: '2026-08-01', dateTo: '2026-08-05' });
  assert.equal(summary.totalSalesMinorUnits, 0);
});

test('sales never double-counts revenue', async () => {
  const { service } = createHarness({
    orders: [
      order({
        _id: 'o-manual-delivered',
        status: 'DELIVERED',
        paymentMethod: 'BKASH',
        totals: { grandTotalMinorUnits: 50000 },
        statusHistory: [{ status: 'DELIVERED', at: at('2026-08-03T00:00:00.000Z'), by: 'courier', note: null }],
        createdAt: at('2026-08-01T00:00:00.000Z'),
      }),
      codOrder({ status: 'DELIVERED', totals: { grandTotalMinorUnits: 80000 } }),
    ],
    payments: [
      payment({ submittedAmountMinorUnits: 50000, verifiedAt: at('2026-08-02T00:00:00.000Z') }),
    ],
  });
  const summary = await service.getSummary({ dateFrom: '2026-08-01', dateTo: '2026-08-05' });
  assert.equal(summary.totalSalesMinorUnits, 130000, 'delivered manual order counted once via payment + COD once via order');
});

test('refunds and expenses still reduce net after COD revenue is recognized', async () => {
  const { service } = createHarness({
    orders: [codOrder({ status: 'DELIVERED', totals: { grandTotalMinorUnits: 100000 } })],
    payments: [payment({ submittedAmountMinorUnits: 50000, verifiedAt: at('2026-08-02T00:00:00.000Z') })],
    refunds: [refund({ amount: 20000, processedAt: at('2026-08-04T00:00:00.000Z') })],
    expenses: [expense({ amountMinorUnits: 10000, expenseDate: at('2026-08-02T00:00:00.000Z') })],
  });
  const summary = await service.getSummary({ dateFrom: '2026-08-01', dateTo: '2026-08-05' });
  assert.equal(summary.totalSalesMinorUnits, 150000);
  assert.equal(summary.totalCogsMinorUnits, 0, 'these orders carry no items with cost data');
  assert.equal(summary.grossProfitMinorUnits, 150000);
  assert.equal(summary.totalRefundsMinorUnits, 20000);
  assert.equal(summary.totalExpensesMinorUnits, 10000);
  assert.equal(summary.netMinorUnits, 120000);
});

test('daily buckets COD sales on the DELIVERED transition date, not createdAt', async () => {
  const { service } = createHarness({
    orders: [
      codOrder({
        status: 'DELIVERED',
        totals: { grandTotalMinorUnits: 80000 },
        createdAt: at('2026-08-01T00:00:00.000Z'),
        statusHistory: [{ status: 'DELIVERED', at: at('2026-08-03T00:00:00.000Z'), by: 'courier', note: null }],
      }),
    ],
  });
  const { daily } = await service.getDaily({ dateFrom: '2026-08-01', dateTo: '2026-08-03' });
  assert.equal(daily[2].sales, 80000, 'COD sale lands on the delivered day');
  assert.equal(daily[0].sales, 0);
});

test('COGS for a delivered COD order uses the product purchase price and reduces net', async () => {
  const { service } = createHarness({
    orders: [
      codOrder({
        totals: { grandTotalMinorUnits: 100000 },
        items: [
          orderItem({ productId: 'p1', productVariantId: 'v1', quantity: 2 }),
          orderItem({ productId: 'p1', productVariantId: 'v2', quantity: 1 }),
        ],
      }),
    ],
    products: [productDoc({ _id: 'p1', purchasePrice: 30000 })],
    refunds: [refund({ amount: 20000, processedAt: at('2026-08-04T00:00:00.000Z') })],
    expenses: [expense({ amountMinorUnits: 10000, expenseDate: at('2026-08-02T00:00:00.000Z') })],
  });
  const summary = await service.getSummary({ dateFrom: '2026-08-01', dateTo: '2026-08-05' });
  assert.equal(summary.totalSalesMinorUnits, 100000, 'Total Sales is unchanged by COGS');
  assert.equal(summary.totalCogsMinorUnits, 90000, '2 x 30000 + 1 x 30000');
  assert.equal(summary.grossProfitMinorUnits, 10000);
  assert.equal(summary.totalRefundsMinorUnits, 20000);
  assert.equal(summary.totalExpensesMinorUnits, 10000);
  assert.equal(summary.netMinorUnits, -20000, 'grossProfit - refunds - expenses');
});

test('variant purchasePriceOverride wins over the product purchase price', async () => {
  const { service } = createHarness({
    orders: [
      codOrder({
        totals: { grandTotalMinorUnits: 100000 },
        items: [orderItem({ quantity: 1 })],
      }),
    ],
    products: [productDoc({ _id: 'p1', purchasePrice: 30000 })],
    variants: [variantDoc({ _id: 'v1', purchasePriceOverride: 15000 })],
  });
  const summary = await service.getSummary({ dateFrom: '2026-08-01', dateTo: '2026-08-05' });
  assert.equal(summary.totalCogsMinorUnits, 15000, 'variant override beats the product default');
  assert.equal(summary.grossProfitMinorUnits, 85000);
});

test('simple-product item without a variant falls back to the product purchase price', async () => {
  const { service } = createHarness({
    orders: [
      codOrder({
        totals: { grandTotalMinorUnits: 180000 },
        items: [orderItem({ productId: 'p1', productVariantId: null, quantity: 3 })],
      }),
    ],
    products: [productDoc({ _id: 'p1', purchasePrice: 25000 })],
  });
  const summary = await service.getSummary({ dateFrom: '2026-08-01', dateTo: '2026-08-05' });

  assert.equal(summary.totalCogsMinorUnits, 75000, '3 x 25000 product cost');
  assert.equal(summary.grossProfitMinorUnits, 105000);
});

test('COGS is only computed for recognized revenue', async () => {
  const { service } = createHarness({
    orders: [
      codOrder({
        _id: 'o-pending',
        status: 'PENDING',
        totals: { grandTotalMinorUnits: 80000 },
        items: [orderItem({ quantity: 1 })],
      }),
      codOrder({
        _id: 'o-delivered',
        totals: { grandTotalMinorUnits: 100000 },
        items: [orderItem({ quantity: 2 })],
      }),
    ],
    payments: [
      payment({
        _id: 'p-submitted',
        orderId: 'o-manual',
        status: 'SUBMITTED',
        submittedAmountMinorUnits: 50000,
        verifiedAt: null,
      }),
    ],
    products: [productDoc({ _id: 'p1', purchasePrice: 30000 })],
  });
  const summary = await service.getSummary({ dateFrom: '2026-08-01', dateTo: '2026-08-05' });
  assert.equal(summary.totalSalesMinorUnits, 100000, 'only the delivered COD order is revenue');
  assert.equal(summary.totalCogsMinorUnits, 60000, 'no COGS for undelivered COD or unverified manual');
});

test('a verified manual payment counts COGS of its order even when created outside the range', async () => {
  const { service } = createHarness({
    orders: [
      {
        _id: 'o-manual',
        paymentMethod: 'BKASH',
        status: 'DELIVERED',
        createdAt: at('2026-07-25T00:00:00.000Z'),
        totals: { grandTotalMinorUnits: 50000 },
        items: [orderItem({ quantity: 1 })],
      },
    ],
    payments: [
      payment({
        orderId: 'o-manual',
        submittedAmountMinorUnits: 50000,
        verifiedAt: at('2026-08-03T00:00:00.000Z'),
      }),
    ],
    products: [productDoc({ _id: 'p1', purchasePrice: 20000 })],
  });
  const summary = await service.getSummary({ dateFrom: '2026-08-01', dateTo: '2026-08-05' });
  assert.equal(summary.totalOrders, 0, 'order created outside the range is not an in-range order');
  assert.equal(summary.totalSalesMinorUnits, 50000, 'the verified payment is recognized revenue');
  assert.equal(summary.totalCogsMinorUnits, 20000, 'its items are fetched by id for COGS');
  assert.equal(summary.grossProfitMinorUnits, 30000);
});

test('missing purchase price contributes zero COGS without error', async () => {
  const { service } = createHarness({
    orders: [
      codOrder({
        totals: { grandTotalMinorUnits: 100000 },
        items: [orderItem({ quantity: 1 })],
      }),
    ],
    refunds: [refund({ amount: 20000, processedAt: at('2026-08-04T00:00:00.000Z') })],
    expenses: [expense({ amountMinorUnits: 10000, expenseDate: at('2026-08-02T00:00:00.000Z') })],
  });
  const summary = await service.getSummary({ dateFrom: '2026-08-01', dateTo: '2026-08-05' });
  assert.equal(summary.totalCogsMinorUnits, 0, 'no catalog cost to attribute');
  assert.equal(summary.grossProfitMinorUnits, 100000);
  assert.equal(summary.netMinorUnits, 70000);
});

test('daily buckets COGS on the same day as the revenue it offsets', async () => {
  const { service } = createHarness({
    orders: [
      codOrder({
        _id: 'o-cod',
        totals: { grandTotalMinorUnits: 100000 },
        items: [orderItem({ productId: 'p1', productVariantId: 'v1', quantity: 1 })],
        statusHistory: [{ status: 'DELIVERED', at: at('2026-08-03T00:00:00.000Z'), by: 'admin', note: null }],
        createdAt: at('2026-08-01T00:00:00.000Z'),
      }),
      {
        _id: 'o-manual',
        paymentMethod: 'BKASH',
        status: 'CONFIRMED',
        createdAt: at('2026-07-25T00:00:00.000Z'),
        totals: { grandTotalMinorUnits: 50000 },
        items: [orderItem({ productId: 'p1', productVariantId: 'v2', quantity: 2 })],
      },
    ],
    payments: [
      payment({
        orderId: 'o-manual',
        submittedAmountMinorUnits: 50000,
        verifiedAt: at('2026-08-02T00:00:00.000Z'),
      }),
    ],
    products: [productDoc({ _id: 'p1', purchasePrice: 10000 })],
  });
  const { daily } = await service.getDaily({ dateFrom: '2026-08-01', dateTo: '2026-08-03' });
  assert.equal(daily[1].sales, 50000, 'manual sale on verified day');
  assert.equal(daily[1].cogs, 20000, 'manual COGS lands with its verified sale');
  assert.equal(daily[2].sales, 100000, 'COD sale on delivered day');
  assert.equal(daily[2].cogs, 10000, 'COD COGS lands with its delivered sale');
  assert.equal(daily[2].net, 90000, 'net = sales - cogs (no refunds/expenses here)');
});

test('constructor requires an analytics repository', () => {
  assert.throws(() => new AnalyticsService({}), /analyticsRepository/);
});
