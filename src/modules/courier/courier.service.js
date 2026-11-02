'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const { normalizePagination } = require('../../utils/pagination');
const { assertObjectId } = require('../orders/order.validation');
const { PAYMENT_METHODS, isManualPaymentMethod } = require('../orders/order.constants');
const { PAYMENT_STATUSES } = require('../payments/payment.constants');
const { canTransition } = require('./courier.state-machine');
const { isCourierProviderError } = require('./courier.errors');
const { verifyWebhookSignature } = require('./pathao/pathao.signature');
const {
  serializeAdminShipment,
  serializeCustomerShipment,
} = require('./courier.serializer');
const {
  COURIER_STATUSES,
  COURIER_STATUS_VALUES,
  RECONCILABLE_COURIER_STATUSES,
  TERMINAL_COURIER_STATUSES,
  COURIER_DISPATCHABLE_ORDER_STATUSES,
  COURIER_LIMITS,
  COURIER_MESSAGES,
} = require('./courier.constants');

function truncate(value, max) {
  if (!value) {
    return '';
  }
  return String(value).slice(0, max);
}

function isDuplicateKeyError(err) {
  return err && err.code === 11000;
}

/**
 * Courier business logic (Phase 09, ADR-0017). Provider-agnostic: it depends
 * ONLY on the provider interface (courier.provider.interface.js), so Pathao
 * and the mock provider are interchangeable without service changes.
 *
 * Provider calls (submit/cancel/status) are ALWAYS performed OUTSIDE any DB
 * transaction and serialized per-shipment by an in-process promise lock, so
 * two concurrent dispatches cannot mint two consignments at the provider.
 * All status changes then land through the ATOMIC guarded updates in
 * courierShipment.repository.js.
 *
 * Every provider error is translated to a stable HTTP ApiError; provider
 * internals never leak to clients.
 */
class CourierService {
  constructor({
    shipmentRepository,
    orderRepository,
    paymentRepository,
    provider,
    config = {},
    verifySignature = verifyWebhookSignature,
    now = Date.now,
  }) {
    if (!shipmentRepository || typeof shipmentRepository.transitionStatus !== 'function') {
      throw new Error('CourierService requires a shipmentRepository');
    }
    if (!orderRepository || typeof orderRepository.findById !== 'function') {
      throw new Error('CourierService requires an orderRepository');
    }
    if (!paymentRepository || typeof paymentRepository.findOne !== 'function') {
      throw new Error('CourierService requires a paymentRepository');
    }
    if (
      !provider ||
      typeof provider.submitShipment !== 'function' ||
      typeof provider.fetchShipmentStatus !== 'function' ||
      typeof provider.cancelShipment !== 'function' ||
      typeof provider.mapProviderStatus !== 'function'
    ) {
      throw new Error('CourierService requires a courier provider');
    }
    this.shipmentRepository = shipmentRepository;
    this.orderRepository = orderRepository;
    this.paymentRepository = paymentRepository;
    this.provider = provider;
    this.providerName = provider.name || 'unknown';
    this.defaultItemWeightKg = Number(config.defaultItemWeightKg) || 1;
    this.webhookSecret = config.webhookSecret || '';
    this.reconcileStaleAfterMs = Number(config.reconcileStaleAfterMs) || 5 * 60 * 1000;
    this.verifySignature = verifySignature;
    this.now = now;

    // In-process per-shipment submit lock (prevents concurrent double-submit).
    this._inflightSubmits = new Map();

    // Best-effort hook fired when a dispatch is CONFIRMED by the provider
    // (submitShipment succeeded) so the owning Order can move
    // CONFIRMED/PROCESSING → DISPATCHED. That is the ONLY order change the
    // courier module is allowed to make — shipment status updates (webhook /
    // reconciliation / cancel) NEVER change the Order status. Registered by
    // OrderService at construction time via onOrderDispatched.
    this._orderDispatchedHandler = null;
  }

  /**
   * Registers a handler invoked whenever a dispatch is confirmed by the
   * provider (submitShipment succeeded). The handler is best-effort: failures
   * are logged and never propagated, so a dispatch can never fail because the
   * order update failed. Registered by
   * OrderService.markOrderDispatchedByCourier at construction time.
   */
  onOrderDispatched(handler) {
    this._orderDispatchedHandler = typeof handler === 'function' ? handler : null;
  }

