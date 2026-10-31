'use strict';

const { resolveAnalyticsRange } = require('./analytics.validation');
const { ORDER_STATUSES, PAYMENT_METHODS } = require('../orders/order.constants');

/**
 * Analytics business logic (Phase 13). ADMIN-only, read-only: computes the
 * admin dashboard totals and the daily series from the existing financial
 * records via the analytics repository.
 *
 * Metric definitions (see analytics.constants.js):
 *   sales    = VERIFIED manual payments (bucketed on verifiedAt)
 *            + DELIVERED/COMPLETED COD orders (bucketed on the DELIVERED
 *              transition date — COD revenue is recognized on delivery)
 *   cogs     = supplier cost of the goods behind the SAME recognized revenue:
 *              DELIVERED/COMPLETED COD order items and the items of orders
 *              behind VERIFIED manual payments. Unit cost = the variant's
 *              purchasePriceOverride when set, else the product's
 *              purchasePrice (missing cost → 0). Bucketed on the same date as
 *              the revenue it offsets.
 *   grossProfit = sales − cogs
 *   refunds  = PROCESSED refunds only   (bucketed on processedAt)
 *   expenses = Expense lines            (bucketed on expenseDate)
 *   net      = grossProfit − refunds − expenses
 *
 * Manual-method orders are counted ONLY through their VERIFIED payment and
 * COD orders ONLY through the order itself, so a revenue event is never
 * double-counted (payments only ever exist for manual methods — the
 * PaymentService eligibility rejects COD).
 *
 * The date range defaults to the trailing DEFAULT_RANGE_DAYS (validation).
 * Dates in the daily series are UTC date keys (`YYYY-MM-DD`).
 */
class AnalyticsService {
  constructor({ analyticsRepository }) {
    if (
      !analyticsRepository ||
      typeof analyticsRepository.findVerifiedPayments !== 'function' ||
      typeof analyticsRepository.findOrdersByIds !== 'function' ||
      typeof analyticsRepository.findProductCosts !== 'function' ||
      typeof analyticsRepository.findVariantCosts !== 'function'
    ) {
      throw new Error('AnalyticsService requires an analyticsRepository');
    }
    this.analyticsRepository = analyticsRepository;
  }

  async collect({ dateFrom, dateTo }) {
    const { start, end } = resolveAnalyticsRange({ dateFrom, dateTo });
    const [orders, payments, refunds, expenses] = await Promise.all([
      this.analyticsRepository.findOrders(start, end),
      this.analyticsRepository.findVerifiedPayments(start, end),
      this.analyticsRepository.findProcessedRefunds(start, end),
      this.analyticsRepository.findExpenses(start, end),
    ]);
    return { start, end, orders, payments, refunds, expenses };
  }

  async getSummary({ dateFrom, dateTo }) {
    const { start, end, orders, payments, refunds, expenses } = await this.collect({
      dateFrom,
      dateTo,
    });
    const sales =
      sumMinorUnits(payments, (p) => p.submittedAmountMinorUnits) +
      sumMinorUnits(orders.filter(isCodDeliveredOrder), codOrderRevenue);
    const { cogsByOrder } = await this.loadRevenueCogs({ orders, payments });
    const cogs = sumMapValues(cogsByOrder);
    const grossProfit = sales - cogs;
    const refunded = sumMinorUnits(refunds, (r) => r.amount);
    const spent = sumMinorUnits(expenses, (e) => e.amountMinorUnits);
    return {
      range: { from: start.toISOString(), to: end.toISOString() },
      totalOrders: orders.length,
      totalSalesMinorUnits: sales,
      totalCogsMinorUnits: cogs,
      grossProfitMinorUnits: grossProfit,
      totalRefundsMinorUnits: refunded,
      totalExpensesMinorUnits: spent,
      netMinorUnits: grossProfit - refunded - spent,
      orderStatusCounts: countByStatus(orders),
    };
  }

