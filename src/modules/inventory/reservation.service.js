'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const {
  RESERVATION_STATUSES,
  MOVEMENT_TYPES,
  STOCK_LOCATIONS,
  INVENTORY_MESSAGES,
} = require('./inventory.constants');
const { assertObjectId } = require('./inventory.validation');
const { normalizePagination } = require('./pagination');
const { withTransaction } = require('../../config/database');
const {
  serializeReservation,
  serializeInventory,
} = require('./inventory.serializer');

/**
 * Reservation business logic (Phase 06, ADR-0014).
 *
 * Lifecycle: ACTIVE → RELEASED | CONSUMED | EXPIRED (terminal).
 * - RELEASED returns the reserved quantity to availability.
 * - CONSUMED moves the reserved quantity physically out of ONLINE.
 * - EXPIRED releases the quantity after `expiresAt` passes.
 *
 * Safety:
 * - Reserving is an ATOMIC CONDITIONAL increment on reservedQuantity
 *   (`availableOnlineQuantity >= quantity`), so concurrent reservations can
 *   never oversell. In this test environment there is no live MongoDB, so the
 *   atomic paths are exercised through repository stubs that apply the same
 *   condition (documented limitation, see docs/inventory-state-machine.md).
 * - Every state change runs in ONE transaction with the reservation status
 *   transition as the CONFLICT POINT (atomic `transitionStatus`). A caller
 *   that loses the transition re-classifies idempotently, so double
 *   release/consume/expire calls never double-mutate stock:
 *     release of RELEASED      → no-op success (retry-safe)
 *     consume of CONSUMED      → no-op success (retry-safe)
 *     expire of any terminal   → no-op success
 *     release/consume of a
 *     reservation in the OTHER terminal state → RESERVATION_NOT_ACTIVE
 *     release/consume/expire of an expired
 *     ACTIVE reservation       → auto-expires, then RESERVATION_EXPIRED
 *
 * `referenceType`/`referenceId` are a generic link to the business object
 * holding the reservation (Orders arrive in a later phase). An active
 * reservation for the same reference → RESERVATION_CONFLICT.
 */
class ReservationService {
  constructor({
    reservationRepository,
    inventoryRepository,
    movementRepository,
    variantRepository,
    runTransaction = withTransaction,
  }) {
    if (!reservationRepository || typeof reservationRepository.create !== 'function') {
      throw new Error('ReservationService requires a reservationRepository');
    }
    if (
      !inventoryRepository ||
      typeof inventoryRepository.reserveOnline !== 'function' ||
      typeof inventoryRepository.reserveOnlineByProduct !== 'function' ||
      typeof inventoryRepository.releaseReservedByProduct !== 'function' ||
      typeof inventoryRepository.consumeReservedByProduct !== 'function'
    ) {
      throw new Error('ReservationService requires an inventoryRepository');
    }
    if (!movementRepository || typeof movementRepository.create !== 'function') {
      throw new Error('ReservationService requires a movementRepository');
    }
    if (!variantRepository || typeof variantRepository.findById !== 'function') {
      throw new Error('ReservationService requires a variantRepository');
    }
    if (typeof runTransaction !== 'function') {
      throw new Error('ReservationService requires a runTransaction function');
    }
    this.reservationRepository = reservationRepository;
    this.inventoryRepository = inventoryRepository;
    this.movementRepository = movementRepository;
    this.variantRepository = variantRepository;
    this.runTransaction = runTransaction;
  }

  invalid(message) {
    return new ApiError(400, message, ERROR_CODES.INVALID_INVENTORY_OPERATION);
  }

  notFound() {
    return new ApiError(
      404,
      INVENTORY_MESSAGES.RESERVATION_NOT_FOUND,
      ERROR_CODES.RESERVATION_NOT_FOUND
    );
  }

  notActive() {
    return new ApiError(
      409,
      INVENTORY_MESSAGES.RESERVATION_NOT_ACTIVE,
      ERROR_CODES.RESERVATION_NOT_ACTIVE
    );
  }