  // ────────────────────────── errors ──────────────────────────

  orderNotFound() {
    return new ApiError(404, 'Order not found', ERROR_CODES.ORDER_NOT_FOUND);
  }

  shipmentNotFound() {
    return new ApiError(404, COURIER_MESSAGES.SHIPMENT_NOT_FOUND, ERROR_CODES.COURIER_SHIPMENT_NOT_FOUND);
  }

  invalidState(message = COURIER_MESSAGES.INVALID_STATE) {
    return new ApiError(409, message, ERROR_CODES.COURIER_INVALID_STATE);
  }

  dispatchNotAllowed() {
    return new ApiError(
      409,
      COURIER_MESSAGES.DISPATCH_NOT_ALLOWED,
      ERROR_CODES.COURIER_DISPATCH_NOT_ALLOWED
    );
  }

  shipmentExists() {
    return new ApiError(409, COURIER_MESSAGES.SHIPMENT_EXISTS, ERROR_CODES.COURIER_SHIPMENT_EXISTS);
  }

  translateProviderError(err, operation) {
    switch (err.code) {
      case 'NOT_CONFIGURED':
        return new ApiError(
          503,
          COURIER_MESSAGES.PROVIDER_NOT_CONFIGURED,
          ERROR_CODES.COURIER_PROVIDER_NOT_CONFIGURED
        );
      case 'TRACKING_NOT_FOUND':
        return new ApiError(
          404,
          'Tracking information not found for this consignment',
          ERROR_CODES.COURIER_TRACKING_NOT_FOUND
        );
      case 'CANCEL_REJECTED':
        return new ApiError(
          409,
          'The courier provider refused this cancellation',
          ERROR_CODES.COURIER_CANCEL_REJECTED
        );
      case 'PROVIDER_REJECTED':
        return new ApiError(
          400,
          `The courier provider rejected the ${operation} request`,
          ERROR_CODES.COURIER_PROVIDER_REJECTED
        );
      default:
        return new ApiError(
          503,
          'The courier provider is temporarily unavailable',
          ERROR_CODES.COURIER_PROVIDER_UNAVAILABLE
        );
    }
  }

  // ────────────────────────── dispatch ──────────────────────────

  /**
   * Dispatch an order to the courier. Creates the shipment (one per order,
   * unique orderId) if none exists, then submits it to the provider.
   *
   * - no shipment  → create PENDING + submit
   * - PENDING      → submit (covers an earlier crash before submit)
   * - FAILED       → submit (acts as a retry)
   * - ACTIVE / CANCELLATION_FAILED → idempotent no-op (already dispatched)
   * - DELIVERED / CANCELLED        → 409 SHIPMENT_EXISTS (terminal)
   */
  async dispatchForOrder({ orderId, performedBy, note }) {
    assertObjectId(orderId, 'orderId');
    assertObjectId(performedBy, 'performedBy');

    const order = await this.orderRepository.findById(orderId);
    if (!order) {
      throw this.orderNotFound();
    }
    if (!COURIER_DISPATCHABLE_ORDER_STATUSES.includes(order.status)) {
      throw this.dispatchNotAllowed();
    }

    let shipment = await this.shipmentRepository.findByOrderId(orderId);
    if (!shipment) {
      try {
        shipment = await this.shipmentRepository.create({
          orderId,
          merchantReference: order.orderNumber,
          provider: this.providerName,
          status: COURIER_STATUSES.PENDING,
          statusHistory: [
            this._historyEntry(COURIER_STATUSES.PENDING, performedBy, 'Dispatch requested'),
          ],
          dispatch: {
            requestedBy: performedBy,
            requestedAt: new Date(this.now()),
            note: note || null,
          },
          amountToCollectMinorUnits: await this._amountToCollectMinorUnits(order),
        });
      } catch (err) {
        if (!isDuplicateKeyError(err)) {
          throw err;
        }
        shipment = await this.shipmentRepository.findByOrderId(orderId);
      }
    }

    if (TERMINAL_COURIER_STATUSES.includes(shipment.status)) {
      throw this.shipmentExists();
    }
    if (shipment.status !== COURIER_STATUSES.PENDING && shipment.status !== COURIER_STATUSES.FAILED) {
      // ACTIVE or CANCELLATION_FAILED — already handed to the provider.
      return { shipment: serializeAdminShipment(shipment) };
    }
    return this._submit({ shipment, order, performedBy });
  }

