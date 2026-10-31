'use strict';

const { Router } = require('express');
const { ROLES } = require('../../constants');
const Refund = require('./refund.model');
const Payment = require('../payments/payment.model');
const { createRefundRepository } = require('./refund.repository');
const { createPaymentRepository } = require('../payments/payment.repository');
const { RefundService } = require('./refund.service');
const { createAdminRefundController } = require('./adminRefund.controller');
const authenticate = require('../../middlewares/authenticate');
const resolveCurrentUser = require('../../middlewares/resolveCurrentUser');
const authorizeRoles = require('../../middlewares/authorizeRoles');
const { defaultUserService } = require('../users/user.routes');

/**
 * Default refund services bound to the central config. Only DB operations
 * happen at request time — module load is connection-free.
 */
const defaultRefundService = new RefundService({
  refundRepository: createRefundRepository(Refund),
  paymentRepository: createPaymentRepository(Payment),
});

/**
 * Admin/Staff refund router, mounted at /api/v1/admin/refunds.
 *
 * ADMIN+STAFF only. The acting id always comes from the authenticated user —
 * never from the request body. PROCESS is the only payout action (PENDING →
 * PROCESSED, requires the linked return COMPLETED); VOID kills a PENDING
 * refund (PENDING → VOIDED).
 */
function createAdminRefundRouter({
  refundService = defaultRefundService,
  userService = defaultUserService,
  verifier,
} = {}) {
  const router = Router();
  const controller = createAdminRefundController({ refundService });

  const staff = [
    authenticate(verifier),
    resolveCurrentUser({ userService }),
    authorizeRoles(ROLES.ADMIN, ROLES.STAFF),
  ];

  router.get('/', staff, controller.listRefunds);
  router.get('/:id', staff, controller.getRefund);
  router.post('/:id/process', staff, controller.processRefund);
  router.post('/:id/void', staff, controller.voidRefund);

  return router;
}

const defaultAdminRefundRouter = createAdminRefundRouter();

module.exports = {
  createAdminRefundRouter,
  defaultAdminRefundRouter,
  defaultRefundService,
};
