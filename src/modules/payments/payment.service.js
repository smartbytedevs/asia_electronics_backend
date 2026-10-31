'use strict';

const crypto = require('crypto');
const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const { withTransaction } = require('../../config/database');
const { assertMediaService } = require('../../integrations/media/media.interface');
const { assertObjectId } = require('./payment.validation');
const { serializeCustomerPayment, serializeAdminPayment } = require('./payment.serializer');
const { normalizePagination } = require('../../utils/pagination');
const {
  PAYMENT_STATUSES,
  PAYMENT_MESSAGES,
  PAYMENT_METHOD_TYPES,
} = require('./payment.constants');
const {
  ORDER_STATUSES,
  isManualPaymentMethod,
} = require('../orders/order.constants');
const { NOTIFICATION_EVENT_TYPES } = require('../notifications/notification.constants');
const { createMaybeNotify } = require('../notifications/notification.service');

/**
 * Payment business logic (Phase 08, ADR-0016).
 *
 * The payment state machine is SEPARATE from the order state machine: the
 * payment service never mutates the Order document. Verification does NOT
 * auto-confirm the order and never triggers courier/email/SMS.
 *
 * Submission flow:
 *   1. Customer-scoped order lookup (cross-customer reads → 404, IDOR-safe).
 *   2. Eligibility: own order, a MANUAL payment method (`MANUAL`, `BKASH` or
 *      `BANK_TRANSFER` — CARD orders are ineligible), status PENDING or
 *      CONFIRMED.
 *   3. Exact-amount check against `order.totals.grandTotalMinorUnits`.
 *   4. Proof upload (media service, OUTSIDE the DB transaction).
 *   5. MongoDB transaction: create at SUBMITTED (or resubmit REJECTED →
 *      SUBMITTED). On DB failure the uploaded file is best-effort deleted.
 *
 * Money is integer minor units; the client amount is compared, never trusted.
 */
class PaymentService {
  constructor({
    paymentRepository,
    paymentMethodRepository,
    orderRepository,
    mediaService,
    notificationService = null,
    runTransaction = withTransaction,
  }) {
    if (!paymentRepository || typeof paymentRepository.conditionalTransition !== 'function') {
      throw new Error('PaymentService requires a paymentRepository');
    }
    if (!paymentMethodRepository || typeof paymentMethodRepository.findById !== 'function') {
      throw new Error('PaymentService requires a paymentMethodRepository');
    }
    if (!orderRepository || typeof orderRepository.findOne !== 'function') {
      throw new Error('PaymentService requires an orderRepository');
    }
    assertMediaService(mediaService);
    if (typeof runTransaction !== 'function') {
      throw new Error('PaymentService requires a runTransaction function');
    }
    this.paymentRepository = paymentRepository;
    this.paymentMethodRepository = paymentMethodRepository;
    this.orderRepository = orderRepository;
    this.mediaService = mediaService;
    this.notificationService = notificationService;
    this.maybeNotify = createMaybeNotify(notificationService);
    this.runTransaction = runTransaction;
  }

  paymentNotFound() {
    return new ApiError(404, PAYMENT_MESSAGES.PAYMENT_NOT_FOUND, ERROR_CODES.PAYMENT_NOT_FOUND);
  }

  paymentMethodNotFound() {
    return new ApiError(
      404,
      PAYMENT_MESSAGES.PAYMENT_METHOD_NOT_FOUND,
      ERROR_CODES.PAYMENT_METHOD_NOT_FOUND
    );
  }

  paymentMethodInactive() {
    return new ApiError(
      400,
      'This payment method is not active',
      ERROR_CODES.PAYMENT_METHOD_INACTIVE
    );
  }

  paymentMethodNotManual() {
    return new ApiError(
      400,
      PAYMENT_MESSAGES.PAYMENT_METHOD_NOT_MANUAL,
      ERROR_CODES.PAYMENT_METHOD_NOT_MANUAL
    );
  }