  /**
   * Retry a FAILED dispatch. The payload is rebuilt from the CURRENT order
   * (orders are immutable in this phase, so it equals the original).
   */
  async retryDispatch({ shipmentId, performedBy }) {
    assertObjectId(shipmentId, 'shipmentId');
    assertObjectId(performedBy, 'performedBy');

    const shipment = await this.shipmentRepository.findById(shipmentId);
    if (!shipment) {
      throw this.shipmentNotFound();
    }
    if (shipment.status !== COURIER_STATUSES.FAILED) {
      throw this.invalidState('Only FAILED shipments can be retried');
    }
    const order = await this.orderRepository.findById(shipment.orderId);
    if (!order) {
      throw this.orderNotFound();
    }
    return this._submit({ shipment, order, performedBy });
  }

  async _submit({ shipment, order, performedBy }) {
    const key = String(shipment._id);
    if (this._inflightSubmits.has(key)) {
      return this._inflightSubmits.get(key);
    }
    const promise = this._performSubmit({ shipment, order, performedBy }).finally(() => {
      this._inflightSubmits.delete(key);
    });
    this._inflightSubmits.set(key, promise);
    return promise;
  }

  async _performSubmit({ shipment, order, performedBy }) {
    const payload = await this._buildShipmentPayload(order);
    const attemptedAt = new Date(this.now());

    let result;
    try {
      result = await this.provider.submitShipment(payload);
    } catch (err) {
      if (!isCourierProviderError(err)) {
        throw err;
      }
      const mapped = this.translateProviderError(err, 'dispatch');
      await this.shipmentRepository.recordSubmissionFailure(shipment._id, {
        payload,
        errorCode: err.code,
        errorMessage: truncate(err.message, COURIER_LIMITS.PROVIDER_ERROR_MESSAGE_MAX),
        errorRaw: err.raw || null,
        performedBy,
        attemptedAt,
      });
      throw mapped;
    }

    const updated = await this.shipmentRepository.recordSubmissionSuccess(shipment._id, {
      consignmentId: result.consignmentId,
      providerDeliveryFeeMinorUnits: result.providerDeliveryFeeMinorUnits || 0,
      payload,
      providerStatus: result.providerStatus || null,
      providerStatusUpdatedAt: result.providerStatusUpdatedAt || null,
      submittedAt: attemptedAt,
      performedBy,
    });
    if (!updated) {
      // Lost a race (shipment moved meanwhile) — re-read and report current state.
      const fresh = (await this.shipmentRepository.findById(shipment._id)) || shipment;
      return { shipment: serializeAdminShipment(fresh) };
    }
    await this._notifyOrderDispatched(updated, performedBy, 'Dispatched to courier');
    return { shipment: serializeAdminShipment(updated) };
  }

  // ────────────────────────── cancellation ──────────────────────────

