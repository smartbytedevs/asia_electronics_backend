'use strict';

const crypto = require('crypto');
const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const { withTransaction } = require('../../config/database');
const { assertObjectId } = require('./order.validation');
const {
  serializeCustomerOrder,
  serializeOrderStatus,
} = require('./order.serializer');
const { normalizePagination } = require('../../utils/pagination');
const { classifyDeliveryZone } = require('./delivery');
const { canTransition } = require('./order.state-machine');
const {
  ORDER_STATUSES,
  ORDER_MESSAGES,
  DELIVERY_FEES_MINOR_UNITS,
  ORDER_LIMITS,
  PAYMENT_METHODS,
} = require('./order.constants');
const { NOTIFICATION_EVENT_TYPES } = require('../notifications/notification.constants');
const {
  createMaybeNotify,
  createMaybeNotifyAdmin,
  createMaybeNotifyAdminEmail,
} = require('../notifications/notification.service');

/**
 * Fallback actor id for the COURIER-DRIVEN DISPATCHED transition (successful
 * provider dispatch), where there is no signed-in user. Must be a valid
 * 24-hex ObjectId because `performTransition` calls
 * `assertObjectId(performedBy)`.
 */
const SYSTEM_ACTOR_ID = '000000000000000000000001';

/**
 * Order business logic — customer surface (Phase 07, ADR-0015).
 *
 * Checkout runs in ONE MongoDB transaction: idempotency check → cart load →
 * catalog validation → price snapshots → zone/fee derivation → per-line ONLINE
 * stock reservation (via ReservationService.createReservationInTransaction,
 * `referenceType: 'ORDER'`, `referenceId = orderId`) → order + embedded item
 * creation → cart clear. Any failure rolls everything back — no partial
 * orders, no leaked reservations.
 *
 * Customer scoping is enforced HERE: every customer query filters on
 * `customerId`, and a cross-customer order read resolves as ORDER_NOT_FOUND
 * (never 403) to avoid leaking order existence.
 *
 * Idempotency: the `Idempotency-Key` header + unique compound index
 * `{customerId, idempotencyKey}`. A retry returns the original order; a retry
 * with a DIFFERENT request body (fingerprint mismatch) → ORDER_IDEMPOTENCY_CONFLICT.
 */
class OrderService {
  constructor({
    orderRepository,
    cartRepository,
    productRepository,
    variantRepository,
    reservationService,
    courierService = null,
    notificationService = null,
    runTransaction = withTransaction,
  }) {
    if (!orderRepository || typeof orderRepository.transitionStatus !== 'function') {
      throw new Error('OrderService requires an orderRepository');
    }
    if (!cartRepository || typeof cartRepository.findByCustomer !== 'function') {
      throw new Error('OrderService requires a cartRepository');
    }
    if (!productRepository || typeof productRepository.findById !== 'function') {
      throw new Error('OrderService requires a productRepository');
    }
    if (!variantRepository || typeof variantRepository.findById !== 'function') {
      throw new Error('OrderService requires a variantRepository');
    }
    if (
      !reservationService ||
      typeof reservationService.createReservationInTransaction !== 'function' ||
      typeof reservationService.releaseReservationsInTransaction !== 'function'
    ) {
      throw new Error('OrderService requires a reservationService');
    }
    if (typeof runTransaction !== 'function') {
      throw new Error('OrderService requires a runTransaction function');
    }
    this.orderRepository = orderRepository;
    this.cartRepository = cartRepository;
    this.productRepository = productRepository;
    this.variantRepository = variantRepository;
    this.reservationService = reservationService;
    this.courierService = courierService;
    this.notificationService = notificationService;
    this.maybeNotify = createMaybeNotify(notificationService);
    this.maybeNotifyAdmin = createMaybeNotifyAdmin(notificationService);
    this.maybeNotifyAdminEmail = createMaybeNotifyAdminEmail(notificationService);
    this.runTransaction = runTransaction;

    // Courier → order handoff (Phase 09, ADR-0017): the CourierService notifies
    // this handler when a dispatch is CONFIRMED by the provider (submitShipment
    // succeeded) so the order moves CONFIRMED/PROCESSING → DISPATCHED. That is
    // the ONLY order change the courier module is allowed to make — shipment
    // status (webhook / reconciliation / cancel) never touches the order.
    if (courierService && typeof courierService.onOrderDispatched === 'function') {
      courierService.onOrderDispatched(({ orderId, performedBy, note }) =>
        this.markOrderDispatchedByCourier({ orderId, performedBy, note })
      );
    }
  }

