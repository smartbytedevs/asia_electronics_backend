'use strict';

const { Router } = require('express');
const { ROLES } = require('../../constants');
const Order = require('../orders/order.model');
const Payment = require('../payments/payment.model');
const Refund = require('../refunds/refund.model');
const Expense = require('../expenses/expense.model');
const Product = require('../products/product.model');
const ProductVariant = require('../products/variants/productVariant.model');
const { createAnalyticsRepository } = require('./analytics.repository');
const { AnalyticsService } = require('./analytics.service');
const { createAnalyticsController } = require('./analytics.controller');
const authenticate = require('../../middlewares/authenticate');
const resolveCurrentUser = require('../../middlewares/resolveCurrentUser');
const authorizeRoles = require('../../middlewares/authorizeRoles');
const { defaultUserService } = require('../users/user.routes');

/**
 * Default analytics service bound to the central config. Only DB reads happen
 * at request time — module load is connection-free.
 */
const defaultAnalyticsService = new AnalyticsService({
  analyticsRepository: createAnalyticsRepository({
    orderModel: Order,
    paymentModel: Payment,
    refundModel: Refund,
    expenseModel: Expense,
    productModel: Product,
    variantModel: ProductVariant,
  }),
});

/**
 * Admin analytics router, mounted at /api/v1/admin/analytics. ADMIN only
 * (the dashboard is a privileged view of financial records). Read-only:
 *   GET /summary?dateFrom=&dateTo=  — totals + order/status counts
 *   GET /daily?dateFrom=&dateTo=    — zero-filled daily series
 */
function createAnalyticsRouter({
  analyticsService = defaultAnalyticsService,
  userService = defaultUserService,
  verifier,
} = {}) {
  const router = Router();
  const controller = createAnalyticsController({ analyticsService });

  const admin = [
    authenticate(verifier),
    resolveCurrentUser({ userService }),
    authorizeRoles(ROLES.ADMIN),
  ];

  router.get('/summary', admin, controller.getSummary);
  router.get('/daily', admin, controller.getDaily);

  return router;
}

const defaultRouter = createAnalyticsRouter();

module.exports = { createAnalyticsRouter, defaultRouter, defaultAnalyticsService };
