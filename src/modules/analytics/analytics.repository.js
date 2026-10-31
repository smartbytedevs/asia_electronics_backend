'use strict';

const { PAYMENT_STATUSES } = require('../payments/payment.constants');
const { REFUND_STATUSES } = require('../refunds/refund.constants');

/**
 * Analytics data-access layer (Phase 13). Read-only reporting queries that
 * filter at the DB level on the event timestamps that define each metric:
 *
 *   - orders   bucketed on createdAt
 *   - revenue  bucketed on verifiedAt (the capture event for VERIFIED)
 *   - refunds  bucketed on processedAt (the payout event for PROCESSED)
 *   - expenses bucketed on expenseDate
 *   - costs    resolved from the EXISTING catalog purchase prices
 *              (Product.purchasePrice / ProductVariant.purchasePriceOverride)
 *              for the order items that generated recognized revenue
 *
 * The repository is deliberately dumb: it returns raw lean docs within the
 * range and the service owns the sums/grouping.
 */
function createAnalyticsRepository({
  orderModel,
  paymentModel,
  refundModel,
  expenseModel,
  productModel,
  variantModel,
}) {
  return {
    findOrders: (from, to) => orderModel.find({ createdAt: { $gte: from, $lte: to } }).lean(),

    /**
     * Orders referenced by a VERIFIED payment. A manual payment is recognized
     * on verification, which may happen after the order was created — so the
     * order (its items, for COGS) is fetched by id even when it falls outside
     * the createdAt range.
     */
    findOrdersByIds: (ids) => orderModel.find({ _id: { $in: ids } }).lean(),

    findVerifiedPayments: (from, to) =>
      paymentModel
        .find({ status: PAYMENT_STATUSES.VERIFIED, verifiedAt: { $gte: from, $lte: to } })
        .lean(),

    findProcessedRefunds: (from, to) =>
      refundModel
        .find({
          status: REFUND_STATUSES.PROCESSED,
          processedAt: { $gte: from, $lte: to },
          deleted: { $ne: true },
        })
        .lean(),

    findExpenses: (from, to) =>
      expenseModel.find({ expenseDate: { $gte: from, $lte: to } }).lean(),

    // Supplier cost data (ADMIN-only catalog fields). Only the price fields are
    // projected — analytics is a privileged read, but stays minimal.
    findProductCosts: (ids) =>
      productModel.find({ _id: { $in: ids } }).select({ _id: 1, purchasePrice: 1 }).lean(),

    findVariantCosts: (ids) =>
      variantModel
        .find({ _id: { $in: ids } })
        .select({ _id: 1, purchasePriceOverride: 1 })
        .lean(),
  };
}

module.exports = { createAnalyticsRepository };