  async getDaily({ dateFrom, dateTo }) {
    const { start, end, orders, payments, refunds, expenses } = await this.collect({
      dateFrom,
      dateTo,
    });
    const { codOrders, manualOrders, cogsByOrder } = await this.loadRevenueCogs({
      orders,
      payments,
    });
    const { keys, buckets } = buildDailyBuckets(start, end);

    for (const order of orders) {
      const bucket = buckets[dateKey(order.createdAt)];
      if (bucket) bucket.orders += 1;
    }
    for (const order of codOrders) {
      const bucket = buckets[dateKey(codDeliveredAt(order))];
      if (bucket) {
        bucket.sales += codOrderRevenue(order);
        bucket.cogs += cogsByOrder.get(String(order._id)) || 0;
      }
    }
    // Manual COGS lands on the same day as the verified payment that made the
    // sale recognized, mirroring how manual sales are bucketed.
    const verifiedDateByOrder = new Map(
      payments.map((payment) => [
        String(payment.orderId),
        dateKey(payment.verifiedAt || payment.createdAt),
      ])
    );
    for (const order of manualOrders) {
      const bucket = buckets[verifiedDateByOrder.get(String(order._id))];
      if (bucket) bucket.cogs += cogsByOrder.get(String(order._id)) || 0;
    }
    for (const payment of payments) {
      const bucket = buckets[dateKey(payment.verifiedAt || payment.createdAt)];
      if (bucket) bucket.sales += payment.submittedAmountMinorUnits;
    }
    for (const refund of refunds) {
      const bucket = buckets[dateKey(refund.processedAt || refund.createdAt)];
      if (bucket) bucket.refunds += refund.amount;
    }
    for (const expense of expenses) {
      const bucket = buckets[dateKey(expense.expenseDate)];
      if (bucket) bucket.expenses += expense.amountMinorUnits;
    }

    return {
      range: { from: start.toISOString(), to: end.toISOString() },
      daily: keys.map((key) => {
        const b = buckets[key];
        return {
          date: key,
          orders: b.orders,
          sales: b.sales,
          cogs: b.cogs,
          refunds: b.refunds,
          expenses: b.expenses,
          net: b.sales - b.cogs - b.refunds - b.expenses,
        };
      }),
    };
  }

  /**
   * Loads the orders whose items generated recognized revenue and their COGS:
   *   - COD orders already DELIVERED/COMPLETED (from the in-range `orders`).
   *   - Manual orders behind a VERIFIED payment, fetched by id (they may have
   *     been created before the range start and still be recognized revenue).
   * Returns { codOrders, manualOrders, cogsByOrder } where cogsByOrder maps
   * `String(order._id)` → supplier cost of that order's items.
   */
  async loadRevenueCogs({ orders, payments }) {
    const codOrders = orders.filter(isCodDeliveredOrder);
    const manualOrderIds = distinctStrings(payments.map((payment) => payment.orderId));
    let manualOrders = [];
    if (manualOrderIds.length > 0) {
      manualOrders = await this.analyticsRepository.findOrdersByIds(manualOrderIds);
    }
    const revenueOrders = mergeUniqueById([...codOrders, ...manualOrders]);
    const cogsByOrder = await this.computeCogsByOrder(revenueOrders);
    return { codOrders, manualOrders, cogsByOrder };
  }

