'use strict';

const { assertObjectId } = require('./order.validation');
const { serializeAdminOrder } = require('./order.serializer');
const { normalizePagination } = require('../../utils/pagination');
const { canTransition } = require('./order.state-machine');
const {
  ORDER_STATUSES,
  REACHABLE_ORDER_STATUSES,
  isManualPaymentMethod,
} = require('./order.constants');
const { PAYMENT_STATUSES } = require('../payments/payment.constants');
const { NOTIFICATION_EVENT_TYPES } = require('../notifications/notification.constants');
const { createMaybeNotify } = require('../notifications/notification.service');

/**
 * Admin/Staff order business logic (Phase 07, ADR-0015).
 *
 * These operations are NOT customer-scoped (staff/admin can read any order).
 * The acting staff/admin id (`performedBy`) is always `req.user.id` — never a
 * body field. State transitions delegate to OrderService.performTransition,
 * which owns the atomic conditional status update and the reservation-release
 * side effect for terminal transitions.
 *
 * Confirmation of manual-method orders (BKASH/BANK_TRANSFER/MANUAL) requires a
 * VERIFIED payment — the Order status is the source of truth and a manual-method
 * order must be paid before it can be confirmed/dispatched.
 */
class AdminOrderService {
  constructor({
    orderRepository,
    orderService,
    courierService = null,
    notificationService = null,
    paymentRepository,
    autoDispatchOnConfirm = false,
  }) {
    if (!orderRepository || typeof orderRepository.findMany !== 'function') {
      throw new Error('AdminOrderService requires an orderRepository');
    }
    if (!orderService || typeof orderService.performTransition !== 'function') {
      throw new Error('AdminOrderService requires an orderService');
    }
    if (!paymentRepository || typeof paymentRepository.findOne !== 'function') {
      throw new Error('AdminOrderService requires a paymentRepository');
    }
    this.orderRepository = orderRepository;
    this.orderService = orderService;
    this.courierService = courierService;
    this.notificationService = notificationService;
    this.paymentRepository = paymentRepository;
    this.maybeNotify = createMaybeNotify(notificationService);
    this.autoDispatchOnConfirm = Boolean(autoDispatchOnConfirm);
  }

  /**
   * Best-effort courier dispatch after confirmation. Enabled ONLY by
   * COURIER_AUTO_DISPATCH_ON_CONFIRM=true. Provider failures must never roll
   * back the confirmation — the shipment stays retryable via
   * POST /admin/shipments/:id/retry.
   */
  async maybeAutoDispatch({ orderId, performedBy }) {
    if (!this.autoDispatchOnConfirm || !this.courierService) {
      return;
    }
    try {
      await this.courierService.dispatchForOrder({
        orderId,
        performedBy,
        note: 'Auto-dispatch after confirmation',
      });
    } catch (err) {
      console.error('[courier] auto-dispatch failed', { orderId, error: err.message });
    }
  }

  async listOrders({ status, customerId, page, limit }) {
    const filter = {};
    if (status !== undefined && status !== null && status !== '') {
      if (!REACHABLE_ORDER_STATUSES.includes(status)) {
        throw this.orderService.invalidOrder(
          `status must be one of: ${REACHABLE_ORDER_STATUSES.join(', ')}`
        );
      }
      filter.status = status;
    }
    if (customerId !== undefined && customerId !== null && customerId !== '') {
      assertObjectId(customerId, 'customerId');
      filter.customerId = customerId;
    }
    const { page: safePage, limit: safeLimit, skip } = normalizePagination({ page, limit });
    return this.list(filter, safePage, safeLimit, skip);
  }

