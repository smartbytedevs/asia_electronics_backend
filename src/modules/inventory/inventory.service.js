'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const { STOCK_LOCATIONS, MOVEMENT_TYPES, INVENTORY_MESSAGES } = require('./inventory.constants');
const { assertObjectId } = require('./inventory.validation');
const { normalizePagination } = require('./pagination');
const { withTransaction } = require('../../config/database');
const { serializeInventory, serializeInventoryMovement, serializeUninitializedProduct } = require('./inventory.serializer');

/**
 * Inventory business logic (Phase 06, ADR-0014).
 *
 * Owns the stock rules for a subject's Inventory record. A subject is either
 * a Simple Product (`productId`, `productVariantId: null`) or a ProductVariant
 * (`productId` + `productVariantId`). Legacy clients may still send
 * `productVariantId` alone — the service resolves the owning productId from
 * the variant and records it on the Inventory/movement documents.
 *
 * - One inventory per subject; initialize is idempotency-guarded
 *   (INVENTORY_ALREADY_EXISTS on a second INITIALIZE).
 * - Every mutation runs in ONE MongoDB transaction and appends an IMMUTABLE
 *   InventoryMovement ledger record in the same commit.
 * - Every mutation is an ATOMIC CONDITIONAL update in the repository
 *   (never read-check-update). Failures are mapped to domain codes:
 *
 *     STOCK_OUT / TRANSFER source shortfall:
 *       OFFLINE → INSUFFICIENT_STOCK
 *       ONLINE  → INSUFFICIENT_AVAILABLE_STOCK (respects reserved stock)
 *     ADJUSTMENT decrease shortfall:
 *       OFFLINE → NEGATIVE_STOCK_FORBIDDEN
 *       ONLINE  → INSUFFICIENT_AVAILABLE_STOCK
 *
 * - Inventory NEVER duplicates catalog data; it references
 *   `Product._id` / `ProductVariant._id`. Initializing for an INACTIVE
 *   variant or product is rejected; existing inventory stays historically
 *   readable.
 * - The actor (`performedBy`) is ALWAYS the resolved `req.user.id` passed by
 *   the controller — never a body field.
 */
class InventoryService {
  constructor({
    inventoryRepository,
    movementRepository,
    variantRepository,
    outletRepository,
    productRepository,
    runTransaction = withTransaction,
  }) {
    if (!inventoryRepository || typeof inventoryRepository.create !== 'function') {
      throw new Error('InventoryService requires an inventoryRepository');
    }
    if (!movementRepository || typeof movementRepository.create !== 'function') {
      throw new Error('InventoryService requires a movementRepository');
    }
    if (!variantRepository || typeof variantRepository.findById !== 'function') {
      throw new Error('InventoryService requires a variantRepository');
    }
    if (typeof runTransaction !== 'function') {
      throw new Error('InventoryService requires a runTransaction function');
    }
    this.inventoryRepository = inventoryRepository;
    this.movementRepository = movementRepository;
    this.variantRepository = variantRepository;
    // Optional (Phase 14): required only when initializing per-outlet stock.
    this.outletRepository = outletRepository || null;
    // Optional: required only when scoping stock to a Simple Product subject.
    this.productRepository = productRepository || null;
    this.runTransaction = runTransaction;
  }

  invalid(message) {
    return new ApiError(400, message, ERROR_CODES.INVALID_INVENTORY_OPERATION);
  }

  notFound() {
    return new ApiError(
      404,
      INVENTORY_MESSAGES.INVENTORY_NOT_FOUND,
      ERROR_CODES.INVENTORY_NOT_FOUND
    );
  }

  alreadyExists() {
    return new ApiError(
      409,
      INVENTORY_MESSAGES.INVENTORY_ALREADY_EXISTS,
      ERROR_CODES.INVENTORY_ALREADY_EXISTS
    );
  }