  /**
   * Best-effort courier cancellation after an order is cancelled. A provider
   * failure must NEVER roll back the order cancellation — the shipment keeps a
   * CANCELLATION_FAILED status and stays actionable via the admin UI.
   */
  async maybeCancelCourierShipment({ orderId, performedBy }) {
    if (!this.courierService) {
      return;
    }
    try {
      await this.courierService.cancelForOrder({ orderId, performedBy });
    } catch (err) {
      console.error('[courier] cancel for order failed', { orderId, error: err.message });
    }
  }

  /**
   * Sanitized notification payload for an order (Phase 11, ADR-0019). Builds a
   * SAFE subset of the order document — order templates only ever see these
   * fields, never the raw mongoose doc (no internal refs, no reservations).
   * The order id is carried only as `entityRef` (correlation/dedup) and is
   * never rendered as visible text.
   */
  buildOrderNotificationData(order) {
    const totals = order.totals || {};
    return {
      entityRef: String(order._id),
      customerEmail:
        order.delivery &&
        order.delivery.address &&
        order.delivery.address.email
          ? order.delivery.address.email
          : null,
      order: {
        orderNumber: order.orderNumber,
        status: order.status,
        paymentMethod: order.paymentMethod,
        createdAt: order.createdAt || null,
        notes: order.notes || null,
        grandTotalMinorUnits: totals.grandTotalMinorUnits || null,
        deliveryFeeMinorUnits: totals.deliveryFeeMinorUnits || null,
        totals: {
          itemsSubtotalMinorUnits: totals.itemsSubtotalMinorUnits || 0,
          totalDiscountMinorUnits: totals.totalDiscountMinorUnits || 0,
          deliveryFeeMinorUnits: totals.deliveryFeeMinorUnits || 0,
          grandTotalMinorUnits: totals.grandTotalMinorUnits || 0,
        },
        items: (order.items || []).map((item) => ({
          productName: item.productName,
          quantity: item.quantity,
          unitPriceMinorUnits: item.unitPriceMinorUnits,
          lineTotalMinorUnits: item.lineTotalMinorUnits,
          variantAttributes: item.variantAttributes || {},
          // Snapshot-only: orders do not capture a product image today, but the
          // customer email renders a thumbnail whenever one is provided.
          productImageUrl: item.productImageUrl || null,
        })),
        delivery: order.delivery ? { address: order.delivery.address } : null,
      },
    };
  }

  /**
   * Sanitized ADMIN notification payload for a newly placed order. Only the
   * human-readable fields the admin template needs — never Mongo ids (the
   * order id is carried as `entityRef` for correlation/dedup only) and never
   * the raw order document. The customer name comes from the delivery address
   * snapshot the customer entered at checkout.
   */
  buildAdminOrderNotificationData(order) {
    return {
      entityRef: String(order._id),
      orderNumber: order.orderNumber,
      customerName:
        order.delivery && order.delivery.address && order.delivery.address.fullName
          ? order.delivery.address.fullName
          : null,
      itemCount: (order.items || []).reduce((sum, item) => sum + (item.quantity || 0), 0),
      grandTotalMinorUnits: order.totals ? order.totals.grandTotalMinorUnits : null,
      paymentMethod: order.paymentMethod,
    };
  }