  expired() {
    return new ApiError(
      409,
      INVENTORY_MESSAGES.RESERVATION_EXPIRED_MSG,
      ERROR_CODES.RESERVATION_EXPIRED
    );
  }

  conflict() {
    return new ApiError(
      409,
      INVENTORY_MESSAGES.RESERVATION_CONFLICT,
      ERROR_CODES.RESERVATION_CONFLICT
    );
  }

  insufficientAvailable() {
    return new ApiError(
      409,
      INVENTORY_MESSAGES.INSUFFICIENT_AVAILABLE_STOCK,
      ERROR_CODES.INSUFFICIENT_AVAILABLE_STOCK
    );
  }

  negativeForbidden() {
    return new ApiError(
      409,
      INVENTORY_MESSAGES.NEGATIVE_STOCK_FORBIDDEN,
      ERROR_CODES.NEGATIVE_STOCK_FORBIDDEN
    );
  }

  variantNotFound() {
    return new ApiError(
      404,
      INVENTORY_MESSAGES.VARIANT_NOT_FOUND,
      ERROR_CODES.VARIANT_NOT_FOUND
    );
  }

  variantInactive() {
    return new ApiError(
      400,
      INVENTORY_MESSAGES.VARIANT_INACTIVE,
      ERROR_CODES.INVALID_INVENTORY_OPERATION
    );
  }

  assertActor(performedBy) {
    if (typeof performedBy !== 'string' || performedBy.length === 0) {
      throw this.invalid('performedBy is required');
    }
  }

  async assertVariantActive(productVariantId, session) {
    const variant = await this.variantRepository.findById(
      productVariantId,
      session ? { session } : {}
    );
    if (!variant) {
      throw this.variantNotFound();
    }
    if (!variant.isActive) {
      throw this.variantInactive();
    }
    return variant;
  }

  /**
   * Normalizes the reservation subject. A subject is a Simple Product
   * (`productId` only) or a ProductVariant (`productVariantId`, optionally with
   * `productId`). Legacy variant-only callers stay valid.
   */
  normalizeSubject({ productId = null, productVariantId = null }) {
    productId = productId || null;
    productVariantId = productVariantId || null;
    if (productId) {
      assertObjectId(productId, 'productId');
    }
    if (productVariantId) {
      assertObjectId(productVariantId, 'productVariantId');
    }
    if (!productId && !productVariantId) {
      throw this.invalid('productId or productVariantId is required');
    }
    return { productId, productVariantId };
  }

  /**
   * Resolves the subject against the catalog and returns the owning productId.
   * A variant must be ACTIVE; a simple product relies on the inventory record
   * (reserve/release/consume are conditional on its existence).
   */
  async resolveSubject(subject, session) {
    if (!subject.productVariantId) {
      return { ...subject, productVariantId: null };
    }
    const variant = await this.assertVariantActive(subject.productVariantId, session);
    const owningProductId = variant && variant.productId ? String(variant.productId) : null;
    if (
      subject.productId &&
      owningProductId &&
      String(subject.productId) !== owningProductId
    ) {
      throw this.invalid('productId does not belong to the product variant');
    }
    return {
      productId: subject.productId || owningProductId,
      productVariantId: subject.productVariantId,
    };
  }

  /** Dispatches an inventory mutation to the variant- or product-scoped twin. */
  inventoryMutation(subject, variantMethod, productMethod) {
    return subject.productVariantId
      ? { method: this.inventoryRepository[variantMethod], key: subject.productVariantId }
      : { method: this.inventoryRepository[productMethod], key: subject.productId };
  }

  async reserveOnline(subject, quantity, options) {
    const { method, key } = this.inventoryMutation(
      subject,
      'reserveOnline',
      'reserveOnlineByProduct'
    );
    return method.call(this.inventoryRepository, key, quantity, options);
  }

  async releaseReserved(subject, quantity, options) {
    const { method, key } = this.inventoryMutation(
      subject,
      'releaseReserved',
      'releaseReservedByProduct'
    );
    return method.call(this.inventoryRepository, key, quantity, options);
  }

