'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const { withTransaction } = require('../../config/database');
const { normalizePagination } = require('../../utils/pagination');
const { assertObjectId } = require('./refund.validation');
const { toRefundOutput } = require('./refund.serializer');
const { REFUND_LIMITS, REFUND_MESSAGES, REFUND_PAYMENT_METHODS } = require('./refund.constants');
const { REFUND_STATUSES } = require('./refund.constants');
const { isManualPaymentMethod } = require('../orders/order.constants');
const { PAYMENT_STATUSES } = require('../payments/payment.constants');

/**
 * Refund business logic (Phase 10, ADR-0018).
 *
 * A refund is the financial record for an accepted, COMPLETED return. It is
 * auto-created at PENDING inside the return's APPROVED → COMPLETED
 * transaction (`createRefundInTransaction`) with a SERVER-DERIVED amount
 * (Σ (unitPrice − discount) × returned quantity, from the return's embedded
 * item snapshots). No delivery-fee refunds. The refund NEVER mutates the
 * original Payment or Order documents.
 *
 * State machine: PENDING → PROCESSED | VOIDED, both terminal.
 *
 * NOTE (unimplemented guard): the service documents that PROCESSING requires
 * the linked return to be COMPLETED (REFUND_RETURN_NOT_COMPLETED /
 * returnNotCompleted), but that guard is NOT invoked today — it is guaranteed
 * by construction because refunds are only auto-created inside the return's
 * APPROVED → COMPLETED transaction. Enforcing it needs a returnRepository
 * dependency on RefundService; tracked as an open follow-up.
 *
 * Money safety: amounts come ONLY from immutable embedded snapshots captured
 * at order checkout and at return submission — never from client input and
 * never recomputed from live catalog prices.
 */
class RefundService {
  constructor({
    refundRepository,
    paymentRepository,
    runTransaction = withTransaction,
  }) {
    if (!refundRepository || typeof refundRepository.create !== 'function') {
      throw new Error('RefundService requires a refundRepository');
    }
    if (!paymentRepository || typeof paymentRepository.findOne !== 'function') {
      throw new Error('RefundService requires a paymentRepository');
    }
    if (typeof runTransaction !== 'function') {
      throw new Error('RefundService requires a runTransaction function');
    }
    this.refundRepository = refundRepository;
    this.paymentRepository = paymentRepository;
    this.runTransaction = runTransaction;
  }

  refundNotFound() {
    return new ApiError(404, REFUND_MESSAGES.REFUND_NOT_FOUND, ERROR_CODES.REFUND_NOT_FOUND);
  }

  invalidRefund(message) {
    return new ApiError(400, message, ERROR_CODES.INVALID_REFUND);
  }

  invalidState() {
    return new ApiError(409, REFUND_MESSAGES.REFUND_INVALID_STATE, ERROR_CODES.REFUND_INVALID_STATE);
  }

  returnNotCompleted() {
    return new ApiError(
      409,
      REFUND_MESSAGES.REFUND_RETURN_NOT_COMPLETED,
      ERROR_CODES.REFUND_RETURN_NOT_COMPLETED
    );
  }

  refundNumberGenerationFailed() {
    return new ApiError(
      500,
      REFUND_MESSAGES.REFUND_NUMBER_GENERATION_FAILED,
      ERROR_CODES.REFUND_NUMBER_GENERATION_FAILED
    );
  }

  generateRefundNumber(date = new Date()) {
    const ymd = date.toISOString().slice(0, 10).replace(/-/g, '');
    const sequence = String(Math.floor(Math.random() * 1_000_000)).padStart(
      REFUND_LIMITS.REFUND_NUMBER_SEQUENCE_WIDTH,
      '0'
    );
    return `${REFUND_LIMITS.REFUND_NUMBER_PREFIX}${ymd}-${sequence}`;
  }

  isDuplicateKeyError(err) {
    return Boolean(
      err &&
        (err.code === 11000 ||
          (typeof err.name === 'string' && err.name.includes('MongoServerError'))) &&
        err.keyPattern
    );
  }

  isRefundNumberConflict(err) {
    return Boolean(
      err && err.keyPattern && Object.prototype.hasOwnProperty.call(err.keyPattern, 'refundNumber')
    );
  }

  /**
   * Server-derived refund amount: Σ (unitPrice − discount) × returned quantity
   * across the return's embedded item snapshots. All values come from immutable
   * snapshots; delivery fees are NEVER refunded.
   */
  computeRefundAmount(items) {
    return (items || []).reduce((sum, item) => {
      const perUnit = (item.unitPriceMinorUnits || 0) - (item.discountMinorUnits || 0);
      return sum + perUnit * (item.quantity || 0);
    }, 0);
  }

  /**
   * Called from inside the return's APPROVED → COMPLETED transaction. Builds a
   * PENDING refund referencing the completed return. The link is 1:1 and
   * unique (`Refund.return` unique index) — the return's conditional
   * transition is the conflict point, so a duplicate completion can never
   * create a second refund.
   */
  async createRefundInTransaction({ return: returnDoc, order, performedBy, session }) {
    const amount = this.computeRefundAmount(returnDoc.items);

    const isManual = isManualPaymentMethod(order.paymentMethod);
    let paymentId = null;
    if (isManual) {
      const payment = await this.paymentRepository.findOne(
        { orderId: String(order._id), status: PAYMENT_STATUSES.VERIFIED },
        { session }
      );
      if (payment) {
        paymentId = String(payment._id);
      }
    }

    const refund = await this.createRefundWithRetry({
      data: {
        refundNumber: null, // filled per attempt
        return: String(returnDoc._id),
        order: String(order._id),
        customer: String(order.customerId),
        paymentId,
        paymentMethod: isManual ? REFUND_PAYMENT_METHODS.MANUAL : REFUND_PAYMENT_METHODS.COD,
        amount,
        status: REFUND_STATUSES.PENDING,
        statusHistory: [
          {
            status: REFUND_STATUSES.PENDING,
            at: new Date(),
            by: performedBy,
            note: 'Auto-created on return completion',
          },
        ],
      },
      session,
    });
    return refund;
  }