  /**
   * Sanitized payload for the admin NEW ORDER email (Phase 11, ADR-0019). A
   * SAFE subset of the order document — every field is derived from the
   * customer's checkout input or server-computed totals, never from the raw
   * mongoose doc (no internal refs, no reservations, no customer/user ids).
   * The order id is carried only as `entityRef` (correlation/dedup + the admin
   * dashboard deep link); it is never rendered as visible text.
   */
  buildAdminEmailOrderNotificationData(order) {
    const address = order.delivery && order.delivery.address ? order.delivery.address : {};
    const totals = order.totals || {};
    return {
      entityRef: String(order._id),
      orderNumber: order.orderNumber,
      createdAt: order.createdAt || null,
      status: order.status,
      paymentMethod: order.paymentMethod,
      paymentStatus: this.paymentStatusLabel(order.paymentMethod),
      customerName: address.fullName || null,
      customerPhone: address.phone || null,
      customerEmail: address.email || null,
      address: {
        line1: address.line1 || null,
        line2: address.line2 || null,
        city: address.city || null,
        area: address.area || null,
        district: address.district || null,
        postalCode: address.postalCode || null,
        country: address.country || null,
      },
      notes: order.notes || null,
      totals: {
        itemsSubtotalMinorUnits: totals.itemsSubtotalMinorUnits || 0,
        totalDiscountMinorUnits: totals.totalDiscountMinorUnits || 0,
        deliveryFeeMinorUnits: totals.deliveryFeeMinorUnits || 0,
        grandTotalMinorUnits: totals.grandTotalMinorUnits || 0,
      },
      items: (order.items || []).map((item) => ({
        productName: item.productName,
        variantAttributes: item.variantAttributes || {},
        quantity: item.quantity,
        unitPriceMinorUnits: item.unitPriceMinorUnits,
        lineTotalMinorUnits: item.lineTotalMinorUnits,
      })),
    };
  }

  /**
   * Human-readable payment status for the admin NEW ORDER email. COD is
   * collected on delivery; every other method awaits the customer's manual
   * submission + verification.
   */
  paymentStatusLabel(paymentMethod) {
    return paymentMethod === PAYMENT_METHODS.COD
      ? 'Pending — collect on delivery'
      : 'Awaiting payment';
  }

  orderNotFound() {
    return new ApiError(404, ORDER_MESSAGES.ORDER_NOT_FOUND, ERROR_CODES.ORDER_NOT_FOUND);
  }

  invalidOrder(message) {
    return new ApiError(400, message, ERROR_CODES.INVALID_ORDER);
  }

  cartEmpty() {
    return new ApiError(400, ORDER_MESSAGES.CART_EMPTY, ERROR_CODES.CART_EMPTY);
  }

  cartNotFound() {
    return new ApiError(404, ORDER_MESSAGES.CART_EMPTY, ERROR_CODES.CART_NOT_FOUND);
  }

  invalidCartItem() {
    return new ApiError(
      404,
      'A cart item references an unavailable product',
      ERROR_CODES.INVALID_CART_ITEM
    );
  }

  idempotencyConflict() {
    return new ApiError(
      409,
      ORDER_MESSAGES.IDEMPOTENCY_CONFLICT,
      ERROR_CODES.ORDER_IDEMPOTENCY_CONFLICT
    );
  }

  orderNumberGenerationFailed() {
    return new ApiError(
      500,
      ORDER_MESSAGES.ORDER_NUMBER_GENERATION_FAILED,
      ERROR_CODES.ORDER_NUMBER_GENERATION_FAILED
    );
  }

  cancellationNotAllowed() {
    return new ApiError(
      409,
      ORDER_MESSAGES.CANCELLATION_NOT_ALLOWED,
      ERROR_CODES.ORDER_CANCELLATION_NOT_ALLOWED
    );
  }

  confirmationNotAllowed() {
    return new ApiError(
      409,
      ORDER_MESSAGES.CONFIRMATION_NOT_ALLOWED,
      ERROR_CODES.ORDER_CONFIRMATION_NOT_ALLOWED
    );
  }

  processingNotAllowed() {
    return new ApiError(
      409,
      ORDER_MESSAGES.PROCESSING_NOT_ALLOWED,
      ERROR_CODES.ORDER_PROCESSING_NOT_ALLOWED
    );
  }

  dispatchNotAllowed() {
    return new ApiError(
      409,
      ORDER_MESSAGES.DISPATCHING_NOT_ALLOWED,
      ERROR_CODES.ORDER_INVALID_STATE
    );
  }