  async consumeReserved(subject, quantity, options) {
    const { method, key } = this.inventoryMutation(
      subject,
      'consumeReserved',
      'consumeReservedByProduct'
    );
    return method.call(this.inventoryRepository, key, quantity, options);
  }

  /** The subject of an EXISTING reservation (legacy rows may lack productId). */
  reservationSubject(reservation) {
    return {
      productId: reservation.productId ? String(reservation.productId) : null,
      productVariantId: reservation.productVariantId
        ? String(reservation.productVariantId)
        : null,
    };
  }

  isExpired(reservation, now = Date.now()) {
    return Boolean(reservation.expiresAt && new Date(reservation.expiresAt).getTime() <= now);
  }

  /**
   * Classifies a non-ACTIVE reservation for the caller. Returns `null` when
   * the caller's operation is idempotent-retry (RELEASED release, CONSUMED
   * consume) and throws for genuinely wrong transitions.
   */
  classifyTerminal(reservation, action) {
    const status = reservation.status;
    if (action === 'release' && status === RESERVATION_STATUSES.RELEASED) {
      return { idempotent: true };
    }
    if (action === 'consume' && status === RESERVATION_STATUSES.CONSUMED) {
      return { idempotent: true };
    }
    if (status === RESERVATION_STATUSES.EXPIRED) {
      throw this.expired();
    }
    throw this.notActive();
  }

  async recordMovement({
    inventoryId,
    productId = null,
    productVariantId = null,
    type,
    quantity,
    fromLocation = null,
    toLocation = null,
    reason = null,
    referenceType = null,
    referenceId = null,
    performedBy,
    metadata = {},
    session,
  }) {
    return this.movementRepository.create(
      {
        inventoryId,
        productId,
        productVariantId,
        type,
        quantity,
        fromLocation,
        toLocation,
        reason,
        referenceType,
        referenceId,
        performedBy,
        metadata,
      },
      { session }
    );
  }

  /**
   * CREATE: reserves `quantity` of ONLINE availability for a reference.
   * Atomic conditional increment on reservedQuantity. Requires an ACTIVE
   * variant, an existing inventory record, no duplicate ACTIVE reservation
   * for the same reference, and enough availableOnlineQuantity.
   */
  async createReservation({
    productId = null,
    productVariantId = null,
    quantity,
    referenceType,
    referenceId,
    expiresAt = null,
    metadata = {},
    performedBy,
  }) {
    this.assertActor(performedBy);
    const subject = this.normalizeSubject({ productId, productVariantId });
    await this.resolveSubject(subject);

    const reservation = await this.runTransaction(async (session) => {
      const resolved = await this.resolveSubject(subject, session);
      const duplicate = await this.reservationRepository.findActiveByReference(
        referenceType,
        referenceId,
        { session }
      );
      if (duplicate) {
        throw this.conflict();
      }

      const inventory = await this.reserveOnline(resolved, quantity, { session });
      if (!inventory) {
        throw this.insufficientAvailable();
      }

      const created = await this.reservationRepository.create(
        {
          productId: resolved.productId || null,
          productVariantId: resolved.productVariantId || null,
          quantity,
          status: RESERVATION_STATUSES.ACTIVE,
          expiresAt,
          referenceType,
          referenceId,
          metadata,
          createdBy: performedBy,
        },
        { session }
      );

      await this.recordMovement({
        inventoryId: String(inventory._id),
        productId: resolved.productId || null,
        productVariantId: resolved.productVariantId || null,
        type: MOVEMENT_TYPES.RESERVATION,
        quantity,
        fromLocation: STOCK_LOCATIONS.ONLINE,
        referenceType,
        referenceId,
        performedBy,
        session,
      });

      return created;
    });

    return serializeReservation(reservation);
  }

