'use strict';

/**
 * Analytics constants (Phase 13).
 *
 * Admin-only read models computed from the EXISTING financial records:
 *
 *   sales   = Σ submittedAmountMinorUnits of VERIFIED payments
 *             (manual methods BKASH/BANK_TRANSFER/MANUAL — recognized only
 *              when staff/admin verify the proof; SUBMITTED/REJECTED/UNPAID
 *              are never revenue; see payment.constants.js)
 *           + Σ grandTotalMinorUnits of DELIVERED/COMPLETED COD orders
 *             (COD revenue is recognized on delivery, bucketed on the
 *              DELIVERED transition date; undelivered COD orders are not yet
 *              revenue)
 *             Manual orders are counted only via their payment and COD orders
 *             only via the order, so a revenue event is never double-counted.
 *   cogs    = Σ supplier cost of the goods behind that recognized revenue
 *             (DELIVERED/COMPLETED COD order items + items of orders behind
 *              VERIFIED payments). Unit cost is the EXISTING catalog purchase
 *              price — ProductVariant.purchasePriceOverride when set, else
 *              Product.purchasePrice. Order-item snapshots do not record
 *              supplier cost (ADR-0015), so the current catalog price is used;
 *              items without cost data contribute 0 (analytics never invents
 *              a cost it cannot prove).
 *   grossProfit = sales − cogs
 *   refunds = Σ amount of PROCESSED refunds
 *             (PENDING/VOIDED refunds never leave the business)
 *   expenses = Σ amountMinorUnits of Expense lines
 *   net     = grossProfit − refunds − expenses
 *
 * Total Sales, Total Refunds, and Total Expenses are unchanged — only Net now
 * reflects actual profit (recognized revenue minus the cost of the goods sold,
 * minus payouts and running costs) instead of total revenue minus costs.
 */

const ANALYTICS_LIMITS = Object.freeze({
  DEFAULT_RANGE_DAYS: 30,
});

const ANALYTICS_MESSAGES = Object.freeze({
  SUMMARY_FETCHED: 'Analytics summary retrieved successfully',
  DAILY_FETCHED: 'Daily analytics retrieved successfully',
  INVALID_RANGE: 'Invalid analytics date range',
});

module.exports = {
  ANALYTICS_LIMITS,
  ANALYTICS_MESSAGES,
};