  returnNotAllowed() {
    return new ApiError(
      409,
      ORDER_MESSAGES.RETURN_NOT_ALLOWED,
      ERROR_CODES.ORDER_INVALID_STATE
    );
  }

  paymentVerificationRequired() {
    return new ApiError(
      409,
      ORDER_MESSAGES.PAYMENT_VERIFICATION_REQUIRED,
      ERROR_CODES.ORDER_CONFIRMATION_NOT_ALLOWED
    );
  }

  rejectionNotAllowed() {
    return new ApiError(
      409,
      ORDER_MESSAGES.REJECTION_NOT_ALLOWED,
      ERROR_CODES.ORDER_REJECTION_NOT_ALLOWED
    );
  }

  shippingNotAllowed() {
    return new ApiError(
      409,
      ORDER_MESSAGES.SHIPPING_NOT_ALLOWED,
      ERROR_CODES.ORDER_INVALID_STATE
    );
  }

  deliveryNotAllowed() {
    return new ApiError(
      409,
      ORDER_MESSAGES.DELIVERY_NOT_ALLOWED,
      ERROR_CODES.ORDER_INVALID_STATE
    );
  }

  completionNotAllowed() {
    return new ApiError(
      409,
      ORDER_MESSAGES.COMPLETION_NOT_ALLOWED,
      ERROR_CODES.ORDER_INVALID_STATE
    );
  }

  invalidState() {
    return new ApiError(409, ORDER_MESSAGES.INVALID_STATE, ERROR_CODES.ORDER_INVALID_STATE);
  }