  /**
   * TRANSACTION-EMBEDDED primitive for the Orders phase (Phase 07, ADR-0015).
   *
   * Reserves `quantity` of ONLINE availability for a reference INSIDE an
   * already-started transaction (`session` REQUIRED). Unlike `createReservation`
   * (the ADMIN API path), this primitive does NOT run its own transaction and
   * does NOT enforce the service-level one-ACTIVE-reservation-per-reference
   * guard (`RESERVATION_CONFLICT`): the orders checkout creates exactly one
   * reservation per order line, all sharing `referenceId = orderId`, and the
   * `{referenceType, referenceId, status}` DB index is non-unique. The admin
   * reservation API and its guard are unchanged.
   *
   * Still enforces (within the caller's session, so it commits/rolls back with
   * the order):
   *   - ACTIVE variant exists → VARIANT_NOT_FOUND / invalid (inactive)
   *   - existing inventory record
   *   - `availableOnlineQuantity >= quantity` → INSUFFICIENT_AVAILABLE_STOCK
   *   - one RESERVATION ledger movement in the same commit
   *
   * Returns the RAW created reservation document (not serialized) so the caller
   * can collect `_id`s into `order.reservationReference.reservationIds`.
   */
  async createReservationInTransaction({
    productId = null,
    productVariantId = null,
    quantity,
    referenceType,
    referenceId,
    expiresAt = null,
    metadata = {},
    performedBy,
    session,
  }) {
    this.assertActor(performedBy);
    const subject = this.normalizeSubject({ productId, productVariantId });
    if (!session) {
      throw new Error(
        'createReservationInTransaction requires a session — call it inside withTransaction(work)'
      );
    }
    const resolved = await this.resolveSubject(subject, session);

    const inventory = await this.reserveOnline(resolved, quantity, { session });
    if (!inventory) {
      throw this.insufficientAvailable();
    }

    const created = await this.reservationRepository.create(
      {
        productId: resolved.productId || null,
        productVariantId: resolved.productVariantId || null,
        quantity,
        status: RESERVATION_STATUSES.ACTIVE,
        expiresAt,
        referenceType,
        referenceId,
        metadata,
        createdBy: performedBy,
      },
      { session }
    );

    await this.recordMovement({
      inventoryId: String(inventory._id),
      productId: resolved.productId || null,
      productVariantId: resolved.productVariantId || null,
      type: MOVEMENT_TYPES.RESERVATION,
      quantity,
      fromLocation: STOCK_LOCATIONS.ONLINE,
      referenceType,
      referenceId,
      performedBy,
      session,
    });

    return created;
  }

  /**
   * TRANSACTION-EMBEDDED primitive for the Orders phase (Phase 07, ADR-0015).
   *
   * Releases ONE ACTIVE reservation inside an already-started transaction
   * (`session` REQUIRED): decrements reservedQuantity, transitions the
   * reservation ACTIVE → RELEASED, and appends a RESERVATION_RELEASE movement,
   * all in the caller's session so it commits/rolls back with the order status
   * change. IDEMPOTENT and non-fatal for non-ACTIVE reservations:
   *   - reservation missing     → returns `null` (nothing to release)
   *   - already terminal        → returns the reservation untouched (no-op)
   *   - still ACTIVE            → releases it (returns the updated doc)
   * Unlike `releaseReservation` (the ADMIN API path), it does NOT classify
   * wrong terminal states as errors and does NOT run its own transaction.
   */
  async releaseReservationInTransaction({ reservationId, performedBy, session }) {
    if (!session) {
      throw new Error(
        'releaseReservationInTransaction requires a session — call it inside withTransaction(work)'
      );
    }
    const reservation = await this.reservationRepository.findById(reservationId, { session });
    if (!reservation) {
      return null;
    }
    if (reservation.status !== RESERVATION_STATUSES.ACTIVE) {
      return reservation;
    }
    const subject = this.reservationSubject(reservation);
    const inventory = await this.releaseReserved(subject, reservation.quantity, {
      session,
    });
    if (!inventory) {
      throw this.negativeForbidden();
    }
    const updated = await this.reservationRepository.transitionStatus(
      reservationId,
      RESERVATION_STATUSES.ACTIVE,
      RESERVATION_STATUSES.RELEASED,
      { resolvedAt: new Date(), resolvedBy: performedBy },
      { session }
    );
    if (!updated) {
      return reservation;
    }
    await this.recordMovement({
      inventoryId: String(inventory._id),
      productId: subject.productId || null,
      productVariantId: subject.productVariantId || null,
      type: MOVEMENT_TYPES.RESERVATION_RELEASE,
      quantity: reservation.quantity,
      toLocation: STOCK_LOCATIONS.ONLINE,
      referenceType: reservation.referenceType,
      referenceId: reservation.referenceId,
      performedBy,
      session,
    });
    return updated;
  }