  alreadySubmitted() {
    return new ApiError(
      409,
      PAYMENT_MESSAGES.PAYMENT_ALREADY_SUBMITTED,
      ERROR_CODES.PAYMENT_ALREADY_SUBMITTED
    );
  }

  alreadyVerified() {
    return new ApiError(
      409,
      PAYMENT_MESSAGES.PAYMENT_ALREADY_VERIFIED,
      ERROR_CODES.PAYMENT_ALREADY_VERIFIED
    );
  }

  invalidState() {
    return new ApiError(
      409,
      PAYMENT_MESSAGES.PAYMENT_INVALID_STATE,
      ERROR_CODES.PAYMENT_INVALID_STATE
    );
  }

  orderNotEligible() {
    return new ApiError(
      409,
      PAYMENT_MESSAGES.ORDER_NOT_ELIGIBLE,
      ERROR_CODES.PAYMENT_ORDER_NOT_ELIGIBLE
    );
  }

  idempotencyConflict() {
    return new ApiError(
      409,
      PAYMENT_MESSAGES.IDEMPOTENCY_CONFLICT,
      ERROR_CODES.PAYMENT_IDEMPOTENCY_CONFLICT
    );
  }

  invalidAmount() {
    return new ApiError(
      400,
      PAYMENT_MESSAGES.INVALID_AMOUNT,
      ERROR_CODES.INVALID_PAYMENT_AMOUNT
    );
  }

  isDuplicateOrderIdError(err) {
    return Boolean(
      err &&
        err.code === 11000 &&
        err.keyPattern &&
        Object.prototype.hasOwnProperty.call(err.keyPattern, 'orderId')
    );
  }