  /**
   * Stable fingerprint of the normalized checkout request. Stored on the
   * order and compared on retries: same key + same body → return the original
   * order; same key + different body → ORDER_IDEMPOTENCY_CONFLICT. The
   * fingerprint covers the REQUEST, not server-derived values (totals/zone/fee
   * may legitimately change between retries if the catalog changed).
   */
  computeFingerprint({ delivery, notes, paymentMethod }) {
    return crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          address: delivery.address,
          notes: notes === undefined || notes === null ? null : notes,
          paymentMethod,
        })
      )
      .digest('hex');
  }

  generateOrderNumber(date = new Date()) {
    const ymd = date.toISOString().slice(0, 10).replace(/-/g, '');
    const sequence = String(Math.floor(Math.random() * 1_000_000)).padStart(
      ORDER_LIMITS.ORDER_NUMBER_SEQUENCE_WIDTH,
      '0'
    );
    return `${ORDER_LIMITS.ORDER_NUMBER_PREFIX}${ymd}-${sequence}`;
  }

  isDuplicateKeyError(err) {
    return Boolean(
      err &&
        (err.code === 11000 ||
          (typeof err.name === 'string' && err.name.includes('MongoServerError'))) &&
        err.keyPattern
    );
  }

  isOrderNumberConflict(err) {
    return Boolean(
      err && err.keyPattern && Object.prototype.hasOwnProperty.call(err.keyPattern, 'orderNumber')
    );
  }

  isIdempotencyConflict(err) {
    return Boolean(
      err &&
        err.keyPattern &&
        Object.prototype.hasOwnProperty.call(err.keyPattern, 'idempotencyKey')
    );
  }

  async findActiveVariant(productId, session) {
    const options = session ? { session } : {};
    if (typeof this.variantRepository.findOneByProduct === 'function') {
      return this.variantRepository.findOneByProduct(
        productId,
        { isActive: true },
        options
      );
    }
    const variants = await this.variantRepository.findByProduct(productId, options);
    return (variants || []).find((variant) => variant.isActive) || null;
  }

  /**
   * Validates one cart line against the live catalog. A line is either a
   * ProductVariant (`productVariantId` set) or a Simple Product
   * (`productVariantId: null`, `productId` set). A product-only line is
   * rejected when the product has active variants — checkout never picks a
   * variant on the customer's behalf.
   */
  async assertCartLine(item, session) {
    const options = session ? { session } : {};
    const productVariantId = item.productVariantId
      ? String(item.productVariantId)
      : null;
    const cartProductId = item.productId ? String(item.productId) : null;

    if (productVariantId) {
      const variant = await this.variantRepository.findById(productVariantId, options);
      if (!variant || !variant.isActive) {
        throw this.invalidCartItem();
      }
      if (cartProductId && cartProductId !== String(variant.productId)) {
        throw this.invalidCartItem();
      }
      const product = await this.productRepository.findById(
        String(variant.productId),
        options
      );
      if (!product || !product.isActive) {
        throw this.invalidCartItem();
      }
      return { product, variant };
    }

    if (!cartProductId) {
      throw this.invalidCartItem();
    }
    const product = await this.productRepository.findById(cartProductId, options);
    if (!product || !product.isActive) {
      throw this.invalidCartItem();
    }
    if (await this.findActiveVariant(cartProductId, session)) {
      throw this.invalidCartItem();
    }
    return { product, variant: null };
  }

  /**
   * CHECKOUT: creates an order from the customer's cart in ONE transaction.
   */
  async checkout({ customerId, delivery, notes, paymentMethod, idempotencyKey }) {
    assertObjectId(customerId, 'customerId');
    if (!idempotencyKey) {
      throw this.invalidOrder('Idempotency-Key is required');
    }
    const fingerprint = this.computeFingerprint({ delivery, notes, paymentMethod });

    const outcome = await this.runTransaction(async (session) => {
      const existing = await this.orderRepository.findByIdempotencyKey(
        customerId,
        idempotencyKey,
        { session }
      );
      if (existing) {
        if (existing.idempotencyFingerprint !== fingerprint) {
          throw this.idempotencyConflict();
        }
        return { order: existing, isRetry: true };
      }

      const cart = await this.cartRepository.findByCustomer(customerId, { session });
      if (!cart) {
        throw this.cartNotFound();
      }
      if (cart.isCheckedOut || !cart.items || cart.items.length === 0) {
        throw this.cartEmpty();
      }

      const lines = [];
      for (const item of cart.items) {
        const { product, variant } = await this.assertCartLine(item, session);
        lines.push(
          this.buildOrderItem(product, variant, item.quantity, item.selectedSize)
        );
      }

      // The customer's delivery-charge selection is honored when provided
      // (validated against the enum at the boundary); otherwise the zone falls
      // back to the server-side address classification. The fee is ALWAYS read
      // from DELIVERY_FEES_MINOR_UNITS — never from the client.
      const zone = delivery.zone || classifyDeliveryZone(delivery.address);
      const deliveryFee = DELIVERY_FEES_MINOR_UNITS[zone];
      const totals = this.computeTotals(lines, deliveryFee);

      const order = await this.createOrderWithRetry({
        customerId,
        fingerprint,
        idempotencyKey,
        delivery,
        notes,
        paymentMethod,
        zone,
        deliveryFee,
        totals,
        lines,
        session,
      });

      const reservationIds = [];
      for (const line of lines) {
        const reservation = await this.reservationService.createReservationInTransaction({
          productId: String(line.productId),
          productVariantId: line.productVariantId
            ? String(line.productVariantId)
            : null,
          quantity: line.quantity,
          referenceType: 'ORDER',
          referenceId: String(order._id),
          metadata: { orderId: String(order._id) },
          performedBy: customerId,
          session,
        });
        reservationIds.push(reservation._id);
      }

      const updated = await this.orderRepository.updateById(
        String(order._id),
        {
          $set: {
            reservationReference: { reservationIds, referenceType: 'ORDER' },
          },
        },
        { session }
      );

      await this.cartRepository.markCheckedOutAndClear(customerId, { session });

      return { order: updated || order, isRetry: false };
    });

    if (!outcome.isRetry) {
      await this.maybeNotify({
        userId: customerId,
        eventType: NOTIFICATION_EVENT_TYPES.ORDER_PLACED,
        data: this.buildOrderNotificationData(outcome.order),
      });
      await this.maybeNotifyAdmin({
        userId: customerId,
        eventType: NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED,
        data: this.buildAdminOrderNotificationData(outcome.order),
      });
      await this.maybeNotifyAdminEmail({
        userId: customerId,
        eventType: NOTIFICATION_EVENT_TYPES.ADMIN_ORDER_PLACED_EMAIL,
        data: this.buildAdminEmailOrderNotificationData(outcome.order),
        // Email-only: the admin NEW ORDER email must still be delivered, but it
        // is NOT an in-app notification, so no Notification record is created.
        persist: false,
      });
    }

    return {
      order: serializeCustomerOrder(outcome.order),
      isRetry: outcome.isRetry,
    };
  }

  buildOrderItem(product, variant, quantity, selectedSize = null) {
    const basePrice = variant
      ? this.variantBasePrice(variant, product)
      : product.sellingPrice;
    const unitPrice = this.effectiveSellingPrice(basePrice, product.discount);
    const discountPerUnit = Math.max(0, basePrice - unitPrice);
    // Snapshot the size the customer actually picked. When `selectedSize` is
    // set, the embedded item records the single chosen size (e.g. "S") instead
    // of the variant's packed attribute value (e.g. "L, M, S").
    const { replaceVariantSize } = require('../products/variants/variantSizes');
    return {
      productId: product._id,
      productVariantId: variant ? variant._id : null,
      productName: product.name,
      variantAttributes: variant
        ? replaceVariantSize(variant.attributes || {}, selectedSize)
        : {},
      sku: variant ? variant.sku : product.stockKeepingUnit ?? null,
      quantity,
      unitPriceMinorUnits: unitPrice,
      discountMinorUnits: discountPerUnit,
      lineTotalMinorUnits: unitPrice * quantity,
    };
  }

  /**
   * Effective unit price (percentage/fixed discount) — delegated to the
   * product serializer so Phase 05 pricing rules stay centralized.
   */
  effectiveSellingPrice(basePrice, discount) {
    // Lazy require to keep this module free of a top-level product import
    // (both stay dependency-light and testable with stubs).
    const { computeEffectiveSellingPrice } = require('../products/product.serializer');
    return computeEffectiveSellingPrice(basePrice, discount);
  }

  variantBasePrice(variant, product) {
    if (typeof variant.sellingPriceOverride === 'number') {
      return variant.sellingPriceOverride;
    }
    return product.sellingPrice;
  }

  computeTotals(lines, deliveryFee) {
    const itemsSubtotal = lines.reduce((sum, line) => sum + line.lineTotalMinorUnits, 0);
    const totalDiscount = lines.reduce(
      (sum, line) => sum + line.discountMinorUnits * line.quantity,
      0
    );
    return {
      itemsSubtotalMinorUnits: itemsSubtotal,
      totalDiscountMinorUnits: totalDiscount,
      deliveryFeeMinorUnits: deliveryFee,
      grandTotalMinorUnits: itemsSubtotal - totalDiscount + deliveryFee,
    };
  }

  async createOrderWithRetry({
    customerId,
    fingerprint,
    idempotencyKey,
    delivery,
    notes,
    paymentMethod,
    zone,
    deliveryFee,
    totals,
    lines,
    session,
  }) {
    for (let attempt = 0; attempt <= ORDER_LIMITS.ORDER_NUMBER_RETRIES; attempt += 1) {
      try {
        return await this.orderRepository.create(
          {
            customerId,
            orderNumber: this.generateOrderNumber(),
            idempotencyKey,
            idempotencyFingerprint: fingerprint,
            status: ORDER_STATUSES.PENDING,
            statusHistory: [
              { status: ORDER_STATUSES.PENDING, at: new Date(), by: customerId, note: null },
            ],
            delivery: {
              address: delivery.address,
              zone,
              deliveryFeeMinorUnits: deliveryFee,
            },
            totals,
            items: lines,
            reservationReference: null,
            paymentMethod,
            notes: notes === undefined || notes === null ? null : notes,
          },
          { session }
        );
      } catch (err) {
        if (this.isDuplicateKeyError(err) && this.isOrderNumberConflict(err)) {
          continue;
        }
        if (this.isDuplicateKeyError(err) && this.isIdempotencyConflict(err)) {
          const existing = await this.orderRepository.findByIdempotencyKey(
            customerId,
            idempotencyKey,
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
    throw this.orderNumberGenerationFailed();
  }

  async releaseOrderReservations(order, performedBy, session) {
    const ref = order.reservationReference;
    if (!ref || !ref.reservationIds || ref.reservationIds.length === 0) {
      return;
    }
    await this.reservationService.releaseReservationsInTransaction({
      reservationIds: ref.reservationIds,
      performedBy,
      session,
    });
  }

  /**
   * Consumes every ACTIVE reservation of an order inside the caller's
   * transaction (order DELIVERED). Idempotent per reservation — already
   * terminal reservations are left untouched, so stock is consumed exactly once.
   */
  async consumeOrderReservations(order, performedBy, session) {
    const ref = order.reservationReference;
    if (!ref || !ref.reservationIds || ref.reservationIds.length === 0) {
      return;
    }
    await this.reservationService.consumeReservationsInTransaction({
      reservationIds: ref.reservationIds,
      performedBy,
      session,
    });
  }

  /**
   * Shared atomic status transition used by cancel (customer), the admin order
   * service, and the courier DISPATCHED handoff. The transition is a
   * conditional update guarded on `fromStatus`; a lost race surfaces
   * `notAllowedError` (the caller supplies the exact code for its action).
   * Side effects in the SAME transaction:
   *   - CANCELLED/REJECTED/RETURNED → release the order's ACTIVE reservations.
   *   - DELIVERED                    → consume the order's ACTIVE reservations
   *                                    (stock physically leaves ONLINE exactly once).
   */
  async performTransition({ orderId, fromStatus, toStatus, performedBy, note, notAllowedError }) {
    assertObjectId(orderId, 'orderId');
    assertObjectId(performedBy, 'performedBy');

    const existing = await this.orderRepository.findById(orderId);
    if (!existing) {
      throw this.orderNotFound();
    }
    if (existing.status !== fromStatus) {
      throw notAllowedError;
    }

    const historyEntry = { status: toStatus, at: new Date(), by: performedBy, note: note || null };

    return this.runTransaction(async (session) => {
      const updated = await this.orderRepository.transitionStatus(
        orderId,
        fromStatus,
        toStatus,
        historyEntry,
        { session }
      );
      if (!updated) {
        throw notAllowedError;
      }
      if (
        toStatus === ORDER_STATUSES.CANCELLED ||
        toStatus === ORDER_STATUSES.REJECTED ||
        toStatus === ORDER_STATUSES.RETURNED
      ) {
        await this.releaseOrderReservations(updated, performedBy, session);
      }
      if (toStatus === ORDER_STATUSES.DELIVERED) {
        await this.consumeOrderReservations(updated, performedBy, session);
      }
      return updated;
    });
  }

  /**
   * COURIER-DRIVEN DISPATCHED (successful provider dispatch, Phase 09,
   * ADR-0017). Registered as the CourierService.onOrderDispatched handler.
   * Best-effort: moves the order CONFIRMED/PROCESSING → DISPATCHED only.
   * Orders already DISPATCHED/SHIPPED are a no-op, and orders in any other
   * state are left untouched so staff control is never overridden.
   */
  async markOrderDispatchedByCourier({ orderId, performedBy = null, note }) {
    assertObjectId(orderId, 'orderId');
    const order = await this.orderRepository.findById(orderId);
    if (!order) {
      throw this.orderNotFound();
    }
    if (
      order.status === ORDER_STATUSES.DISPATCHED ||
      order.status === ORDER_STATUSES.SHIPPED ||
      order.status === ORDER_STATUSES.DELIVERED ||
      order.status === ORDER_STATUSES.COMPLETED
    ) {
      return order;
    }
    if (!canTransition(order.status, ORDER_STATUSES.DISPATCHED)) {
      return order;
    }
    return this.performTransition({
      orderId,
      fromStatus: order.status,
      toStatus: ORDER_STATUSES.DISPATCHED,
      performedBy: performedBy || SYSTEM_ACTOR_ID,
      note: note || 'Order dispatched to courier',
      notAllowedError: this.dispatchNotAllowed(),
    });
  }

  /**
   * CANCEL (customer, own order). Allowed from any reachable pre-delivery
   * status (PENDING/CONFIRMED/PROCESSING/DISPATCHED/SHIPPED); DELIVERED and
   * COMPLETED are terminal and cannot be cancelled. Releasing reservations
   * happens inside performTransition.
   */
  async cancelCustomerOrder({ customerId, orderId, performedBy }) {
    assertObjectId(customerId, 'customerId');
    assertObjectId(orderId, 'orderId');

    const order = await this.orderRepository.findOne({ _id: orderId, customerId });
    if (!order) {
      throw this.orderNotFound();
    }
    if (!canTransition(order.status, ORDER_STATUSES.CANCELLED)) {
      throw this.cancellationNotAllowed();
    }

    const updated = await this.performTransition({
      orderId,
      fromStatus: order.status,
      toStatus: ORDER_STATUSES.CANCELLED,
      performedBy,
      note: null,
      notAllowedError: this.cancellationNotAllowed(),
    });

    await this.maybeCancelCourierShipment({ orderId, performedBy });
    await this.maybeNotify({
      userId: customerId,
      eventType: NOTIFICATION_EVENT_TYPES.ORDER_CANCELLED,
      data: this.buildOrderNotificationData(updated),
    });
    return serializeCustomerOrder(updated);
  }

  /**
   * HISTORY (customer, own orders). Newest first.
   */
  async listCustomerOrders({ customerId, page, limit }) {
    assertObjectId(customerId, 'customerId');
    const { page: safePage, limit: safeLimit, skip } = normalizePagination({ page, limit });
    const filter = { customerId };
    const [docs, total] = await Promise.all([
      this.orderRepository.findMany(filter, {
        sort: { createdAt: -1 },
        skip,
        limit: safeLimit,
      }),
      this.orderRepository.count(filter),
    ]);
    return {
      orders: docs.map((doc) => serializeCustomerOrder(doc)),
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
   * ORDER_NOT_FOUND (the filter includes `customerId`).
   */
  async getCustomerOrder({ customerId, orderId }) {
    assertObjectId(customerId, 'customerId');
    assertObjectId(orderId, 'orderId');
    const doc = await this.orderRepository.findOne({ _id: orderId, customerId });
    if (!doc) {
      throw this.orderNotFound();
    }
    return serializeCustomerOrder(doc);
  }

  /**
   * PUBLIC order-status lookup (`GET /orders/status`). Requires the delivery
   * phone to match the stored order, so an order is NEVER revealed by its
   * identifier alone. A wrong phone or an unknown identifier resolves as the
   * same 404 ORDER_NOT_FOUND — the error cannot distinguish which input was
   * wrong, so order existence is not leaked.
   */
  async lookupOrderStatus({ orderId, orderNumber, phone }) {
    if (typeof phone !== 'string' || phone.trim() === '') {
      throw this.orderNotFound();
    }
    const order =
      orderId != null
        ? await this.orderRepository.findById(orderId)
        : await this.orderRepository.findByOrderNumber(orderNumber);
    if (!order) {
      throw this.orderNotFound();
    }
    const storedPhone = order.delivery && order.delivery.address
      ? order.delivery.address.phone
      : '';
    if (normalizePhoneForLookup(storedPhone) !== normalizePhoneForLookup(phone)) {
      throw this.orderNotFound();
    }
    return serializeOrderStatus(order);
  }
}

/**
 * Normalizes a phone for status-lookup comparison: keeps only digits and maps
 * an international `880` prefix to the local `0` form, so `+8801712...`,
 * `8801712...`, and `01712...` all match the same stored number.
 */
function normalizePhoneForLookup(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const digits = value.replace(/\D/g, '');
  if (digits.length === 13 && digits.startsWith('880')) {
    return `0${digits.slice(3)}`;
  }
  return digits;
}

module.exports = { OrderService };