  async list(filter, safePage, safeLimit, skip) {
    const [docs, total] = await Promise.all([
      this.orderRepository.findMany(filter, {
        sort: { createdAt: -1 },
        skip,
        limit: safeLimit,
      }),
      this.orderRepository.count(filter),
    ]);
    return {
      orders: docs.map((doc) => serializeAdminOrder(doc)),
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit),
      },
    };
  }

  async getOrder(orderId) {
    assertObjectId(orderId, 'orderId');
    const doc = await this.orderRepository.findById(orderId);
    if (!doc) {
      throw this.orderService.orderNotFound();
    }
    return serializeAdminOrder(doc);
  }

  async assertTransition(orderId, fromStatus, toStatus, notAllowedError) {
    const doc = await this.orderRepository.findById(orderId);
    if (!doc) {
      throw this.orderService.orderNotFound();
    }
    if (!canTransition(doc.status, toStatus)) {
      throw notAllowedError;
    }
    return doc;
  }

  async confirmOrder({ orderId, performedBy, note }) {
    const doc = await this.assertTransition(
      orderId,
      ORDER_STATUSES.PENDING,
      ORDER_STATUSES.CONFIRMED,
      this.orderService.confirmationNotAllowed()
    );
    if (isManualPaymentMethod(doc.paymentMethod)) {
      const payment = await this.paymentRepository.findOne({ orderId: doc._id });
      if (!payment || payment.status !== PAYMENT_STATUSES.VERIFIED) {
        throw this.orderService.paymentVerificationRequired();
      }
    }
    const updated = await this.orderService.performTransition({
      orderId,
      fromStatus: doc.status,
      toStatus: ORDER_STATUSES.CONFIRMED,
      performedBy,
      note,
      notAllowedError: this.orderService.confirmationNotAllowed(),
    });
    const serialized = serializeAdminOrder(updated);
    await this.maybeAutoDispatch({ orderId, performedBy });
    await this.maybeNotify({
      userId: String(updated.customerId),
      eventType: NOTIFICATION_EVENT_TYPES.ORDER_CONFIRMED,
      data: this.orderService.buildOrderNotificationData(updated),
    });
    return serialized;
  }

  async processOrder({ orderId, performedBy, note }) {
    const doc = await this.assertTransition(
      orderId,
      ORDER_STATUSES.CONFIRMED,
      ORDER_STATUSES.PROCESSING,
      this.orderService.processingNotAllowed()
    );
    const updated = await this.orderService.performTransition({
      orderId,
      fromStatus: doc.status,
      toStatus: ORDER_STATUSES.PROCESSING,
      performedBy,
      note,
      notAllowedError: this.orderService.processingNotAllowed(),
    });
    await this.maybeNotify({
      userId: String(updated.customerId),
      eventType: NOTIFICATION_EVENT_TYPES.ORDER_PROCESSING,
      data: this.orderService.buildOrderNotificationData(updated),
    });
    return serializeAdminOrder(updated);
  }

  async shipOrder({ orderId, performedBy, note }) {
    const doc = await this.assertTransition(
      orderId,
      ORDER_STATUSES.DISPATCHED,
      ORDER_STATUSES.SHIPPED,
      this.orderService.shippingNotAllowed()
    );
    const updated = await this.orderService.performTransition({
      orderId,
      fromStatus: doc.status,
      toStatus: ORDER_STATUSES.SHIPPED,
      performedBy,
      note,
      notAllowedError: this.orderService.shippingNotAllowed(),
    });
    return serializeAdminOrder(updated);
  }

  async deliverOrder({ orderId, performedBy, note }) {
    const doc = await this.assertTransition(
      orderId,
      ORDER_STATUSES.SHIPPED,
      ORDER_STATUSES.DELIVERED,
      this.orderService.deliveryNotAllowed()
    );
    const updated = await this.orderService.performTransition({
      orderId,
      fromStatus: doc.status,
      toStatus: ORDER_STATUSES.DELIVERED,
      performedBy,
      note,
      notAllowedError: this.orderService.deliveryNotAllowed(),
    });
    await this.maybeNotify({
      userId: String(updated.customerId),
      eventType: NOTIFICATION_EVENT_TYPES.ORDER_DELIVERED,
      data: this.orderService.buildOrderNotificationData(updated),
    });
    return serializeAdminOrder(updated);
  }

  async returnOrder({ orderId, performedBy, note }) {
    const doc = await this.assertTransition(
      orderId,
      ORDER_STATUSES.SHIPPED,
      ORDER_STATUSES.RETURNED,
      this.orderService.returnNotAllowed()
    );
    const updated = await this.orderService.performTransition({
      orderId,
      fromStatus: doc.status,
      toStatus: ORDER_STATUSES.RETURNED,
      performedBy,
      note,
      notAllowedError: this.orderService.returnNotAllowed(),
    });
    return serializeAdminOrder(updated);
  }

  async completeOrder({ orderId, performedBy, note }) {
    const doc = await this.assertTransition(
      orderId,
      ORDER_STATUSES.DELIVERED,
      ORDER_STATUSES.COMPLETED,
      this.orderService.completionNotAllowed()
    );
    const updated = await this.orderService.performTransition({
      orderId,
      fromStatus: doc.status,
      toStatus: ORDER_STATUSES.COMPLETED,
      performedBy,
      note,
      notAllowedError: this.orderService.completionNotAllowed(),
    });
    return serializeAdminOrder(updated);
  }

  /**
   * Cancel a pre-delivery order (PENDING/CONFIRMED/PROCESSING/DISPATCHED/
   * SHIPPED). Mirrors the customer cancel side effects: reservations are
   * released inside performTransition, any courier shipment is cancelled
   * best-effort, and the customer is notified.
   */
  async cancelOrder({ orderId, performedBy, note }) {
    const doc = await this.assertTransition(
      orderId,
      null,
      ORDER_STATUSES.CANCELLED,
      this.orderService.cancellationNotAllowed()
    );
    const updated = await this.orderService.performTransition({
      orderId,
      fromStatus: doc.status,
      toStatus: ORDER_STATUSES.CANCELLED,
      performedBy,
      note,
      notAllowedError: this.orderService.cancellationNotAllowed(),
    });
    await this.orderService.maybeCancelCourierShipment({ orderId, performedBy });
    await this.maybeNotify({
      userId: String(updated.customerId),
      eventType: NOTIFICATION_EVENT_TYPES.ORDER_CANCELLED,
      data: this.orderService.buildOrderNotificationData(updated),
    });
    return serializeAdminOrder(updated);
  }

  async rejectOrder({ orderId, performedBy, note }) {
    const doc = await this.assertTransition(
      orderId,
      ORDER_STATUSES.PENDING,
      ORDER_STATUSES.REJECTED,
      this.orderService.rejectionNotAllowed()
    );
    const updated = await this.orderService.performTransition({
      orderId,
      fromStatus: doc.status,
      toStatus: ORDER_STATUSES.REJECTED,
      performedBy,
      note,
      notAllowedError: this.orderService.rejectionNotAllowed(),
    });
    await this.maybeNotify({
      userId: String(updated.customerId),
      eventType: NOTIFICATION_EVENT_TYPES.ORDER_REJECTED,
      data: this.orderService.buildOrderNotificationData(updated),
    });
    return serializeAdminOrder(updated);
  }
}

module.exports = { AdminOrderService };