  /**
   * Releases every ACTIVE reservation of an order inside one transaction
   * (used by order cancel/reject). `reservationIds` come from the order's
   * `reservationReference.reservationIds`. Idempotent per reservation.
   * Returns the raw released reservation docs.
   */
  async releaseReservationsInTransaction({ reservationIds = [], performedBy, session }) {
    if (!session) {
      throw new Error(
        'releaseReservationsInTransaction requires a session — call it inside withTransaction(work)'
      );
    }
    const released = [];
    for (const reservationId of reservationIds) {
      const doc = await this.releaseReservationInTransaction({
        reservationId: String(reservationId),
        performedBy,
        session,
      });
      if (doc) {
        released.push(doc);
      }
    }
    return released;
  }

  /**
   * TRANSACTION-EMBEDDED primitive for the Orders phase (consume analog of
   * `releaseReservationInTransaction`).
   *
   * Consumes ONE ACTIVE reservation inside an already-started transaction
   * (`session` REQUIRED): decrements reservedQuantity AND onlineQuantity
   * (RESERVATION_CONSUME), transitions the reservation ACTIVE → CONSUMED, and
   * appends a RESERVATION_CONSUME movement, all in the caller's session so it
   * commits/rolls back with the order status change. IDEMPOTENT and non-fatal
   * for non-ACTIVE reservations:
   *   - reservation missing     → returns `null` (nothing to consume)
   *   - already terminal        → returns the reservation untouched (no-op)
   *   - still ACTIVE            → consumes it (returns the updated doc)
   * Unlike `consumeReservation` (the ADMIN API path), it does NOT classify
   * wrong terminal states as errors and does NOT run its own transaction.
   */
  async consumeReservationInTransaction({ reservationId, performedBy, session }) {
    if (!session) {
      throw new Error(
        'consumeReservationInTransaction requires a session — call it inside withTransaction(work)'
      );
    }
    const reservation = await this.reservationRepository.findById(reservationId, { session });
    if (!reservation) {
      return null;
    }
    if (reservation.status !== RESERVATION_STATUSES.ACTIVE) {
      return reservation;
    }
    const subject = this.reservationSubject(reservation);
    const inventory = await this.consumeReserved(subject, reservation.quantity, {
      session,
    });
    if (!inventory) {
      throw this.negativeForbidden();
    }
    const updated = await this.reservationRepository.transitionStatus(
      reservationId,
      RESERVATION_STATUSES.ACTIVE,
      RESERVATION_STATUSES.CONSUMED,
      { resolvedAt: new Date(), resolvedBy: performedBy },
      { session }
    );
    if (!updated) {
      return reservation;
    }
    await this.recordMovement({
      inventoryId: String(inventory._id),
      productId: subject.productId || null,
      productVariantId: subject.productVariantId || null,
      type: MOVEMENT_TYPES.RESERVATION_CONSUME,
      quantity: reservation.quantity,
      fromLocation: STOCK_LOCATIONS.ONLINE,
      referenceType: reservation.referenceType,
      referenceId: reservation.referenceId,
      performedBy,
      session,
    });
    return updated;
  }

  /**
   * Consumes every ACTIVE reservation of an order inside one transaction (used
   * by the order DELIVERED transition). `reservationIds` come from the order's
   * `reservationReference.reservationIds`. Idempotent per reservation — a
   * reservation that is already CONSUMED/RELEASED is left untouched, so a
   * redelivered webhook can never double-consume stock.
   * Returns the raw consumed reservation docs.
   */
  async consumeReservationsInTransaction({ reservationIds = [], performedBy, session }) {
    if (!session) {
      throw new Error(
        'consumeReservationsInTransaction requires a session — call it inside withTransaction(work)'
      );
    }
    const consumed = [];
    for (const reservationId of reservationIds) {
      const doc = await this.consumeReservationInTransaction({
        reservationId: String(reservationId),
        performedBy,
        session,
      });
      if (doc) {
        consumed.push(doc);
      }
    }
    return consumed;
  }