  insufficientStock() {
    return new ApiError(
      409,
      INVENTORY_MESSAGES.INSUFFICIENT_STOCK,
      ERROR_CODES.INSUFFICIENT_STOCK
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

  productNotFound() {
    return new ApiError(404, 'Product not found', ERROR_CODES.PRODUCT_NOT_FOUND);
  }

  productInactive() {
    return new ApiError(
      400,
      'Cannot operate on an inactive product',
      ERROR_CODES.INVALID_INVENTORY_OPERATION
    );
  }

  outletNotFound() {
    return new ApiError(404, 'Outlet not found', ERROR_CODES.OUTLET_NOT_FOUND);
  }

  outletInactive() {
    return new ApiError(
      400,
      'Cannot operate on an inactive outlet',
      ERROR_CODES.INVALID_INVENTORY_OPERATION
    );
  }

  assertActor(performedBy) {
    if (typeof performedBy !== 'string' || performedBy.length === 0) {
      throw this.invalid('performedBy is required');
    }
  }

  /**
   * Only ACTIVE variants can be initialized or reserved. The check runs
   * outside (fast fail) AND inside the transaction (consistent snapshot).
   */
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
   * Only ACTIVE products can hold Simple-Product inventory. Requires a
   * product repository (injected when Simple-Product inventory is wired).
   */
  async assertProductActive(productId, session) {
    if (!this.productRepository) {
      throw new Error('InventoryService has no productRepository — cannot scope stock to a product');
    }
    const product = await this.productRepository.findById(
      productId,
      session ? { session } : {}
    );
    if (!product) {
      throw this.productNotFound();
    }
    if (!product.isActive) {
      throw this.productInactive();
    }
    return product;
  }

  /**
   * Normalizes the SUBJECT of a stock command into `{ productId, productVariantId }`:
   *   - `productVariantId` set  → ProductVariant subject (`productId` may be null
   *                              for legacy variant-only callers)
   *   - `productVariantId` null → Simple Product subject (`productId` required)
   * Every provided id is re-validated as an ObjectId.
   */
  normalizeSubject({ productId, productVariantId }) {
    if (productVariantId !== undefined && productVariantId !== null) {
      assertObjectId(productVariantId, 'productVariantId');
      if (productId !== undefined && productId !== null) {
        assertObjectId(productId, 'productId');
      }
      return { productId: productId || null, productVariantId };
    }
    if (productId === undefined || productId === null) {
      throw this.invalid('productId or productVariantId is required');
    }
    assertObjectId(productId, 'productId');
    return { productId, productVariantId: null };
  }

  /**
   * Resolves and validates the subject for INITIALIZE inside a transaction
   * (or outside for the fast-fail pass):
   *   - Variant subject → asserts the variant is ACTIVE and (for legacy
   *     variant-only input) resolves the owning `productId` from the variant.
   *     A caller-supplied `productId` must match the variant's owning product.
   *   - Simple Product subject → asserts the product is ACTIVE.
   */
  async assertInitializeSubject(subject, session) {
    if (subject.productVariantId) {
      const variant = await this.assertVariantActive(subject.productVariantId, session);
      const owningProductId = variant && variant.productId ? String(variant.productId) : null;
      if (subject.productId && owningProductId && String(subject.productId) !== owningProductId) {
        throw this.invalid('productId does not belong to the product variant');
      }
      return { ...subject, productId: subject.productId || owningProductId };
    }
    await this.assertProductActive(subject.productId, session);
    return subject;
  }

  /**
   * Only ACTIVE outlets can hold per-outlet stock. Requires an outlet
   * repository (injected when per-outlet inventory is wired).
   */
  async assertOutletActive(outletId, session) {
    if (!this.outletRepository) {
      throw new Error('InventoryService has no outletRepository — cannot scope stock to an outlet');
    }
    const outlet = await this.outletRepository.findById(
      outletId,
      session ? { session } : {}
    );
    if (!outlet) {
      throw this.outletNotFound();
    }
    if (!outlet.isActive) {
      throw this.outletInactive();
    }
    return outlet;
  }

  isDuplicateKeyError(err) {
    return Boolean(err && err.code === 11000);
  }

  async recordMovement({
    inventoryId,
    productId = null,
    productVariantId,
    type,
    quantity,
    fromLocation = null,
    toLocation = null,
    outletId = null,
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
        outletId,
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
   * INITIALIZE: creates the Inventory record for a subject (Simple Product or
   * ProductVariant; AT an outlet when `outletId` is given) and seeds the
   * INITIAL_STOCK ledger. Idempotent guard — a second initialize for the same
   * subject/outlet is `409 INVENTORY_ALREADY_EXISTS` (use STOCK_IN to add).
   * The unique `{ productId, productVariantId, outletId }` index is the final
   * consistency layer. Outlet records must reference an ACTIVE outlet.
   */
  async initializeInventory({ productId, productVariantId, outletId = null, onlineQuantity = 0, offlineQuantity = 0, lowStockThreshold = 0, performedBy }) {
    this.assertActor(performedBy);
    const subject = this.normalizeSubject({ productId, productVariantId });
    if (outletId !== null && outletId !== undefined) {
      assertObjectId(outletId, 'outletId');
    }
    await this.assertInitializeSubject(subject);
    if (outletId) {
      await this.assertOutletActive(outletId);
    }

    let inventory;
    try {
      inventory = await this.runTransaction(async (session) => {
        const resolvedSubject = await this.assertInitializeSubject(subject, session);
        if (outletId) {
          await this.assertOutletActive(outletId, session);
        }
        // The guard matches the FULL subject (productId + productVariantId +
        // outletId) — the exact shape of the unique index — so a different
        // subject that shares only part of it is never mistaken for a duplicate.
        const existing = await this.inventoryRepository.findBySubject(
          {
            productId: resolvedSubject.productId,
            productVariantId: resolvedSubject.productVariantId || null,
            outletId: outletId || null,
          },
          { session }
        );
        if (existing) {
          throw this.alreadyExists();
        }
        const created = await this.inventoryRepository.create(
          {
            productId: resolvedSubject.productId,
            productVariantId: resolvedSubject.productVariantId || null,
            outletId: outletId || null,
            onlineQuantity,
            offlineQuantity,
            reservedQuantity: 0,
            lowStockThreshold,
          },
          { session }
        );
        for (const location of STOCK_LOCATION_ORDER(onlineQuantity, offlineQuantity)) {
          await this.recordMovement({
            inventoryId: String(created._id),
            productId: resolvedSubject.productId,
            productVariantId: resolvedSubject.productVariantId || null,
            outletId: outletId || null,
            type: MOVEMENT_TYPES.INITIAL_STOCK,
            quantity: location.quantity,
            toLocation: location.name,
            performedBy,
            session,
          });
        }
        return created;
      });
    } catch (err) {
      if (this.isDuplicateKeyError(err)) {
        throw this.alreadyExists();
      }
      throw err;
    }

    return serializeInventory(inventory);
  }

  /**
   * STOCK_IN: physically increases a location. Unconditional atomic increase.
   */
  async addStock({ productId, productVariantId, location, quantity, reason, performedBy }) {
    this.assertActor(performedBy);
    const subject = this.normalizeSubject({ productId, productVariantId });

    const inventory = await this.runTransaction(async (session) => {
      const add = subject.productVariantId
        ? this.inventoryRepository.addToLocation
        : this.inventoryRepository.addToProductLocation;
      const updated = await add.call(
        this.inventoryRepository,
        subject.productVariantId || subject.productId,
        location,
        quantity,
        { session }
      );
      if (!updated) {
        throw this.notFound();
      }
      await this.recordMovement({
        inventoryId: String(updated._id),
        productId: updated.productId ? String(updated.productId) : subject.productId || null,
        productVariantId: updated.productVariantId ? String(updated.productVariantId) : subject.productVariantId || null,
        type: MOVEMENT_TYPES.STOCK_IN,
        quantity,
        toLocation: location,
        reason,
        performedBy,
        session,
      });
      return updated;
    });

    return serializeInventory(inventory);
  }

  /**
   * STOCK_OUT: physically decreases a location. Atomic conditional decrease —
   * ONLINE must keep availableOnlineQuantity >= quantity (never dip below
   * reserved), OFFLINE must have the physical quantity.
   */
  async removeStock({ productId, productVariantId, location, quantity, reason, performedBy }) {
    this.assertActor(performedBy);
    const subject = this.normalizeSubject({ productId, productVariantId });

    const inventory = await this.runTransaction(async (session) => {
      const remove = subject.productVariantId
        ? this.inventoryRepository.removeFromLocation
        : this.inventoryRepository.removeFromProductLocation;
      const updated = await remove.call(
        this.inventoryRepository,
        subject.productVariantId || subject.productId,
        location,
        quantity,
        { session }
      );
      if (!updated) {
        throw location === STOCK_LOCATIONS.ONLINE ? this.insufficientAvailable() : this.insufficientStock();
      }
      await this.recordMovement({
        inventoryId: String(updated._id),
        productId: updated.productId ? String(updated.productId) : subject.productId || null,
        productVariantId: updated.productVariantId ? String(updated.productVariantId) : subject.productVariantId || null,
        type: MOVEMENT_TYPES.STOCK_OUT,
        quantity,
        fromLocation: location,
        reason,
        performedBy,
        session,
      });
      return updated;
    });

    return serializeInventory(inventory);
  }

  /**
   * TRANSFER: moves quantity between ONLINE and OFFLINE. Atomic conditional —
   * the source must cover the quantity (ONLINE source respects reserved).
   */
  async transferStock({ productId, productVariantId, fromLocation, toLocation, quantity, reason, performedBy }) {
    this.assertActor(performedBy);
    const subject = this.normalizeSubject({ productId, productVariantId });

    const inventory = await this.runTransaction(async (session) => {
      const transfer = subject.productVariantId
        ? this.inventoryRepository.transferBetweenLocations
        : this.inventoryRepository.transferBetweenProductLocations;
      const updated = await transfer.call(
        this.inventoryRepository,
        subject.productVariantId || subject.productId,
        fromLocation,
        toLocation,
        quantity,
        { session }
      );
      if (!updated) {
        throw fromLocation === STOCK_LOCATIONS.ONLINE ? this.insufficientAvailable() : this.insufficientStock();
      }
      await this.recordMovement({
        inventoryId: String(updated._id),
        productId: updated.productId ? String(updated.productId) : subject.productId || null,
        productVariantId: updated.productVariantId ? String(updated.productVariantId) : subject.productVariantId || null,
        type: MOVEMENT_TYPES.TRANSFER,
        quantity,
        fromLocation,
        toLocation,
        reason,
        performedBy,
        session,
      });
      return updated;
    });

    return serializeInventory(inventory);
  }

  /**
   * ADJUST: corrects a location by a SIGNED delta (positive = increase,
   * negative = decrease). A decrease is an atomic conditional update; a
   * decrease that would violate the non-negative / reserved invariants fails.
   */
  async adjustStock({ productId, productVariantId, location, quantity, reason, performedBy }) {
    this.assertActor(performedBy);
    const subject = this.normalizeSubject({ productId, productVariantId });

    const inventory = await this.runTransaction(async (session) => {
      const adjust = subject.productVariantId
        ? this.inventoryRepository.adjustLocation
        : this.inventoryRepository.adjustProductLocation;
      const updated = await adjust.call(
        this.inventoryRepository,
        subject.productVariantId || subject.productId,
        location,
        quantity,
        { session }
      );
      if (!updated) {
        if (quantity < 0) {
          throw location === STOCK_LOCATIONS.ONLINE ? this.insufficientAvailable() : this.negativeForbidden();
        }
        throw this.notFound();
      }
      await this.recordMovement({
        inventoryId: String(updated._id),
        productId: updated.productId ? String(updated.productId) : subject.productId || null,
        productVariantId: updated.productVariantId ? String(updated.productVariantId) : subject.productVariantId || null,
        type: MOVEMENT_TYPES.ADJUSTMENT,
        quantity: Math.abs(quantity),
        fromLocation: quantity < 0 ? location : null,
        toLocation: quantity < 0 ? null : location,
        reason,
        performedBy,
        session,
      });
      return updated;
    });

    return serializeInventory(inventory);
  }

  /**
   * TRANSACTION-EMBEDDED primitive for the Returns phase (Phase 10, ADR-0018).
   *
   * Restocks `quantity` back into ONLINE availability INSIDE an already-started
   * transaction (`session` REQUIRED). Called by the returns module when a
   * return completes (return APPROVED → COMPLETED), so the stock restoration,
   * the ledger movement, and the return status change commit/roll back
   * together.
   *
   * Unlike the ADMIN API paths, this primitive does NOT run its own
   * transaction, does NOT require an ACTIVE variant (restocking an inactive or
   * out-of-catalog variant must remain possible), and does NOT serialize.
   * Enforces (within the caller's session):
   *   - existing inventory record → INVENTORY_NOT_FOUND
   *   - quantity is a positive integer
   *   - one RETURN_RESTOCK movement in the same commit
   *
   * Returns the RAW updated inventory document (not serialized) so the caller
   * can read `_id` for the ledger record.
   */
  async restockOnlineInTransaction({ productId = null, productVariantId = null, quantity, reason = null, referenceType = null, referenceId = null, performedBy, session }) {
    if (!session) {
      throw new Error(
        'restockOnlineInTransaction requires a session — call it inside withTransaction(work)'
      );
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw this.invalid('quantity must be a positive integer');
    }
    const subject = this.normalizeSubject({ productId, productVariantId });

    const add = subject.productVariantId
      ? this.inventoryRepository.addToLocation
      : this.inventoryRepository.addToProductLocation;
    const inventory = await add.call(
      this.inventoryRepository,
      subject.productVariantId || subject.productId,
      STOCK_LOCATIONS.ONLINE,
      quantity,
      { session }
    );
    if (!inventory) {
      throw this.notFound();
    }

    await this.recordMovement({
      inventoryId: String(inventory._id),
      productId: inventory.productId ? String(inventory.productId) : subject.productId || null,
      productVariantId: inventory.productVariantId
        ? String(inventory.productVariantId)
        : subject.productVariantId || null,
      type: MOVEMENT_TYPES.RETURN_RESTOCK,
      quantity,
      toLocation: STOCK_LOCATIONS.ONLINE,
      reason,
      referenceType,
      referenceId,
      performedBy,
      session,
    });

    return inventory;
  }

  async getInventory(productVariantId) {
    assertObjectId(productVariantId, 'productVariantId');
    const doc = await this.inventoryRepository.findByProductVariantId(productVariantId);
    if (!doc) {
      throw this.notFound();
    }
    return serializeInventory(doc);
  }

  async listInventory({ page, limit } = {}) {
    const { page: safePage, limit: safeLimit, skip } = normalizePagination({ page, limit });

    // All records are read (not just the page) because uninitialized-product
    // coverage needs the full set of subjects that already hold inventory.
    const docs = await this.inventoryRepository.findMany({}, { sort: { createdAt: -1 } });
    const uninitialized = await this.listUninitializedProducts(docs);
    const inventory = [...docs.map((doc) => serializeInventory(doc)), ...uninitialized];
    const total = inventory.length;

    return {
      inventory: inventory.slice(skip, skip + safeLimit),
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit),
      },
    };
  }

  /**
   * Builds the synthetic "Not initialized" rows for ACTIVE products with NO
   * inventory coverage. A product is covered when it already appears in the
   * list through a real record: a variant-bearing product via a record on any
   * of its ACTIVE variants, a Simple Product via its `productVariantId: null`
   * record. Coverage derives from the existing inventory docs ONLY — this
   * NEVER creates or mutates inventory records.
   *
   * Requires a product repository and a variant repository with `findMany`
   * (both wired in production). Without them the list falls back to records
   * only, so legacy callers/tests are unaffected.
   */
  async listUninitializedProducts(inventoryDocs = []) {
    if (
      !this.productRepository ||
      typeof this.productRepository.findMany !== 'function' ||
      !this.variantRepository ||
      typeof this.variantRepository.findMany !== 'function'
    ) {
      return [];
    }

    const coveredVariantIds = new Set();
    const coveredProductIds = new Set();
    for (const doc of inventoryDocs) {
      if (doc.productVariantId) {
        coveredVariantIds.add(String(doc.productVariantId));
      } else if (doc.productId) {
        coveredProductIds.add(String(doc.productId));
      }
    }

    const products = await this.productRepository.findMany({ isActive: true });
    if (products.length === 0) {
      return [];
    }

    const productIds = products.map((product) => String(product._id || product.id));
    const variants = await this.variantRepository.findMany({
      productId: { $in: productIds },
      isActive: true,
    });
    const variantsByProduct = new Map();
    for (const variant of variants) {
      const productId = String(variant.productId);
      if (!variantsByProduct.has(productId)) {
        variantsByProduct.set(productId, []);
      }
      variantsByProduct.get(productId).push(variant);
    }

    const uninitialized = [];
    for (const product of products) {
      const productId = String(product._id || product.id);
      const activeVariants = variantsByProduct.get(productId) || [];
      const covered =
        activeVariants.length > 0
          ? activeVariants.some((variant) =>
              coveredVariantIds.has(String(variant._id || variant.id))
            )
          : coveredProductIds.has(productId);
      if (!covered) {
        uninitialized.push(serializeUninitializedProduct(product));
      }
    }
    return uninitialized;
  }

  async getLowStock() {
    const docs = await this.inventoryRepository.findLowStock({ sort: { createdAt: -1 } });
    return docs.map((doc) => serializeInventory(doc));
  }

  async getInventoryMovements(productVariantId, { page, limit } = {}) {
    assertObjectId(productVariantId, 'productVariantId');
    const existing = await this.inventoryRepository.findByProductVariantId(productVariantId);
    if (!existing) {
      throw this.notFound();
    }
    const { page: safePage, limit: safeLimit, skip } = normalizePagination({ page, limit });
    const [docs, total] = await Promise.all([
      this.movementRepository.findManyByProductVariant(productVariantId, {
        sort: { createdAt: -1 },
        skip,
        limit: safeLimit,
      }),
      this.movementRepository.count({ productVariantId }),
    ]);
    return {
      movements: docs.map((doc) => serializeInventoryMovement(doc)),
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit),
      },
    };
  }
}

/**
 * Orders the INITIAL_STOCK movements so the ledger is deterministic:
 * ONLINE first, then OFFLINE, skipping zero-quantity seeds.
 */
function STOCK_LOCATION_ORDER(onlineQuantity, offlineQuantity) {
  const seeds = [];
  if (onlineQuantity > 0) {
    seeds.push({ name: STOCK_LOCATIONS.ONLINE, quantity: onlineQuantity });
  }
  if (offlineQuantity > 0) {
    seeds.push({ name: STOCK_LOCATIONS.OFFLINE, quantity: offlineQuantity });
  }
  return seeds;
}

module.exports = { InventoryService };