  /**
   * Cancel a shipment. PENDING/FAILED are cancelled locally (never reached the
   * provider); ACTIVE/CANCELLATION_FAILED are cancelled via the provider.
   * DELIVERED is final; CANCELLED is idempotent.
   */
  async cancelShipment({ shipmentId, performedBy }) {
    assertObjectId(shipmentId, 'shipmentId');
    assertObjectId(performedBy, 'performedBy');

    const shipment = await this.shipmentRepository.findById(shipmentId);
    if (!shipment) {
      throw this.shipmentNotFound();
    }
    if (shipment.status === COURIER_STATUSES.DELIVERED) {
      throw this.invalidState('Delivered shipments cannot be cancelled');
    }
    if (shipment.status === COURIER_STATUSES.CANCELLED) {
      return { shipment: serializeAdminShipment(shipment) };
    }

    const now = new Date(this.now());

    if (shipment.status === COURIER_STATUSES.PENDING || shipment.status === COURIER_STATUSES.FAILED) {
      const updated = await this.shipmentRepository.transitionStatus(
        shipment._id,
        shipment.status,
        COURIER_STATUSES.CANCELLED,
        this._historyEntry(COURIER_STATUSES.CANCELLED, performedBy, 'Cancelled before dispatch'),
        { 'cancel.requestedAt': now, 'cancel.confirmedAt': now }
      );
      if (!updated) {
        throw this.invalidState();
      }
      return { shipment: serializeAdminShipment(updated) };
    }

    if (!shipment.consignmentId) {
      throw this.invalidState('Shipment has no consignment id to cancel');
    }

    try {
      await this.provider.cancelShipment(shipment.consignmentId);
    } catch (err) {
      if (!isCourierProviderError(err)) {
        throw err;
      }
      const lastError = {
        code: err.code,
        message: truncate(err.message, COURIER_LIMITS.PROVIDER_ERROR_MESSAGE_MAX),
      };
      if (shipment.status === COURIER_STATUSES.ACTIVE) {
        await this.shipmentRepository.transitionStatus(
          shipment._id,
          COURIER_STATUSES.ACTIVE,
          COURIER_STATUSES.CANCELLATION_FAILED,
          this._historyEntry(COURIER_STATUSES.CANCELLATION_FAILED, performedBy, 'Provider refused cancellation'),
          { 'cancel.requestedAt': now, 'cancel.lastError': lastError }
        );
      } else {
        await this.shipmentRepository.updateById(shipment._id, {
          $set: { 'cancel.requestedAt': now, 'cancel.lastError': lastError },
        });
      }
      throw this.translateProviderError(err, 'cancellation');
    }

    const updated = await this.shipmentRepository.transitionStatus(
      shipment._id,
      shipment.status,
      COURIER_STATUSES.CANCELLED,
      this._historyEntry(COURIER_STATUSES.CANCELLED, performedBy, 'Cancelled with provider'),
      {
        'cancel.requestedAt': now,
        'cancel.confirmedAt': now,
        'cancel.lastError': null,
        'providerStatus.status': 'Cancelled',
        'providerStatus.updatedAt': now,
        'providerStatus.fetchedAt': now,
      }
    );
    if (!updated) {
      throw this.invalidState();
    }
    return { shipment: serializeAdminShipment(updated) };
  }

  /**
   * Cancel the shipment for an order — invoked by OrderService when an order is
   * cancelled (best-effort: the caller catches provider errors and proceeds).
   * Returns null when the order has no shipment.
   */
  async cancelForOrder({ orderId, performedBy }) {
    const shipment = await this.shipmentRepository.findByOrderId(orderId);
    if (!shipment) {
      return null;
    }
    if (TERMINAL_COURIER_STATUSES.includes(shipment.status)) {
      return { shipment: serializeAdminShipment(shipment) };
    }
    return this.cancelShipment({ shipmentId: shipment._id, performedBy });
  }

  // ────────────────────────── status updates ──────────────────────────

  /**
   * Ingest a provider status update (webhook or reconciliation poll). The
   * shipment is resolved by consignmentId, then merchantReference, then a
   * passed shipmentId. Unknown shipments return null (webhook is still acked).
   */
  async handleProviderStatusUpdate({
    shipmentId,
    consignmentId,
    merchantReference,
    providerStatus,
    providerStatusUpdatedAt,
    performedBy = null,
    note,
  }) {
    let shipment = null;
    if (consignmentId) {
      shipment = await this.shipmentRepository.findByConsignmentId(consignmentId);
    }
    if (!shipment && merchantReference) {
      shipment = await this.shipmentRepository.findByMerchantReference(merchantReference);
    }
    if (!shipment && shipmentId) {
      assertObjectId(shipmentId, 'shipmentId');
      shipment = await this.shipmentRepository.findById(shipmentId);
    }
    if (!shipment) {
      return null;
    }
    const localStatus = this.provider.mapProviderStatus(providerStatus);
    const updated = await this.applyProviderStatusUpdate({
      shipment,
      localStatus,
      providerStatus,
      providerStatusUpdatedAt,
      performedBy,
      note: note || `Webhook: ${providerStatus || 'status update'}`,
    });
    return updated;
  }