  /**
   * RELEASE: returns a reservation's quantity to availability. Idempotent for
   * an already-RELEASED reservation (retry-safe); CONSUMED/EXPIRED throw.
   * An ACTIVE reservation past `expiresAt` is expired first, then the caller
   * receives RESERVATION_EXPIRED.
   */
  async releaseReservation({ reservationId, performedBy }) {
    return this.resolveReservation(reservationId, 'release', performedBy, async (reservation, session) => {
      const subject = this.reservationSubject(reservation);
      const inventory = await this.releaseReserved(subject, reservation.quantity, {
        session,
      });
      if (!inventory) {
        throw this.negativeForbidden();
      }
      await this.reservationRepository.transitionStatus(
        reservationId,
        RESERVATION_STATUSES.ACTIVE,
        RESERVATION_STATUSES.RELEASED,
        { resolvedAt: new Date(), resolvedBy: performedBy },
        { session }
      );
      await this.recordMovement({
        inventoryId: String(inventory._id),
        productId: subject.productId || null,
        productVariantId: subject.productVariantId || null,
        type: MOVEMENT_TYPES.RESERVATION_RELEASE,
        quantity: reservation.quantity,
        toLocation: STOCK_LOCATIONS.ONLINE,
        referenceType: reservation.referenceType,
        referenceId: reservation.referenceId,
        performedBy,
        session,
      });
      return inventory;
    });
  }

  /**
   * CONSUME: moves a reservation's quantity physically out of ONLINE.
   * Idempotent for an already-CONSUMED reservation; RELEASED/EXPIRED throw.
   */
  async consumeReservation({ reservationId, performedBy }) {
    return this.resolveReservation(reservationId, 'consume', performedBy, async (reservation, session) => {
      const subject = this.reservationSubject(reservation);
      const inventory = await this.consumeReserved(subject, reservation.quantity, {
        session,
      });
      if (!inventory) {
        throw this.negativeForbidden();
      }
      await this.reservationRepository.transitionStatus(
        reservationId,
        RESERVATION_STATUSES.ACTIVE,
        RESERVATION_STATUSES.CONSUMED,
        { resolvedAt: new Date(), resolvedBy: performedBy },
        { session }
      );
      await this.recordMovement({
        inventoryId: String(inventory._id),
        productId: subject.productId || null,
        productVariantId: subject.productVariantId || null,
        type: MOVEMENT_TYPES.RESERVATION_CONSUME,
        quantity: reservation.quantity,
        fromLocation: STOCK_LOCATIONS.ONLINE,
        referenceType: reservation.referenceType,
        referenceId: reservation.referenceId,
        performedBy,
        session,
      });
      return inventory;
    });
  }

  /**
   * EXPIRE: releases an ACTIVE reservation's quantity (RESERVATION_RELEASE
   * movement, reason "expired"). A reservation that is already terminal is a
   * no-op (retry/maintenance-safe).
   */
  async expireReservation({ reservationId, performedBy }) {
    this.assertActor(performedBy);
    assertObjectId(reservationId, 'reservationId');

    const existing = await this.reservationRepository.findById(reservationId);
    if (!existing) {
      throw this.notFound();
    }
    if (existing.status !== RESERVATION_STATUSES.ACTIVE) {
      return serializeReservation(existing);
    }

    const reservation = await this.runTransaction(async (session) => {
      const subject = this.reservationSubject(existing);
      const inventory = await this.releaseReserved(subject, existing.quantity, {
        session,
      });
      if (!inventory) {
        throw this.negativeForbidden();
      }
      const updated = await this.reservationRepository.transitionStatus(
        reservationId,
        RESERVATION_STATUSES.ACTIVE,
        RESERVATION_STATUSES.EXPIRED,
        { resolvedAt: new Date(), resolvedBy: performedBy },
        { session }
      );
      if (!updated) {
        return existing;
      }
      await this.recordMovement({
        inventoryId: String(inventory._id),
        productId: subject.productId || null,
        productVariantId: subject.productVariantId || null,
        type: MOVEMENT_TYPES.RESERVATION_RELEASE,
        quantity: existing.quantity,
        toLocation: STOCK_LOCATIONS.ONLINE,
        referenceType: existing.referenceType,
        referenceId: existing.referenceId,
        reason: 'expired',
        performedBy,
        session,
      });
      return updated;
    });

    return serializeReservation(reservation);
  }

