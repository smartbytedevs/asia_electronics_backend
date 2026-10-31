'use strict';

/**
 * Test-only in-memory stub for the analytics repository (Phase 13).
 *
 * Mirrors the real repository semantics: DB-level range filtering on the event
 * timestamps that define each metric and, for payments/refunds, the status
 * restriction (VERIFIED / PROCESSED) baked into the query.
 */

function between(value, from, to) {
  if (value === null || value === undefined) return false;
  const time = new Date(value).getTime();
  return time >= new Date(from).getTime() && time <= new Date(to).getTime();
}

function createMemoryAnalyticsRepository({
  orders = [],
  payments = [],
  refunds = [],
  expenses = [],
  products = [],
  variants = [],
} = {}) {
  return {
    orders,
    payments,
    refunds,
    expenses,
    products,
    variants,
    findOrders: async (from, to) => orders.filter((o) => between(o.createdAt, from, to)),
    findOrdersByIds: async (ids) => orders.filter((o) => ids.includes(String(o._id))),
    findVerifiedPayments: async (from, to) =>
      payments.filter(
        (p) => p.status === 'VERIFIED' && between(p.verifiedAt || p.createdAt, from, to)
      ),
    findProcessedRefunds: async (from, to) =>
      refunds.filter(
        (r) => r.status === 'PROCESSED' && between(r.processedAt || r.createdAt, from, to)
      ),
    findExpenses: async (from, to) => expenses.filter((e) => between(e.expenseDate, from, to)),
    findProductCosts: async (ids) => products.filter((p) => ids.includes(String(p._id))),
    findVariantCosts: async (ids) => variants.filter((v) => ids.includes(String(v._id))),
  };
}

module.exports = { createMemoryAnalyticsRepository };