  /**
   * Stable fingerprint of the normalized submission request. Stored on the
   * payment and compared on retries: same key + same body → return the
   * existing payment; same key + different body → PAYMENT_IDEMPOTENCY_CONFLICT.
   */
  computeFingerprint({ paymentMethodId, submittedAmountMinorUnits, transactionReference, notes }) {
    return crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          paymentMethodId,
          submittedAmountMinorUnits,
          transactionReference,
          notes: notes === undefined || notes === null ? null : notes,
        })
      )
      .digest('hex');
  }

  buildSnapshot(method) {
    return {
      code: method.code,
      displayName: method.displayName,
      accountNumber: (method.metadata && method.metadata.accountNumber) || null,
    };
  }

  /**
   * Sanitized notification payload for a payment submission (Phase 11,
   * ADR-0019). Built from the payment doc + the already-loaded order — the
   * templates only ever see these safe fields.
   */
  buildPaymentNotificationData(order, payment) {
    return {
      entityRef: String(payment._id),
      order: { orderNumber: payment.orderNumber || (order && order.orderNumber) || null },
      payment: {
        transactionReference: payment.transactionReference || null,
        amountMinorUnits:
          payment.submittedAmountMinorUnits != null
            ? payment.submittedAmountMinorUnits
            : payment.expectedAmountMinorUnits,
      },
    };
  }

  /**
   * Notification payload for verify/reject. Uses the order number denormalized
   * onto the payment doc so the decision path never queries the order.
   */
  buildPaymentDecisionNotificationData(payment, note) {
    return {
      entityRef: String(payment._id),
      order: { orderNumber: payment.orderNumber || null },
      payment: {
        transactionReference: payment.transactionReference || null,
        amountMinorUnits:
          payment.submittedAmountMinorUnits != null
            ? payment.submittedAmountMinorUnits
            : payment.expectedAmountMinorUnits,
      },
      note: note || null,
    };
  }

  /**
   * SUBMIT (customer, own order). Returns `{ payment, created }` where
   * `created` is true only when a brand-new payment record was created.
   */
  async submitPayment({ customerId, orderId, value, proof, idempotencyKey }) {
    assertObjectId(customerId, 'customerId');
    assertObjectId(orderId, 'orderId');

    const order = await this.orderRepository.findOne({ _id: orderId, customerId });
    if (!order) {
      throw this.paymentNotFound();
    }
    if (
      !isManualPaymentMethod(order.paymentMethod) ||
      (order.status !== ORDER_STATUSES.PENDING && order.status !== ORDER_STATUSES.CONFIRMED)
    ) {
      throw this.orderNotEligible();
    }

    const method = await this.paymentMethodRepository.findById(value.paymentMethodId);
    if (!method) {
      throw this.paymentMethodNotFound();
    }
    if (!method.isActive) {
      throw this.paymentMethodInactive();
    }
    if (method.type !== PAYMENT_METHOD_TYPES.MANUAL) {
      throw this.paymentMethodNotManual();
    }

    const expectedAmount = order.totals.grandTotalMinorUnits;
    if (value.submittedAmountMinorUnits !== expectedAmount) {
      throw this.invalidAmount();
    }

    const fingerprint = this.computeFingerprint(value);
    const existing = await this.paymentRepository.findOne({ orderId });
    if (existing) {
      const isRetry =
        existing.idempotencyKey === idempotencyKey &&
        existing.idempotencyFingerprint === fingerprint;
      if (existing.status === PAYMENT_STATUSES.SUBMITTED) {
        if (isRetry) {
          return { payment: serializeCustomerPayment(existing), created: false };
        }
        throw this.alreadySubmitted();
      }
      if (existing.status === PAYMENT_STATUSES.VERIFIED) {
        throw this.alreadyVerified();
      }
      // REJECTED → resubmission (or an idempotent retry of the rejection).
      if (isRetry) {
        return { payment: serializeCustomerPayment(existing), created: false };
      }
      const media = await this.uploadProof(proof);
      try {
        const updated = await this.runTransaction(async (session) => {
          await this.assertNoReferenceReuse(existing._id, method, value, session);
          const historyEntry = {
            status: PAYMENT_STATUSES.SUBMITTED,
            at: new Date(),
            by: customerId,
            note: value.notes || null,
          };
          const doc = await this.paymentRepository.conditionalTransition(
            String(existing._id),
            PAYMENT_STATUSES.REJECTED,
            {
              $set: {
                status: PAYMENT_STATUSES.SUBMITTED,
                orderNumber: order.orderNumber,
                paymentMethodId: method._id,
                paymentMethodSnapshot: this.buildSnapshot(method),
                transactionReference: value.transactionReference,
                submittedAmountMinorUnits: value.submittedAmountMinorUnits,
                expectedAmountMinorUnits: expectedAmount,
                proof: media,
                idempotencyKey,
                idempotencyFingerprint: fingerprint,
                notes: value.notes || null,
              },
              $push: { statusHistory: historyEntry },
              $unset: {
                verifiedBy: 1,
                verifiedAt: 1,
                rejectedBy: 1,
                rejectedAt: 1,
              },
            },
            { session }
          );
          if (!doc) {
            throw this.invalidState();
          }
          return doc;
        });
        this.bestEffortDelete(existing.proof);
        await this.maybeNotify({
          userId: customerId,
          eventType: NOTIFICATION_EVENT_TYPES.PAYMENT_SUBMITTED,
          data: this.buildPaymentNotificationData(order, updated),
        });
        return { payment: serializeCustomerPayment(updated), created: false };
      } catch (err) {
        this.bestEffortDelete(media);
        throw err;
      }
    }

    // No payment record yet → create at SUBMITTED.
    const media = await this.uploadProof(proof);
    try {
      const payment = await this.runTransaction(async (session) => {
        await this.assertNoReferenceReuse(null, method, value, session);
        const created = await this.paymentRepository.create(
          {
            orderId,
            orderNumber: order.orderNumber,
            customerId,
            paymentMethodId: method._id,
            paymentMethodSnapshot: this.buildSnapshot(method),
            transactionReference: value.transactionReference,
            submittedAmountMinorUnits: value.submittedAmountMinorUnits,
            expectedAmountMinorUnits: expectedAmount,
            proof: media,
            status: PAYMENT_STATUSES.SUBMITTED,
            statusHistory: [
              {
                status: PAYMENT_STATUSES.SUBMITTED,
                at: new Date(),
                by: customerId,
                note: value.notes || null,
              },
            ],
            idempotencyKey,
            idempotencyFingerprint: fingerprint,
            notes: value.notes || null,
          },
          { session }
        );
        return created;
      });
      await this.maybeNotify({
        userId: customerId,
        eventType: NOTIFICATION_EVENT_TYPES.PAYMENT_SUBMITTED,
        data: this.buildPaymentNotificationData(order, payment),
      });
      return { payment: serializeCustomerPayment(payment), created: true };
    } catch (err) {
      this.bestEffortDelete(media);
      if (this.isDuplicateOrderIdError(err)) {
        // A concurrent first submission won the race.
        const winner = await this.paymentRepository.findOne({ orderId });
        if (winner) {
          const isRetry =
            winner.idempotencyKey === idempotencyKey &&
            winner.idempotencyFingerprint === fingerprint;
          if (isRetry) {
            return { payment: serializeCustomerPayment(winner), created: false };
          }
          if (winner.status === PAYMENT_STATUSES.VERIFIED) {
            throw this.alreadyVerified();
          }
          throw this.alreadySubmitted();
        }
      }
      throw err;
    }
  }

  async uploadProof(proof) {
    return this.mediaService.uploadFile({
      buffer: proof.buffer,
      mimeType: proof.contentType,
      originalName: proof.originalName,
    });
  }

  bestEffortDelete(media) {
    if (!media) {
      return;
    }
    Promise.resolve(this.mediaService.deleteFile(media)).catch(() => {});
  }

  /**
   * Reference-reuse guard: the same transactionReference may not be claimed
   * by a DIFFERENT order under the same payment method while any active
   * (non-REJECTED) payment holds it.
   */
  async assertNoReferenceReuse(excludePaymentId, method, value, session) {
    const conflict = await this.paymentRepository.findOne(
      {
        _id: { $ne: excludePaymentId ? String(excludePaymentId) : null },
        paymentMethodId: method._id,
        transactionReference: value.transactionReference,
        status: { $ne: PAYMENT_STATUSES.REJECTED },
      },
      { session }
    );
    if (conflict) {
      throw this.idempotencyConflict();
    }
  }

  /**
   * DETAIL (customer, own order). A cross-customer read resolves as 404
   * PAYMENT_NOT_FOUND (the filter includes `customerId`).
   */
  async getCustomerPayment({ customerId, orderId }) {
    assertObjectId(customerId, 'customerId');
    assertObjectId(orderId, 'orderId');
    const doc = await this.paymentRepository.findOne({ orderId, customerId });
    if (!doc) {
      throw this.paymentNotFound();
    }
    return serializeCustomerPayment(doc);
  }

  async listPayments({ status, paymentMethodId, customerId, orderNumber, dateFrom, dateTo, page, limit }) {
    const filter = {};
    if (status !== undefined && status !== null && status !== '') {
      filter.status = status;
    }
    if (paymentMethodId !== undefined && paymentMethodId !== null && paymentMethodId !== '') {
      filter.paymentMethodId = paymentMethodId;
    }
    if (customerId !== undefined && customerId !== null && customerId !== '') {
      filter.customerId = customerId;
    }
    if (orderNumber !== undefined && orderNumber !== null && orderNumber !== '') {
      const order = await this.orderRepository.findOne({ orderNumber });
      if (!order) {
        return {
          payments: [],
          pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
        };
      }
      filter.orderId = String(order._id);
    }
    if (dateFrom || dateTo) {
      const createdAt = {};
      if (dateFrom) createdAt.$gte = dateFrom;
      if (dateTo) createdAt.$lte = dateTo;
      filter.createdAt = createdAt;
    }

    const { page: safePage, limit: safeLimit, skip } = normalizePagination({ page, limit });
    const [docs, total] = await Promise.all([
      this.paymentRepository.findMany(filter, {
        sort: { createdAt: -1 },
        skip,
        limit: safeLimit,
      }),
      this.paymentRepository.count(filter),
    ]);
    return {
      payments: docs.map((doc) => serializeAdminPayment(doc)),
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit),
      },
    };
  }

  async getPayment(paymentId) {
    assertObjectId(paymentId, 'paymentId');
    const doc = await this.paymentRepository.findById(paymentId);
    if (!doc) {
      throw this.paymentNotFound();
    }
    return serializeAdminPayment(doc);
  }

  /**
   * VERIFY (staff/admin). Idempotent when already verified; wrong mutable
   * state → PAYMENT_INVALID_STATE. Does NOT touch the Order document.
   */
  async verifyPayment({ paymentId, performedBy, note }) {
    assertObjectId(paymentId, 'paymentId');
    assertObjectId(performedBy, 'performedBy');
    const existing = await this.paymentRepository.findById(paymentId);
    if (!existing) {
      throw this.paymentNotFound();
    }
    if (existing.status === PAYMENT_STATUSES.VERIFIED) {
      return serializeAdminPayment(existing);
    }
    if (existing.status !== PAYMENT_STATUSES.SUBMITTED) {
      throw this.invalidState();
    }
    const now = new Date();
    const updated = await this.paymentRepository.conditionalTransition(
      paymentId,
      PAYMENT_STATUSES.SUBMITTED,
      {
        $set: {
          status: PAYMENT_STATUSES.VERIFIED,
          verifiedBy: performedBy,
          verifiedAt: now,
        },
        $push: {
          statusHistory: { status: PAYMENT_STATUSES.VERIFIED, at: now, by: performedBy, note: note || null },
        },
      }
    );
    if (!updated) {
      throw this.invalidState();
    }
    await this.maybeNotify({
      userId: String(existing.customerId),
      eventType: NOTIFICATION_EVENT_TYPES.PAYMENT_VERIFIED,
      data: this.buildPaymentDecisionNotificationData(updated, note),
    });
    return serializeAdminPayment(updated);
  }

  /**
   * REJECT (staff/admin). Idempotent when already rejected; wrong mutable
   * state → PAYMENT_INVALID_STATE.
   */
  async rejectPayment({ paymentId, performedBy, note }) {
    assertObjectId(paymentId, 'paymentId');
    assertObjectId(performedBy, 'performedBy');
    const existing = await this.paymentRepository.findById(paymentId);
    if (!existing) {
      throw this.paymentNotFound();
    }
    if (existing.status === PAYMENT_STATUSES.REJECTED) {
      return serializeAdminPayment(existing);
    }
    if (existing.status !== PAYMENT_STATUSES.SUBMITTED) {
      throw this.invalidState();
    }
    const now = new Date();
    const updated = await this.paymentRepository.conditionalTransition(
      paymentId,
      PAYMENT_STATUSES.SUBMITTED,
      {
        $set: {
          status: PAYMENT_STATUSES.REJECTED,
          rejectedBy: performedBy,
          rejectedAt: now,
        },
        $push: {
          statusHistory: { status: PAYMENT_STATUSES.REJECTED, at: now, by: performedBy, note: note || null },
        },
      }
    );
    if (!updated) {
      throw this.invalidState();
    }
    await this.maybeNotify({
      userId: String(existing.customerId),
      eventType: NOTIFICATION_EVENT_TYPES.PAYMENT_REJECTED,
      data: this.buildPaymentDecisionNotificationData(updated, note),
    });
    return serializeAdminPayment(updated);
  }
}

module.exports = { PaymentService };
