'use strict';

const crypto = require('crypto');
const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const { withTransaction } = require('../../config/database');
const { assertObjectId } = require('./return.validation');
const { serializeCustomerReturn, serializeAdminReturn } = require('./return.serializer');
const { normalizePagination } = require('../../utils/pagination');
const {
  RETURN_STATUSES,
  RETURN_CLAIMED_STATUSES,
  RETURN_ELIGIBLE_ORDER_STATUSES,
  RETURN_LIMITS,
  RETURN_MESSAGES,
} = require('./return.constants');

const ELIGIBLE_MS = RETURN_LIMITS.ELIGIBLE_DAYS * 24 * 60 * 60 * 1000;

/**
 * Return business logic (Phase 10, ADR-0018).
 *
 * The return state machine is SEPARATE and DECOUPLED from the order state
 * machine: this service NEVER mutates the Order document, and the order-level
 * RETURN_REQUESTED / RETURNED statuses stay reserved. Refund + restock side
 * effects happen ONLY inside the APPROVED → COMPLETED transaction.
 *
 * Safety:
 * - Customer scoping is enforced HERE: every customer query filters on
 *   `customerId`, and a cross-customer read resolves as RETURN_NOT_FOUND
 *   (never 403) to avoid leaking existence.
 * - Eligibility is server-derived: own order, status CONFIRMED or PROCESSING,
 *   within `RETURN_LIMITS.ELIGIBLE_DAYS` of `order.createdAt`.
 * - Duplicate prevention: per-item availability = orderItem.quantity minus the
 *   quantity claimed by PENDING / APPROVED / COMPLETED returns, PLUS the unique
 *   `{ orderId, idempotencyKey }` index that makes submission replay-safe.
 * - Every status change is an ATOMIC CONDITIONAL transition
 *   (`conditionalTransition`); the refund/restock transaction's conflict point
 *   is the APPROVED → COMPLETED transition, so two concurrent completes cannot
 *   double-restock or double-refund.
 *
 * DOCUMENTED LIMITATION (also in docs/return-state-machine.md): two concurrent
 * submissions with DIFFERENT idempotency keys for overlapping quantities could
 * both pass the availability check before either commits (there is no atomic
 * "claim" document). The unique compound index prevents same-key replays and
 * fingerprint mismatch surfaces RETURN_IDEMPOTENCY_CONFLICT.
 */
class ReturnService {
  constructor({
    returnRepository,
    orderRepository,
    refundService,
    inventoryService,
    runTransaction = withTransaction,
  }) {
    if (!returnRepository || typeof returnRepository.conditionalTransition !== 'function') {
      throw new Error('ReturnService requires a returnRepository');
    }
    if (!orderRepository || typeof orderRepository.findOne !== 'function') {
      throw new Error('ReturnService requires an orderRepository');
    }
    if (!refundService || typeof refundService.createRefundInTransaction !== 'function') {
      throw new Error('ReturnService requires a refundService');
    }
    if (!inventoryService || typeof inventoryService.restockOnlineInTransaction !== 'function') {
      throw new Error('ReturnService requires an inventoryService');
    }
    if (typeof runTransaction !== 'function') {
      throw new Error('ReturnService requires a runTransaction function');
    }
    this.returnRepository = returnRepository;
    this.orderRepository = orderRepository;
    this.refundService = refundService;
    this.inventoryService = inventoryService;
    this.runTransaction = runTransaction;
  }

  returnNotFound() {
    return new ApiError(404, RETURN_MESSAGES.RETURN_NOT_FOUND, ERROR_CODES.RETURN_NOT_FOUND);
  }

  invalidReturn(message) {
    return new ApiError(400, message, ERROR_CODES.INVALID_RETURN);
  }

  invalidState() {
    return new ApiError(409, RETURN_MESSAGES.RETURN_INVALID_STATE, ERROR_CODES.RETURN_INVALID_STATE);
  }

  notEligible() {
    return new ApiError(409, RETURN_MESSAGES.RETURN_NOT_ELIGIBLE, ERROR_CODES.RETURN_NOT_ELIGIBLE);
  }

  windowExpired() {
    return new ApiError(409, RETURN_MESSAGES.RETURN_WINDOW_EXPIRED, ERROR_CODES.RETURN_WINDOW_EXPIRED);
  }