  /**
   * COGS per order. Unit cost is the EXISTING catalog purchase price —
   * the variant's purchasePriceOverride when set, otherwise the product's
   * purchasePrice — resolved at query time because order-item snapshots do not
   * record supplier cost (ADR-0015). Items with no cost data (or whose
   * product/variant no longer exists) contribute 0: analytics never invents a
   * cost it cannot prove.
   */
  async computeCogsByOrder(orders) {
    const quantityByVariant = new Map(); // variantId → { productId, quantity }
    const productIds = new Set();
    for (const order of orders) {
      for (const item of order.items || []) {
        if (!item) continue;
        if (item.productId) productIds.add(String(item.productId));
        if (!item.productVariantId) continue;
        const variantKey = String(item.productVariantId);
        const current = quantityByVariant.get(variantKey) || {
          productId: item.productId ? String(item.productId) : null,
          quantity: 0,
        };
        current.quantity += Number(item.quantity) || 0;
        quantityByVariant.set(variantKey, current);
      }
    }

    const cogsByOrder = new Map();
    if (quantityByVariant.size === 0 && productIds.size === 0) {
      for (const order of orders) cogsByOrder.set(String(order._id), 0);
      return cogsByOrder;
    }

    const [variants, products] = await Promise.all([
      this.analyticsRepository.findVariantCosts([...quantityByVariant.keys()]),
      this.analyticsRepository.findProductCosts([...productIds]),
    ]);
    const variantCost = new Map(
      variants.map((variant) => [String(variant._id), variant.purchasePriceOverride])
    );
    const productCost = new Map(
      products.map((product) => [String(product._id), product.purchasePrice])
    );

    const unitCost = (variantKey, productId) => {
      if (variantKey) {
        const override = variantCost.get(variantKey);
        if (typeof override === 'number') return override;
      }
      if (productId) {
        const base = productCost.get(productId);
        if (typeof base === 'number') return base;
      }
      return 0;
    };

    for (const order of orders) {
      let total = 0;
      for (const item of order.items || []) {
        if (!item) continue;
        const variantKey = item.productVariantId
          ? String(item.productVariantId)
          : null;
        total +=
          unitCost(variantKey, item.productId ? String(item.productId) : null) *
          (Number(item.quantity) || 0);
      }
      cogsByOrder.set(String(order._id), total);
    }
    return cogsByOrder;
  }
}

function distinctStrings(values) {
  const seen = new Set();
  for (const value of values) {
    if (value === null || value === undefined) continue;
    seen.add(String(value));
  }
  return [...seen];
}

function mergeUniqueById(orders) {
  const seen = new Set();
  const merged = [];
  for (const order of orders) {
    if (!order || !order._id) continue;
    const key = String(order._id);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(order);
  }
  return merged;
}

function sumMapValues(map) {
  let total = 0;
  for (const value of map.values()) total += value;
  return total;
}

function sumMinorUnits(items, pick) {
  return items.reduce((acc, item) => acc + (Number(pick(item)) || 0), 0);
}

/**
 * COD revenue is recognized when the order reaches DELIVERED. COMPLETED orders
 * necessarily passed through DELIVERED, so both count. Manual-method orders
 * are deliberately EXCLUDED here — they are recognized through their VERIFIED
 * payment, and payments only ever exist for manual methods (PaymentService
 * eligibility rejects COD), so a single order can never be counted twice.
 */
function isCodDeliveredOrder(order) {
  if (!order || order.paymentMethod !== PAYMENT_METHODS.COD) {
    return false;
  }
  return order.status === ORDER_STATUSES.DELIVERED || order.status === ORDER_STATUSES.COMPLETED;
}

function codOrderRevenue(order) {
  return order && order.totals ? Number(order.totals.grandTotalMinorUnits) || 0 : 0;
}

/**
 * The DELIVERED transition date is the COD revenue recognition event. Derived
 * from the status history (orders carry no deliveredAt field) with a defensive
 * fallback to the last update / creation timestamp.
 */
function codDeliveredAt(order) {
  const entry = (order.statusHistory || []).find((h) => h.status === ORDER_STATUSES.DELIVERED);
  return (entry && entry.at) || order.updatedAt || order.createdAt;
}

function countByStatus(orders) {
  const counts = {};
  for (const order of orders) {
    const status = order.status || 'UNKNOWN';
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

function dateKey(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/**
 * Zero-filled UTC day buckets from start to end inclusive, returned with the
 * ordered key list so the daily series always covers the whole range.
 */
function buildDailyBuckets(start, end) {
  const keys = [];
  const buckets = {};
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  while (cursor.getTime() <= last.getTime()) {
    const key = cursor.toISOString().slice(0, 10);
    keys.push(key);
    buckets[key] = { orders: 0, sales: 0, cogs: 0, refunds: 0, expenses: 0 };
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return { keys, buckets };
}

module.exports = { AnalyticsService, dateKey, buildDailyBuckets };
