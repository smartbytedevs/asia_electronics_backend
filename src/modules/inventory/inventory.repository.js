'use strict';

const { createBaseRepository } = require('../base/base.repository');
const { STOCK_LOCATIONS } = require('./inventory.constants');

/**
 * Maps a STOCK_LOCATIONS value to the Inventory document field it mutates.
 * The schema stores `onlineQuantity`/`offlineQuantity`; every `$inc`/filter
 * key MUST go through this map so a location can never name an arbitrary
 * field (defense-in-depth on top of the validator's allowlist).
 */
const LOCATION_TO_FIELD = {
  [STOCK_LOCATIONS.ONLINE]: 'onlineQuantity',
  [STOCK_LOCATIONS.OFFLINE]: 'offlineQuantity',
};

function locationField(location) {
  const field = LOCATION_TO_FIELD[location];
  if (!field) {
    throw new Error(`Unknown stock location: ${location}`);
  }
  return field;
}

/**
 * Inventory persistence layer (Phase 06, ADR-0014).
 *
 * Encapsulates database operations only — no authorization, business rules,
 * HTTP, or response formatting. Never calls external APIs.
 *
 * CONCURRENCY (the important part): every mutation that can run out of stock
 * (stock-out, transfer, adjustment decrease, reserve, release, consume) is an
 * ATOMIC CONDITIONAL update — `findOneAndUpdate` whose filter encodes the
 * invariant and whose `$inc` applies the delta in one server-side operation.
 * The repository NEVER reads-then-writes; a concurrent request that would
 * break an invariant gets `null` and the service maps it to an
 * INSUFFICIENT_STOCK / INSUFFICIENT_AVAILABLE_STOCK / NEGATIVE_STOCK_FORBIDDEN
 * error. This is what makes reservation/transfer races safe under MongoDB
 * document-level atomicity.
 *
 * SUBJECTS: an Inventory record is scoped to a Simple Product (`productId`,
 * `productVariantId: null`) or a ProductVariant (`productId` +
 * `productVariantId`). Each mutation therefore has a variant-scoped method
 * (existing callers: reservations, returns, outlet transfers) and a
 * product-scoped twin. The ONLINE/OFFLINE pool for a simple product lives on
 * the `productId`/`productVariantId: null` record.
 */

function availableOnlineExpr(quantity) {
  return {
    $expr: {
      $gte: [{ $subtract: ['$onlineQuantity', '$reservedQuantity'] }, quantity],
    },
  };
}

// The CENTRAL / online pool record is the `outletId: null` Inventory document
// (Phase 14). Every pre-existing variant-scoped operation targets this record
// so existing storefront behavior (reservations, orders, returns) is
// unchanged; physical outlets use the dedicated outlet-scoped methods below.
const CENTRAL_POOL_FILTER = { outletId: null };