  /**
   * Shared release/consume flow:
   * 1. Read + classify the current state (idempotent retries return early).
   * 2. If the reservation already expired while ACTIVE → expire it, then
   *    surface RESERVATION_EXPIRED.
   * 3. Transaction: run `work`, using the ATOMIC status transition as the
   *    conflict point. A lost race re-classifies instead of double-mutating.
   */
  async resolveReservation(reservationId, action, performedBy, work) {
    this.assertActor(performedBy);
    assertObjectId(reservationId, 'reservationId');

    const existing = await this.reservationRepository.findById(reservationId);
    if (!existing) {
      throw this.notFound();
    }

    if (existing.status !== RESERVATION_STATUSES.ACTIVE) {
      const classification = this.classifyTerminal(existing, action);
      if (classification.idempotent) {
        return { reservation: serializeReservation(existing), inventory: null };
      }
    }

    if (this.isExpired(existing)) {
      await this.expireReservation({ reservationId, performedBy });
      throw this.expired();
    }

    const outcome = await this.runTransaction(async (session) => {
      const fresh = await this.reservationRepository.findById(reservationId, { session });
      if (!fresh) {
        throw this.notFound();
      }
      if (fresh.status !== RESERVATION_STATUSES.ACTIVE) {
        const classification = this.classifyTerminal(fresh, action);
        if (classification.idempotent) {
          return { reservation: fresh, inventory: null };
        }
        if (fresh.status === RESERVATION_STATUSES.EXPIRED) {
          throw this.expired();
        }
        throw this.notActive();
      }
      if (this.isExpired(fresh)) {
        await this.expireReservation({ reservationId, performedBy });
        throw this.expired();
      }
      const inventory = await work(fresh, session);
      const updated = await this.reservationRepository.findById(reservationId, { session });
      return { reservation: updated || fresh, inventory };
    });

    return {
      reservation: serializeReservation(outcome.reservation),
      inventory: outcome.inventory ? serializeInventory(outcome.inventory) : null,
    };
  }

  async getReservation(reservationId) {
    assertObjectId(reservationId, 'reservationId');
    const doc = await this.reservationRepository.findById(reservationId);
    if (!doc) {
      throw this.notFound();
    }
    return serializeReservation(doc);
  }

  async listReservations({ productId, productVariantId, status, page, limit } = {}) {
    const filter = {};
    if (productId !== undefined && productId !== null && productId !== '') {
      assertObjectId(productId, 'productId');
      filter.productId = productId;
    }
    if (productVariantId !== undefined) {
      assertObjectId(productVariantId, 'productVariantId');
      filter.productVariantId = productVariantId;
    }
    if (status !== undefined) {
      if (!Object.values(RESERVATION_STATUSES).includes(status)) {
        throw this.invalid(
          `status must be one of: ${Object.values(RESERVATION_STATUSES).join(', ')}`
        );
      }
      filter.status = status;
    }
    const { page: safePage, limit: safeLimit, skip } = normalizePagination({ page, limit });
    const [docs, total] = await Promise.all([
      this.reservationRepository.findMany(filter, { sort: { createdAt: -1 }, skip, limit: safeLimit }),
      this.reservationRepository.count(filter),
    ]);
    return {
      reservations: docs.map((doc) => serializeReservation(doc)),
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit),
      },
    };
  }
}

module.exports = { ReservationService };