  itemNotFound() {
    return new ApiError(
      404,
      RETURN_MESSAGES.RETURN_ITEM_NOT_FOUND,
      ERROR_CODES.RETURN_ITEM_NOT_FOUND
    );
  }

  quantityExceeded() {
    return new ApiError(
      409,
      RETURN_MESSAGES.RETURN_QUANTITY_EXCEEDED,
      ERROR_CODES.RETURN_QUANTITY_EXCEEDED
    );
  }

  idempotencyConflict() {
    return new ApiError(
      409,
      RETURN_MESSAGES.IDEMPOTENCY_CONFLICT,
      ERROR_CODES.RETURN_IDEMPOTENCY_CONFLICT
    );
  }

  returnNumberGenerationFailed() {
    return new ApiError(
      500,
      RETURN_MESSAGES.RETURN_NUMBER_GENERATION_FAILED,
      ERROR_CODES.RETURN_NUMBER_GENERATION_FAILED
    );
  }

  /**
   * Stable fingerprint of the normalized return request. Stored on the return
   * and compared on retries: same key + same body → return the original
   * return; same key + different body → RETURN_IDEMPOTENCY_CONFLICT.
   */
  computeFingerprint({ reason, notes, items }) {
    return crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          reason,
          notes: notes === undefined || notes === null ? null : notes,
          items,
        })
      )
      .digest('hex');
  }

  generateReturnNumber(date = new Date()) {
    const ymd = date.toISOString().slice(0, 10).replace(/-/g, '');
    const sequence = String(Math.floor(Math.random() * 1_000_000)).padStart(
      RETURN_LIMITS.RETURN_NUMBER_SEQUENCE_WIDTH,
      '0'
    );
    return `${RETURN_LIMITS.RETURN_NUMBER_PREFIX}${ymd}-${sequence}`;
  }

  isDuplicateKeyError(err) {
    return Boolean(
      err &&
        (err.code === 11000 ||
          (typeof err.name === 'string' && err.name.includes('MongoServerError'))) &&
        err.keyPattern
    );
  }

  isReturnNumberConflict(err) {
    return Boolean(
      err && err.keyPattern && Object.prototype.hasOwnProperty.call(err.keyPattern, 'returnNumber')
    );
  }

  isReturnIdempotencyConflict(err) {
    return Boolean(
      err && err.keyPattern && Object.prototype.hasOwnProperty.call(err.keyPattern, 'idempotencyKey')
    );
  }

  assertReturnableOrder(order) {
    if (!RETURN_ELIGIBLE_ORDER_STATUSES.includes(order.status)) {
      throw this.notEligible();
    }
    const ageMs = Date.now() - new Date(order.createdAt).getTime();
    if (!Number.isNaN(ageMs) && ageMs > ELIGIBLE_MS) {
      throw this.windowExpired();
    }
  }

  /**
   * Quantities already claimed by this order's PENDING/APPROVED/COMPLETED
   * returns, keyed by orderItemId (string).
   */
  async claimedPerOrderItem(orderId) {
    const claimed = new Map();
    const docs = await this.returnRepository.findMany({
      orderId,
      status: { $in: RETURN_CLAIMED_STATUSES },
    });
    for (const doc of docs) {
      for (const item of doc.items || []) {
        const key = String(item.orderItemId);
        claimed.set(key, (claimed.get(key) || 0) + item.quantity);
      }
    }
    return claimed;
  }

  /**
   * Builds the embedded item snapshots for a validated request, enforcing the
   * per-item availability rule against the order's immutable OrderItem docs.
   */
  buildItemSnapshots(order, requestedItems, claimed) {
    const byId = new Map((order.items || []).map((item) => [String(item._id || item.id), item]));
    return requestedItems.map((requested) => {
      const orderItem = byId.get(requested.orderItemId);
      if (!orderItem) {
        throw this.itemNotFound();
      }
      const claimedQuantity = claimed.get(requested.orderItemId) || 0;
      const available = orderItem.quantity - claimedQuantity;
      if (requested.quantity > available) {
        throw this.quantityExceeded();
      }
      return {
        orderItemId: requested.orderItemId,
        productId: String(orderItem.productId || ''),
        productVariantId: orderItem.productVariantId
          ? String(orderItem.productVariantId)
          : null,
        productName: orderItem.productName,
        sku: orderItem.sku ?? null,
        quantity: requested.quantity,
        unitPriceMinorUnits: orderItem.unitPriceMinorUnits,
        discountMinorUnits: orderItem.discountMinorUnits,
      };
    });
  }

  async createReturnWithRetry({
    customerId,
    orderId,
    fingerprint,
    idempotencyKey,
    items,
    reason,
    notes,
    session,
  }) {
    for (let attempt = 0; attempt <= RETURN_LIMITS.RETURN_NUMBER_RETRIES; attempt += 1) {
      try {
        return await this.returnRepository.create(
          {
            customerId,
            orderId,
            returnNumber: this.generateReturnNumber(),
            idempotencyKey,
            idempotencyFingerprint: fingerprint,
            status: RETURN_STATUSES.PENDING,
            statusHistory: [
              { status: RETURN_STATUSES.PENDING, at: new Date(), by: customerId, note: null },
            ],
            items,
            reason,
            notes: notes === undefined || notes === null ? null : notes,
          },
          { session }
        );
      } catch (err) {
        if (this.isDuplicateKeyError(err) && this.isReturnNumberConflict(err)) {
          continue;
        }
        if (this.isDuplicateKeyError(err) && this.isReturnIdempotencyConflict(err)) {
          const existing = await this.returnRepository.findOne(
            { orderId, idempotencyKey },
            { session }
          );
          if (existing) {
            if (existing.idempotencyFingerprint !== fingerprint) {
              throw this.idempotencyConflict();
            }
            return existing;
          }
          throw err;
        }
        throw err;
      }
    }
    throw this.returnNumberGenerationFailed();
  }

  /**
   * CREATE (customer, own order). Returns `{ return, created }` where
   * `created` is true only when a brand-new return record was created.
   */
  async createReturn({ customerId, orderId, value, idempotencyKey }) {
    assertObjectId(customerId, 'customerId');
    assertObjectId(orderId, 'orderId');
    if (!idempotencyKey) {
      throw this.invalidReturn('Idempotency-Key is required');
    }
    const fingerprint = this.computeFingerprint(value);

    const order = await this.orderRepository.findOne({ _id: orderId, customerId });
    if (!order) {
      throw this.returnNotFound();
    }
    this.assertReturnableOrder(order);

    const claimed = await this.claimedPerOrderItem(orderId);
    const items = this.buildItemSnapshots(order, value.items, claimed);

    const existing = await this.returnRepository.findOne({ orderId, idempotencyKey });
    if (existing) {
      if (existing.idempotencyFingerprint !== fingerprint) {
        throw this.idempotencyConflict();
      }
      return { return: serializeCustomerReturn(existing), created: false };
    }

    const created = await this.runTransaction(async (session) => {
      const doc = await this.createReturnWithRetry({
        customerId,
        orderId,
        fingerprint,
        idempotencyKey,
        items,
        reason: value.reason,
        notes: value.notes,
        session,
      });
      return doc;
    });

    return { return: serializeCustomerReturn(created), created: true };
  }

  async listCustomerReturns({ customerId, orderId, page, limit }) {
    assertObjectId(customerId, 'customerId');
    assertObjectId(orderId, 'orderId');
    const { page: safePage, limit: safeLimit, skip } = normalizePagination({ page, limit });
    const filter = { customerId, orderId };
    const [docs, total] = await Promise.all([
      this.returnRepository.findMany(filter, {
        sort: { createdAt: -1 },
        skip,
        limit: safeLimit,
      }),
      this.returnRepository.count(filter),
    ]);
    return {
      returns: docs.map((doc) => serializeCustomerReturn(doc)),
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit),
      },
    };
  }

  /**
   * DETAIL (customer, own order). A cross-customer read resolves as 404
   * RETURN_NOT_FOUND (the filter includes `customerId`).
   */
  async getCustomerReturn({ customerId, orderId, returnId }) {
    assertObjectId(customerId, 'customerId');
    assertObjectId(orderId, 'orderId');
    assertObjectId(returnId, 'returnId');
    const doc = await this.returnRepository.findOne({
      _id: returnId,
      orderId,
      customerId,
    });
    if (!doc) {
      throw this.returnNotFound();
    }
    return serializeCustomerReturn(doc);
  }

  /**
   * CANCEL (customer, own PENDING return). Only a PENDING return may be
   * cancelled by the customer; an APPROVED return needs admin intervention.
   */
  async cancelCustomerReturn({ customerId, orderId, returnId, performedBy }) {
    assertObjectId(customerId, 'customerId');
    assertObjectId(orderId, 'orderId');
    assertObjectId(returnId, 'returnId');

    const doc = await this.returnRepository.findOne({ _id: returnId, orderId, customerId });
    if (!doc) {
      throw this.returnNotFound();
    }
    if (doc.status === RETURN_STATUSES.CANCELLED) {
      return serializeCustomerReturn(doc);
    }
    if (doc.status !== RETURN_STATUSES.PENDING) {
      throw this.invalidState();
    }
    const updated = await this.performTransition({
      returnId,
      fromStatus: RETURN_STATUSES.PENDING,
      toStatus: RETURN_STATUSES.CANCELLED,
      performedBy,
      note: null,
    });
    return serializeCustomerReturn(updated);
  }

  async performTransition({ returnId, fromStatus, toStatus, performedBy, note }) {
    assertObjectId(returnId, 'returnId');
    assertObjectId(performedBy, 'performedBy');
    const now = new Date();
    const actorFields = {
      [RETURN_STATUSES.APPROVED]: ['approvedBy', 'approvedAt'],
      [RETURN_STATUSES.REJECTED]: ['rejectedBy', 'rejectedAt'],
      [RETURN_STATUSES.CANCELLED]: ['cancelledBy', 'cancelledAt'],
      [RETURN_STATUSES.COMPLETED]: ['completedBy', 'completedAt'],
    };
    const set = { status: toStatus };
    for (const [index, field] of (actorFields[toStatus] || []).entries()) {
      set[field] = index === 0 ? performedBy : now;
    }
    const updated = await this.returnRepository.conditionalTransition(
      returnId,
      fromStatus,
      {
        $set: set,
        $push: {
          statusHistory: { status: toStatus, at: now, by: performedBy, note: note || null },
        },
      }
    );
    if (!updated) {
      throw this.invalidState();
    }
    return updated;
  }

  // ---------------------------------------------------------------------
  // Admin / staff surface
  // ---------------------------------------------------------------------

  async listReturns({ status, customerId, orderId, orderNumber, dateFrom, dateTo, page, limit }) {
    const filter = {};
    if (status !== undefined && status !== null && status !== '') {
      filter.status = status;
    }
    if (customerId !== undefined && customerId !== null && customerId !== '') {
      filter.customerId = customerId;
    }
    if (orderId !== undefined && orderId !== null && orderId !== '') {
      filter.orderId = orderId;
    }
    if (orderNumber !== undefined && orderNumber !== null && orderNumber !== '') {
      const order = await this.orderRepository.findOne({ orderNumber });
      if (!order) {
        return {
          returns: [],
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
      this.returnRepository.findMany(filter, {
        sort: { createdAt: -1 },
        skip,
        limit: safeLimit,
      }),
      this.returnRepository.count(filter),
    ]);
    return {
      returns: docs.map((doc) => serializeAdminReturn(doc)),
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit),
      },
    };
  }

  async getReturn(returnId) {
    assertObjectId(returnId, 'returnId');
    const doc = await this.returnRepository.findById(returnId);
    if (!doc) {
      throw this.returnNotFound();
    }
    return serializeAdminReturn(doc);
  }

  /**
   * APPROVE (staff/admin). Idempotent when already APPROVED (or past it).
   * No refund or inventory side effect — those happen at COMPLETED.
   */
  async approveReturn({ returnId, performedBy, note }) {
    assertObjectId(returnId, 'returnId');
    assertObjectId(performedBy, 'performedBy');
    const existing = await this.returnRepository.findById(returnId);
    if (!existing) {
      throw this.returnNotFound();
    }
    if (existing.status === RETURN_STATUSES.APPROVED || existing.status === RETURN_STATUSES.COMPLETED) {
      return serializeAdminReturn(existing);
    }
    if (existing.status !== RETURN_STATUSES.PENDING) {
      throw this.invalidState();
    }
    const updated = await this.performTransition({
      returnId,
      fromStatus: RETURN_STATUSES.PENDING,
      toStatus: RETURN_STATUSES.APPROVED,
      performedBy,
      note,
    });
    return serializeAdminReturn(updated);
  }

  /**
   * REJECT (staff/admin). Idempotent when already REJECTED; APPROVED /
   * COMPLETED returns cannot be rejected (use cancel instead).
   */
  async rejectReturn({ returnId, performedBy, note }) {
    assertObjectId(returnId, 'returnId');
    assertObjectId(performedBy, 'performedBy');
    const existing = await this.returnRepository.findById(returnId);
    if (!existing) {
      throw this.returnNotFound();
    }
    if (existing.status === RETURN_STATUSES.REJECTED) {
      return serializeAdminReturn(existing);
    }
    if (existing.status !== RETURN_STATUSES.PENDING) {
      throw this.invalidState();
    }
    const updated = await this.performTransition({
      returnId,
      fromStatus: RETURN_STATUSES.PENDING,
      toStatus: RETURN_STATUSES.REJECTED,
      performedBy,
      note,
    });
    return serializeAdminReturn(updated);
  }

  /**
   * COMPLETE (staff/admin). The ONLY transition with side effects: inside ONE
   * transaction the return goes APPROVED → COMPLETED, every returned quantity
   * is restocked into ONLINE (RETURN_RESTOCK ledger movement), and the refund
   * is auto-created at PENDING with a server-derived amount. Idempotent when
   * already COMPLETED. The APPROVED → COMPLETED conditional transition is the
   * conflict point, so a concurrent retry can never double-restock.
   */
  async completeReturn({ returnId, performedBy, note }) {
    assertObjectId(returnId, 'returnId');
    assertObjectId(performedBy, 'performedBy');
    const existing = await this.returnRepository.findById(returnId);
    if (!existing) {
      throw this.returnNotFound();
    }
    if (existing.status === RETURN_STATUSES.COMPLETED) {
      return serializeAdminReturn(existing);
    }
    if (existing.status !== RETURN_STATUSES.APPROVED) {
      throw this.invalidState();
    }

    const outcome = await this.runTransaction(async (session) => {
      const updated = await this.returnRepository.conditionalTransition(
        returnId,
        RETURN_STATUSES.APPROVED,
        {
          $set: { status: RETURN_STATUSES.COMPLETED, completedBy: performedBy, completedAt: new Date() },
          $push: {
            statusHistory: {
              status: RETURN_STATUSES.COMPLETED,
              at: new Date(),
              by: performedBy,
              note: note || null,
            },
          },
        },
        { session }
      );
      if (!updated) {
        throw this.invalidState();
      }

      const order = await this.orderRepository.findById(String(updated.orderId), { session });
      if (!order) {
        throw new ApiError(
          500,
          'Linked order could not be loaded',
          ERROR_CODES.INTERNAL_ERROR
        );
      }

      for (const item of updated.items || []) {
        await this.inventoryService.restockOnlineInTransaction({
          productId: String(item.productId),
          productVariantId: item.productVariantId
            ? String(item.productVariantId)
            : null,
          quantity: item.quantity,
          reason: 'return-completed',
          referenceType: 'RETURN',
          referenceId: String(updated._id),
          performedBy,
          session,
        });
      }

      const refund = await this.refundService.createRefundInTransaction({
        return: updated,
        order,
        performedBy,
        session,
      });

      const finalized = await this.returnRepository.updateById(
        String(updated._id),
        { $set: { refundId: String(refund._id) } },
        { session }
      );
      return finalized || updated;
    });

    return serializeAdminReturn(outcome);
  }

  /**
   * CANCEL (staff/admin). PENDING or APPROVED returns may be cancelled;
   * COMPLETED / REJECTED are terminal. Because the refund + restock happen
   * ONLY at COMPLETED, cancelling an APPROVED return has nothing to undo.
   */
  async cancelReturn({ returnId, performedBy, note }) {
    assertObjectId(returnId, 'returnId');
    assertObjectId(performedBy, 'performedBy');
    const existing = await this.returnRepository.findById(returnId);
    if (!existing) {
      throw this.returnNotFound();
    }
    if (existing.status === RETURN_STATUSES.CANCELLED) {
      return serializeAdminReturn(existing);
    }
    if (
      existing.status !== RETURN_STATUSES.PENDING &&
      existing.status !== RETURN_STATUSES.APPROVED
    ) {
      throw this.invalidState();
    }
    const updated = await this.performTransition({
      returnId,
      fromStatus: existing.status,
      toStatus: RETURN_STATUSES.CANCELLED,
      performedBy,
      note,
    });
    return serializeAdminReturn(updated);
  }
}

module.exports = { ReturnService };