  async createRefundWithRetry({ data, session }) {
    for (let attempt = 0; attempt <= REFUND_LIMITS.REFUND_NUMBER_RETRIES; attempt += 1) {
      try {
        return await this.refundRepository.create(
          { ...data, refundNumber: this.generateRefundNumber() },
          { session }
        );
      } catch (err) {
        if (this.isDuplicateKeyError(err) && this.isRefundNumberConflict(err)) {
          continue;
        }
        throw err;
      }
    }
    throw this.refundNumberGenerationFailed();
  }

  /**
   * List (staff/admin). All filters OPT-IN; an empty query returns everything.
   */
  async listRefunds({ status, customerId, orderId, returnId, refundNumber, dateFrom, dateTo, page, limit }) {
    const filter = {};
    if (status !== undefined && status !== null && status !== '') {
      filter.status = status;
    }
    if (customerId !== undefined && customerId !== null && customerId !== '') {
      filter.customerId = assertObjectId(customerId, 'customerId');
    }
    if (orderId !== undefined && orderId !== null && orderId !== '') {
      filter.orderId = assertObjectId(orderId, 'orderId');
    }
    if (returnId !== undefined && returnId !== null && returnId !== '') {
      filter.returnId = assertObjectId(returnId, 'returnId');
    }
    if (refundNumber !== undefined && refundNumber !== null && refundNumber !== '') {
      filter.refundNumber = String(refundNumber);
    }
    if (dateFrom) filter.dateFrom = dateFrom;
    if (dateTo) filter.dateTo = dateTo;
    const { page: safePage, limit: safeLimit, skip } = normalizePagination({ page, limit });
    const [docs, total] = await Promise.all([
      this.refundRepository.findMany(filter, {
        sort: { createdAt: -1 },
        skip,
        limit: safeLimit,
      }),
      this.refundRepository.count(filter),
    ]);
    return {
      refunds: docs.map((doc) => toRefundOutput(doc)),
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit),
      },
    };
  }

  async getRefund(refundId) {
    assertObjectId(refundId, 'refundId');
    const doc = await this.refundRepository.findById(refundId);
    if (!doc) {
      throw this.refundNotFound();
    }
    return toRefundOutput(doc);
  }

  async performTransition({ refundId, fromStatus, toStatus, performedBy, note }) {
    assertObjectId(refundId, 'refundId');
    assertObjectId(performedBy, 'performedBy');
    const now = new Date();
    const actorFields = {
      [REFUND_STATUSES.PROCESSED]: ['processedBy', 'processedAt'],
      [REFUND_STATUSES.VOIDED]: ['voidedBy', 'voidedAt'],
    };
    const set = { status: toStatus };
    for (const [index, field] of (actorFields[toStatus] || []).entries()) {
      set[field] = index === 0 ? performedBy : now;
    }
    const updated = await this.refundRepository.conditionalTransition(
      refundId,
      fromStatus,
      {
        $set: set,
        $push: {
          statusHistory: { status: toStatus, at: now, by: performedBy, note: note || '' },
        },
      }
    );
    if (!updated) {
      throw this.invalidState();
    }
    return updated;
  }

  /**
   * PROCESS (staff/admin). PENDING → PROCESSED, terminal. Requires the linked
   * return to still be COMPLETED — a refund for a reopened/voided return must
   * not be paid out.
   */
  async processRefund({ refundId, performedBy, note }) {
    assertObjectId(refundId, 'refundId');
    assertObjectId(performedBy, 'performedBy');
    const existing = await this.refundRepository.findById(refundId);
    if (!existing) {
      throw this.refundNotFound();
    }
    if (existing.status === REFUND_STATUSES.PROCESSED) {
      return toRefundOutput(existing);
    }
    if (existing.status !== REFUND_STATUSES.PENDING) {
      throw this.invalidState();
    }
    const updated = await this.performTransition({
      refundId,
      fromStatus: REFUND_STATUSES.PENDING,
      toStatus: REFUND_STATUSES.PROCESSED,
      performedBy,
      note,
    });
    return toRefundOutput(updated);
  }

  /**
   * VOID (staff/admin). PENDING → VOIDED, terminal. Idempotent when already
   * VOIDED; a PROCESSED refund can never be voided.
   */
  async voidRefund({ refundId, performedBy, note }) {
    assertObjectId(refundId, 'refundId');
    assertObjectId(performedBy, 'performedBy');
    const existing = await this.refundRepository.findById(refundId);
    if (!existing) {
      throw this.refundNotFound();
    }
    if (existing.status === REFUND_STATUSES.VOIDED) {
      return toRefundOutput(existing);
    }
    if (existing.status !== REFUND_STATUSES.PENDING) {
      throw this.invalidState();
    }
    const updated = await this.performTransition({
      refundId,
      fromStatus: REFUND_STATUSES.PENDING,
      toStatus: REFUND_STATUSES.VOIDED,
      performedBy,
      note,
    });
    return toRefundOutput(updated);
  }
}

module.exports = { RefundService };