  /**
   * Apply a mapped local status to a shipment through the state machine. All
   * transitions use the ATOMIC guarded repository updates, so concurrent
   * webhooks cannot double-apply; a lost race falls back to a fresh read.
   */
  async applyProviderStatusUpdate({
    shipment,
    localStatus,
    providerStatus,
    providerStatusUpdatedAt,
    performedBy = null,
    note,
  }) {
    const fetchedAt = new Date(this.now());
    const snapshot = {
      'providerStatus.status': providerStatus || null,
      'providerStatus.updatedAt': providerStatusUpdatedAt || null,
      'providerStatus.fetchedAt': fetchedAt,
    };

    if (TERMINAL_COURIER_STATUSES.includes(shipment.status)) {
      const refreshed = await this.shipmentRepository.touchProviderStatus(
        shipment._id,
        snapshot
      );
      return refreshed || shipment;
    }

    let updated;
    if (localStatus === COURIER_STATUSES.DELIVERED) {
      updated = canTransition(shipment.status, COURIER_STATUSES.DELIVERED)
        ? await this.shipmentRepository.transitionStatus(
            shipment._id,
            shipment.status,
            COURIER_STATUSES.DELIVERED,
            this._historyEntry(COURIER_STATUSES.DELIVERED, performedBy, note),
            snapshot
          )
        : null;
    } else if (localStatus === COURIER_STATUSES.CANCELLED) {
      updated = canTransition(shipment.status, COURIER_STATUSES.CANCELLED)
        ? await this.shipmentRepository.transitionStatus(
            shipment._id,
            shipment.status,
            COURIER_STATUSES.CANCELLED,
            this._historyEntry(COURIER_STATUSES.CANCELLED, performedBy, note),
            { ...snapshot, 'cancel.confirmedAt': fetchedAt, 'cancel.lastError': null }
          )
        : null;
    } else {
      updated = await this.shipmentRepository.touchProviderStatus(shipment._id, snapshot);
    }

    if (!updated) {
      updated = (await this.shipmentRepository.findById(shipment._id)) || shipment;
    }
    return updated;
  }

  /**
   * Poll the provider for open shipments whose status is stale. Returns
   * `{ scanned, updated, failed }`. Provider errors on individual shipments are
   * absorbed (and the last-fetch timestamp is bumped so we do not hammer the
   * provider) — the batch keeps going.
   */
  async reconcileActiveShipments({ staleAfterMs = this.reconcileStaleAfterMs } = {}) {
    const fetchedBefore = new Date(this.now() - staleAfterMs);
    const shipments = await this.shipmentRepository.findReconcilable(
      RECONCILABLE_COURIER_STATUSES,
      fetchedBefore
    );

    let updated = 0;
    let failed = 0;
    for (const shipment of shipments) {
      if (!shipment.consignmentId) {
        failed += 1;
        continue;
      }
      try {
        const result = await this.provider.fetchShipmentStatus(shipment.consignmentId);
        await this.applyProviderStatusUpdate({
          shipment,
          localStatus: result.localStatus || COURIER_STATUSES.ACTIVE,
          providerStatus: result.providerStatus || null,
          providerStatusUpdatedAt: result.providerStatusUpdatedAt || null,
          note: 'Provider reconciliation',
        });
        updated += 1;
      } catch (err) {
        if (isCourierProviderError(err)) {
          await this.shipmentRepository
            .touchProviderStatus(shipment._id, {
              'providerStatus.fetchedAt': new Date(this.now()),
            })
            .catch(() => {});
        }
        failed += 1;
      }
    }
    return { scanned: shipments.length, updated, failed };
  }

  // ────────────────────────── reads ──────────────────────────

  async getShipment({ shipmentId }) {
    assertObjectId(shipmentId, 'shipmentId');
    const shipment = await this.shipmentRepository.findById(shipmentId);
    if (!shipment) {
      throw this.shipmentNotFound();
    }
    return { shipment: serializeAdminShipment(shipment) };
  }

  async listShipments({ status, orderId, page, limit }) {
    const pagination = normalizePagination({ page, limit });
    const filter = {};
    if (status) {
      if (!COURIER_STATUS_VALUES.includes(status)) {
        throw new ApiError(400, `Invalid status: ${status}`, ERROR_CODES.INVALID_COURIER_REQUEST);
      }
      filter.status = status;
    }
    if (orderId) {
      assertObjectId(orderId, 'orderId');
      filter.orderId = orderId;
    }
    const [docs, total] = await Promise.all([
      this.shipmentRepository.findMany(filter, {
        skip: pagination.skip,
        limit: pagination.limit,
        sort: { createdAt: -1 },
      }),
      this.shipmentRepository.count(filter),
    ]);
    return {
      shipments: docs.map(serializeAdminShipment),
      pagination: { page: pagination.page, limit: pagination.limit, total },
    };
  }