function createInventoryRepository(model) {
  const base = createBaseRepository(model);

  // One ATOMIC CONDITIONAL findOneAndUpdate for every stock mutation. The
  // invariant is part of the filter; the `$inc` applies the delta atomically.
  const findOneAndUpdate = (match, update, options = {}) =>
    model.findOneAndUpdate(match, update, { new: true, runValidators: true, ...options });

  const addToMatch = (match, location, quantity, options = {}) =>
    findOneAndUpdate(match, { $inc: { [locationField(location)]: quantity } }, options);

  const removeFromMatch = (match, location, quantity, options = {}) => {
    const field = locationField(location);
    const condition =
      field === 'onlineQuantity' ? availableOnlineExpr(quantity) : { [field]: { $gte: quantity } };
    return findOneAndUpdate(
      { ...match, ...condition },
      { $inc: { [field]: -quantity } },
      options
    );
  };

  const transferMatch = (match, fromLocation, toLocation, quantity, options = {}) => {
    const fromField = locationField(fromLocation);
    const toField = locationField(toLocation);
    const condition =
      fromField === 'onlineQuantity'
        ? availableOnlineExpr(quantity)
        : { [fromField]: { $gte: quantity } };
    return findOneAndUpdate(
      { ...match, ...condition },
      { $inc: { [fromField]: -quantity, [toField]: quantity } },
      options
    );
  };

  const adjustMatch = (match, location, delta, options = {}) => {
    const field = locationField(location);
    if (delta < 0) {
      const magnitude = -delta;
      const condition =
        field === 'onlineQuantity'
          ? availableOnlineExpr(magnitude)
          : { [field]: { $gte: magnitude } };
      return findOneAndUpdate(
        { ...match, ...condition },
        { $inc: { [field]: delta } },
        options
      );
    }
    return findOneAndUpdate(match, { $inc: { [field]: delta } }, options);
  };

  // Central-pool subject filters. A simple product stores `productVariantId: null`;
  // a variant stores `productVariantId`. Both are `outletId: null` (central pool).
  const variantPoolFilter = (productVariantId) => ({ productVariantId, ...CENTRAL_POOL_FILTER });
  const productPoolFilter = (productId) => ({ productId, productVariantId: null, ...CENTRAL_POOL_FILTER });

  return {
    ...base,

    findByProductVariantId: (productVariantId, options = {}) =>
      base.findOne(variantPoolFilter(productVariantId), options),

    /**
     * Simple-product inventory record (`productId` set, `productVariantId: null`)
     * on the CENTRAL online pool.
     */
    findByProductId: (productId, options = {}) =>
      base.findOne(productPoolFilter(productId), options),

    findByVariantAndOutlet: (productVariantId, outletId, options = {}) =>
      base.findOne({ productVariantId, outletId }, options),

    findByProductAndOutlet: (productId, outletId, options = {}) =>
      base.findOne({ productId, productVariantId: null, outletId }, options),

    /**
     * FULL-SUBJECT existence lookup used by INITIALIZE's idempotency guard.
     * The one-record-per-subject unique index is `{ productId, productVariantId,
     * outletId }`, so the guard must match that EXACT combination — never a
     * partial subject (`productVariantId` alone, or `productId` alone) which
     * would wrongly reject a DIFFERENT subject that happens to share an id.
     * A variant subject carries `productId` + `productVariantId`; a Simple
     * Product carries `productId` + `productVariantId: null`; the central
     * online pool is `outletId: null`.
     */
    findBySubject: (subject, options = {}) =>
      base.findOne(
        {
          productId: subject.productId,
          productVariantId: subject.productVariantId || null,
          outletId: subject.outletId || null,
        },
        options
      ),

    findManyByOutlet: (outletId, options = {}) =>
      base.findMany({ outletId }, options),

    /**
     * All CENTRAL pool inventory whose DERIVED available online quantity
     * (`onlineQuantity - reservedQuantity`) is at most its low-stock
     * threshold. The `$expr` filter keeps the derived value out of storage.
     * Physical-outlet records are excluded — the storefront low-stock sweep
     * only concerns the online pool.
     */
    findLowStock: (options = {}) =>
      model.find(
        {
          ...CENTRAL_POOL_FILTER,
          $expr: {
            $lte: [
              { $subtract: ['$onlineQuantity', '$reservedQuantity'] },
              '$lowStockThreshold',
            ],
          },
        },
        null,
        options
      ),

    /**
     * Unconditional physical increase (INITIAL_STOCK seed + STOCK_IN).
     * Returns the updated doc. Both locations always allow increases.
     */
    addToLocation: (productVariantId, location, quantity, options = {}) =>
      addToMatch(variantPoolFilter(productVariantId), location, quantity, options),

    /** Product-scoped twin of `addToLocation` (Simple Product subjects). */
    addToProductLocation: (productId, location, quantity, options = {}) =>
      addToMatch(productPoolFilter(productId), location, quantity, options),

    /**
     * Conditional physical decrease (STOCK_OUT). For ONLINE the removal must
     * not push availableOnline (online - reserved) below the requested
     * quantity; for OFFLINE the physical quantity must suffice. Returns the
     * updated doc, or `null` when the condition fails (insufficient stock).
     */
    removeFromLocation: (productVariantId, location, quantity, options = {}) =>
      removeFromMatch(variantPoolFilter(productVariantId), location, quantity, options),

    /** Product-scoped twin of `removeFromLocation` (Simple Product subjects). */
    removeFromProductLocation: (productId, location, quantity, options = {}) =>
      removeFromMatch(productPoolFilter(productId), location, quantity, options),

    /**
     * Conditional transfer between locations (TRANSFER). The source must
     * have enough quantity (ONLINE transfers additionally respect reserved
     * stock via availableOnlineQuantity). Returns the updated doc, or `null`
     * when the source cannot cover the transfer.
     */
    transferBetweenLocations: (
      productVariantId,
      fromLocation,
      toLocation,
      quantity,
      options = {}
    ) => transferMatch(variantPoolFilter(productVariantId), fromLocation, toLocation, quantity, options),

    /** Product-scoped twin of `transferBetweenLocations` (Simple Product subjects). */
    transferBetweenProductLocations: (
      productId,
      fromLocation,
      toLocation,
      quantity,
      options = {}
    ) => transferMatch(productPoolFilter(productId), fromLocation, toLocation, quantity, options),

    /**
     * Adjustment by a SIGNED delta (ADJUSTMENT). A positive delta only
     * increases stock and is unconditional; a negative delta must not push
     * the location below zero (ONLINE: never below reserved quantity).
     * Returns the updated doc, or `null` when the decrease cannot be applied.
     */
    adjustLocation: (productVariantId, location, delta, options = {}) =>
      adjustMatch(variantPoolFilter(productVariantId), location, delta, options),

    /** Product-scoped twin of `adjustLocation` (Simple Product subjects). */
    adjustProductLocation: (productId, location, delta, options = {}) =>
      adjustMatch(productPoolFilter(productId), location, delta, options),

    /**
     * Atomic reservation: increments reservedQuantity ONLY while
     * availableOnlineQuantity (online - reserved) covers the amount. Returns
     * the updated doc, or `null` when availability is insufficient.
     */
    reserveOnline: (productVariantId, quantity, options = {}) =>
      model.findOneAndUpdate(
        { productVariantId, ...CENTRAL_POOL_FILTER, ...availableOnlineExpr(quantity) },
        { $inc: { reservedQuantity: quantity } },
        { new: true, runValidators: true, ...options }
      ),

    /** Product-scoped twin of `reserveOnline` (Simple Product subjects). */
    reserveOnlineByProduct: (productId, quantity, options = {}) =>
      model.findOneAndUpdate(
        {
          productId,
          productVariantId: null,
          ...CENTRAL_POOL_FILTER,
          ...availableOnlineExpr(quantity),
        },
        { $inc: { reservedQuantity: quantity } },
        { new: true, runValidators: true, ...options }
      ),

    /**
     * Atomic release: decrements reservedQuantity ONLY while it covers the
     * amount. Returns the updated doc, or `null` on invariant failure.
     */
    releaseReserved: (productVariantId, quantity, options = {}) =>
      model.findOneAndUpdate(
        { productVariantId, ...CENTRAL_POOL_FILTER, reservedQuantity: { $gte: quantity } },
        { $inc: { reservedQuantity: -quantity } },
        { new: true, runValidators: true, ...options }
      ),

    /** Product-scoped twin of `releaseReserved` (Simple Product subjects). */
    releaseReservedByProduct: (productId, quantity, options = {}) =>
      model.findOneAndUpdate(
        {
          productId,
          productVariantId: null,
          ...CENTRAL_POOL_FILTER,
          reservedQuantity: { $gte: quantity },
        },
        { $inc: { reservedQuantity: -quantity } },
        { new: true, runValidators: true, ...options }
      ),

    /**
     * Atomic consume: decrements reservedQuantity AND onlineQuantity together
     * ONLY while reservedQuantity covers the amount. Returns the updated doc,
     * or `null` on invariant failure.
     */
    consumeReserved: (productVariantId, quantity, options = {}) =>
      model.findOneAndUpdate(
        { productVariantId, ...CENTRAL_POOL_FILTER, reservedQuantity: { $gte: quantity } },
        { $inc: { reservedQuantity: -quantity, onlineQuantity: -quantity } },
        { new: true, runValidators: true, ...options }
      ),

    /** Product-scoped twin of `consumeReserved` (Simple Product subjects). */
    consumeReservedByProduct: (productId, quantity, options = {}) =>
      model.findOneAndUpdate(
        {
          productId,
          productVariantId: null,
          ...CENTRAL_POOL_FILTER,
          reservedQuantity: { $gte: quantity },
        },
        { $inc: { reservedQuantity: -quantity, onlineQuantity: -quantity } },
        { new: true, runValidators: true, ...options }
      ),

    // ---------------------------------------------------------------
    // Outlet-scoped stock (Phase 14). An outlet's Inventory record stores its
    // quantity in `onlineQuantity` (reservedQuantity stays 0 — outlet stock is
    // not reservable through the storefront). The compound unique
    // { productVariantId, outletId } index is the one-record-per-outlet guard.
    // ---------------------------------------------------------------

    /**
     * Outlet initialization + stock-in: unconditional atomic increase of an
     * outlet's stock. `upsert` seeds a missing outlet record (at the schema
     * defaults, then `$inc`) in the SAME atomic operation, which is what makes
     * a transfer into a never-initialized outlet race-safe. Returns the
     * updated/created doc.
     */
    addToOutletStock: (productVariantId, outletId, quantity, options = {}) =>
      model.findOneAndUpdate(
        { productVariantId, outletId },
        { $inc: { onlineQuantity: quantity } },
        {
          new: true,
          runValidators: true,
          upsert: true,
          setDefaultsOnInsert: true,
          ...options,
        }
      ),

    /**
     * Outlet stock-out / transfer source: CONDITIONAL atomic decrease of an
     * outlet's stock — the outlet must physically cover `quantity`. Returns
     * the updated doc, or `null` when the record is missing or the outlet
     * cannot cover the amount (insufficient stock). This is the concurrency
     * guard that makes simultaneous transfers race-safe.
     */
    removeFromOutletStock: (productVariantId, outletId, quantity, options = {}) =>
      model.findOneAndUpdate(
        { productVariantId, outletId, onlineQuantity: { $gte: quantity } },
        { $inc: { onlineQuantity: -quantity } },
        { new: true, runValidators: true, ...options }
      ),
  };
}

module.exports = { createInventoryRepository, availableOnlineExpr };
