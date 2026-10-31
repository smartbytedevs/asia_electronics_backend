'use strict';

const { Router } = require('express');
const { API_BASE_PATH } = require('../constants');
const healthRouter = require('./health.routes');
const { defaultRouter: userRouter } = require('../modules/users/user.routes');
const { defaultRouter: categoryRouter } = require('../modules/categories/category.routes');
const { defaultRouter: productRouter } = require('../modules/products/product.routes');
const { defaultRouter: inventoryRouter } = require('../modules/inventory/inventory.routes');
const { defaultRouter: cartRouter } = require('../modules/cart/cart.routes');
const { defaultRouter: orderRouter } = require('../modules/orders/order.routes');
const { defaultAdminRouter: adminOrderRouter } = require('../modules/orders/adminOrder.routes');
const { defaultRouter: paymentMethodRouter } = require('../modules/payments/paymentMethod.routes');
const { defaultRouter: paymentRouter } = require('../modules/payments/payment.routes');
const { defaultAdminRouter: adminPaymentRouter } = require('../modules/payments/adminPayment.routes');
const { defaultAdminRouter: adminPaymentMethodRouter } = require('../modules/payments/adminPaymentMethod.routes');
const { defaultRouter: courierRouter } = require('../modules/courier/courier.routes');
const { defaultRouter: returnRouter } = require('../modules/returns/return.routes');
const { defaultAdminRouter: adminReturnRouter } = require('../modules/returns/adminReturn.routes');
const { defaultAdminRefundRouter } = require('../modules/refunds/refund.routes');
const { defaultRouter: reviewRouter } = require('../modules/reviews/review.routes');
const { defaultAdminRouter: adminReviewRouter } = require('../modules/reviews/adminReview.routes');
const { defaultRouter: expenseRouter } = require('../modules/expenses/expense.routes');
const { defaultRouter: analyticsRouter } = require('../modules/analytics/analytics.routes');
const { defaultRouter: outletRouter } = require('../modules/outlets/outlet.routes');
const { defaultAdminRouter: adminOutletRouter } = require('../modules/outlets/adminOutlet.routes');
const { defaultRouter: stockTransferRouter } = require('../modules/stockTransfers/stockTransfer.routes');
const { defaultRouter: mediaRouter } = require('../modules/media/media.routes');
const { defaultAdminRouter: adminCustomerRouter } = require('../modules/users/adminCustomer.routes');
const { defaultAdminRouter: adminNotificationRouter } = require('../modules/notifications/adminNotification.routes');

const router = Router();

/**
 * Version 1 API namespace.
 *
 * Future phase API groups (see docs/api-contract.md):
 *   /api/v1/public/*
 *   /api/v1/customer/*
 *   /api/v1/admin/*
 *   /api/v1/staff/*
 *   /api/v1/webhooks/*
 *
 * Future module routers are mounted under their group, e.g.:
 *   router.use('/admin', adminRouter); // where adminRouter mounts /products, /orders ...
 */
const v1 = Router();
v1.use('/health', healthRouter);
v1.use(userRouter);
v1.use('/categories', categoryRouter);
v1.use('/products', productRouter);
v1.use('/inventory', inventoryRouter);
v1.use('/cart', cartRouter);
v1.use('/orders', orderRouter);
v1.use('/orders', paymentRouter);
v1.use('/orders', returnRouter);
v1.use('/payment-methods', paymentMethodRouter);
v1.use('/admin/orders', adminOrderRouter);
v1.use('/admin/payments', adminPaymentRouter);
v1.use('/admin/payment-methods', adminPaymentMethodRouter);
v1.use('/admin/returns', adminReturnRouter);
v1.use('/admin/refunds', defaultAdminRefundRouter);
v1.use('/admin/reviews', adminReviewRouter);
v1.use('/admin/expenses', expenseRouter);
v1.use('/admin/analytics', analyticsRouter);
v1.use('/outlets', outletRouter);
v1.use('/admin/outlets', adminOutletRouter);
v1.use('/admin/stock-transfers', stockTransferRouter);
v1.use('/admin/media', mediaRouter);
v1.use('/admin/customers', adminCustomerRouter);
v1.use('/admin/notifications', adminNotificationRouter);
v1.use('/products', reviewRouter);
v1.use(courierRouter);

router.use(API_BASE_PATH, v1);

module.exports = router;