  /**
   * Customer tracking. Cross-customer reads resolve as ORDER_NOT_FOUND (never
   * 403) so order existence is not leaked. Returns `{ tracking: null }` when
   * the order has not been dispatched yet.
   */
  async getCustomerTracking({ customerId, orderId }) {
    assertObjectId(customerId, 'customerId');
    assertObjectId(orderId, 'orderId');

    const order = await this.orderRepository.findById(orderId);
    if (!order || String(order.customerId) !== String(customerId)) {
      throw this.orderNotFound();
    }
    const shipment = await this.shipmentRepository.findByOrderId(orderId);
    return { tracking: shipment ? serializeCustomerShipment(shipment) : null };
  }

  isValidWebhookSignature(signature) {
    return this.verifySignature({ signature, secret: this.webhookSecret });
  }

  /**
   * Value Pathao expects echoed in `X-Pathao-Merchant-Webhook-Integration-
   * Secret` when it verifies a callback URL. Empty until PATHAO_WEBHOOK_SECRET
   * is configured.
   */
  getWebhookIntegrationSecret() {
    return this.webhookSecret;
  }

  // ────────────────────────── internals ──────────────────────────

  _historyEntry(status, by, note) {
    return {
      status,
      at: new Date(this.now()),
      by: by || null,
      note: note || null,
    };
  }

  /**
   * Cash to collect from the recipient. COD always collects the order total.
   * Manual methods (BKASH/BANK_TRANSFER/MANUAL) collect the total UNLESS the
   * payment is actually VERIFIED — a submitted/pending/rejected payment, or no
   * payment at all, is NOT paid and the courier must collect. Non-manual
   * (CARD, gateway-reserved) methods collect nothing.
   */
  async _amountToCollectMinorUnits(order) {
    if (order.paymentMethod === PAYMENT_METHODS.COD) {
      return order.totals.grandTotalMinorUnits;
    }
    if (!isManualPaymentMethod(order.paymentMethod)) {
      return 0;
    }
    const payment = await this.paymentRepository.findOne({ orderId: order._id });
    const isVerified = Boolean(payment && payment.status === PAYMENT_STATUSES.VERIFIED);
    return isVerified ? 0 : order.totals.grandTotalMinorUnits;
  }

  /**
   * Best-effort handoff to the owning Order after a successful dispatch, so the
   * order can move CONFIRMED/PROCESSING → DISPATCHED. Failures are logged and
   * swallowed — the shipment's ACTIVE transition must never roll back because
   * the order update failed.
   */
  async _notifyOrderDispatched(shipment, performedBy, note) {
    if (!this._orderDispatchedHandler) {
      return;
    }
    const orderId = String(shipment.orderId);
    try {
      await this._orderDispatchedHandler({ orderId, performedBy, note });
    } catch (err) {
      console.error('[courier] order DISPATCHED update failed', { orderId, error: err.message });
    }
  }

  _composeAddress(address) {
    return [
      address.line1,
      address.line2,
      address.area,
      address.city,
      address.district,
      address.postalCode,
      address.country,
    ]
      .filter(Boolean)
      .join(', ');
  }

  async _buildShipmentPayload(order) {
    const address = order.delivery.address;
    const items = order.items || [];
    const totalQuantity = items.reduce((sum, item) => sum + (item.quantity || 0), 0);
    return {
      merchantReference: truncate(order.orderNumber, COURIER_LIMITS.MERCHANT_REFERENCE_MAX),
      recipientName: truncate(address.fullName, COURIER_LIMITS.RECIPIENT_NAME_MAX),
      recipientPhone: truncate(address.phone, COURIER_LIMITS.PHONE_MAX),
      recipientAddress: truncate(this._composeAddress(address), COURIER_LIMITS.ADDRESS_MAX),
      itemDescription: truncate(
        items.map((item) => `${item.productName} x${item.quantity}`).join(', '),
        COURIER_LIMITS.ITEM_DESCRIPTION_MAX
      ),
      specialInstruction: order.notes
        ? truncate(order.notes, COURIER_LIMITS.SPECIAL_INSTRUCTION_MAX)
        : null,
      itemQuantity: totalQuantity > 0 ? totalQuantity : 1,
      itemWeightKg: this.defaultItemWeightKg,
      deliveryType: 'NORMAL',
      amountToCollectMinorUnits: await this._amountToCollectMinorUnits(order),
    };
  }
}

module.exports = { CourierService };
