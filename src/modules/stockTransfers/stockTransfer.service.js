'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const { MOVEMENT_TYPES } = require('../inventory/inventory.constants');
const { withTransaction } = require('../../config/database');
const { normalizePagination } = require('../inventory/pagination');
const { serializeStockTransfer } = require('./stockTransfer.serializer');
const {
  STOCK_TRANSFER_MESSAGES,
  STOCK_TRANSFER_STATUSES,
} = require('./stockTransfer.constants');
const { assertObjectId } = require('./stockTransfer.validation');

/**
 * StockTransfer business logic (Phase 14).
 *
 * Moves `quantity` of ONE product variant between two PHYSICAL outlets
 * atomically:
 *
 * - The whole operation (variant/outlet assertions, source decrease,
 *   destination increase, the StockTransfer record, and the two immutable
 *   InventoryMovement audit records) runs in ONE MongoDB transaction — there
 *   is never a partial transfer.
 * - The source decrease is an ATOMIC CONDITIONAL update
 *   (`removeFromOutletStock`: `onlineQuantity >= quantity` guard), never a
 *   read-check-update, so two simultaneous transfers cannot drive source
 *   stock below zero — a loser is mapped to `409 INSUFFICIENT_STOCK`.
 * - The destination increase is an unconditional atomic upsert
 *   (`addToOutletStock`), so a transfer into an outlet without a stock record
 *   yet simply seeds it at `quantity` in the same commit.
 * - `createdBy` ALWAYS comes from `req.user.id` (passed by the controller);
 *   body `createdBy`/`status`/`completedAt`/`role` are rejected by the
 *   validator allowlist. `status` is server-set to `COMPLETED` only.
 * - Only ACTIVE outlets and ACTIVE variants can participate.
 */
class StockTransferService {
  constructor({
    transferRepository,
    inventoryRepository,
    movementRepository,
    variantRepository,
    outletRepository,
    runTransaction = withTransaction,
  }) {
    if (!transferRepository || typeof transferRepository.create !== 'function') {
      throw new Error('StockTransferService requires a transferRepository');
    }
    if (
      !inventoryRepository ||
      typeof inventoryRepository.removeFromOutletStock !== 'function' ||
      typeof inventoryRepository.addToOutletStock !== 'function'
    ) {
      throw new Error(
        'StockTransferService requires an inventoryRepository with outlet stock methods'
      );
    }
    if (!movementRepository || typeof movementRepository.create !== 'function') {
      throw new Error('StockTransferService requires a movementRepository');
    }
    if (!variantRepository || typeof variantRepository.findById !== 'function') {
      throw new Error('StockTransferService requires a variantRepository');
    }
    if (!outletRepository || typeof outletRepository.findById !== 'function') {
      throw new Error('StockTransferService requires an outletRepository');
    }
    if (typeof runTransaction !== 'function') {
      throw new Error('StockTransferService requires a runTransaction function');
    }
    this.transferRepository = transferRepository;
    this.inventoryRepository = inventoryRepository;
    this.movementRepository = movementRepository;
    this.variantRepository = variantRepository;
    this.outletRepository = outletRepository;
    this.runTransaction = runTransaction;
  }

  invalid(message) {
    return new ApiError(400, message, ERROR_CODES.INVALID_STOCK_TRANSFER);
  }

  insufficientStock() {
    return new ApiError(
      409,
      STOCK_TRANSFER_MESSAGES.INSUFFICIENT_STOCK,
      ERROR_CODES.INSUFFICIENT_STOCK
    );
  }

  outletNotFound() {
    return new ApiError(
      404,
      STOCK_TRANSFER_MESSAGES.OUTLET_NOT_FOUND,
      ERROR_CODES.OUTLET_NOT_FOUND
    );
  }

  outletInactive() {
    return new ApiError(
      400,
      STOCK_TRANSFER_MESSAGES.OUTLET_INACTIVE,
      ERROR_CODES.OUTLET_INACTIVE
    );
  }

  variantNotFound() {
    return new ApiError(
      404,
      STOCK_TRANSFER_MESSAGES.VARIANT_NOT_FOUND,
      ERROR_CODES.VARIANT_NOT_FOUND
    );
  }

  variantInactive() {
    return new ApiError(
      400,
      STOCK_TRANSFER_MESSAGES.VARIANT_INACTIVE,
      ERROR_CODES.INVALID_STOCK_TRANSFER
    );
  }

  transferNotFound() {
    return new ApiError(
      404,
      STOCK_TRANSFER_MESSAGES.TRANSFER_NOT_FOUND,
      ERROR_CODES.STOCK_TRANSFER_NOT_FOUND
    );
  }

  assertActor(performedBy) {
    if (typeof performedBy !== 'string' || performedBy.length === 0) {
      throw this.invalid('createdBy is required');
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

  async assertOutletActive(outletId, session) {
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

  /**
   * Executes one outlet-to-outlet stock transfer atomically.
   */
  async createTransfer({
    sourceOutletId,
    destinationOutletId,
    productVariantId,
    quantity,
    reason = null,
    performedBy,
  }) {
    this.assertActor(performedBy);
    assertObjectId(sourceOutletId, 'sourceOutletId');
    assertObjectId(destinationOutletId, 'destinationOutletId');
    assertObjectId(productVariantId, 'productVariantId');
    if (String(sourceOutletId) === String(destinationOutletId)) {
      throw this.invalid(STOCK_TRANSFER_MESSAGES.SAME_OUTLET);
    }
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) {
      throw this.invalid('quantity must be a positive integer');
    }

    const transfer = await this.runTransaction(async (session) => {
      await this.assertVariantActive(productVariantId, session);
      await this.assertOutletActive(sourceOutletId, session);
      await this.assertOutletActive(destinationOutletId, session);

      // Atomic conditional decrease — the concurrency guard. Returns `null`
      // when the source record is missing or cannot cover `quantity`.
      const sourceInventory = await this.inventoryRepository.removeFromOutletStock(
        productVariantId,
        sourceOutletId,
        quantity,
        { session }
      );
      if (!sourceInventory) {
        throw this.insufficientStock();
      }

      // Unconditional atomic upsert increase — seeds a missing destination
      // outlet record at `quantity` in the same commit (no partial transfer).
      const destinationInventory = await this.inventoryRepository.addToOutletStock(
        productVariantId,
        destinationOutletId,
        quantity,
        { session }
      );

      const created = await this.transferRepository.create(
        {
          sourceOutletId,
          destinationOutletId,
          productVariantId,
          quantity,
          status: STOCK_TRANSFER_STATUSES.COMPLETED,
          completedAt: new Date(),
          reason,
          createdBy: performedBy,
        },
        { session }
      );

      const referenceId = String(created._id);
      const referenceType = 'STOCK_TRANSFER';

      await this.movementRepository.create(
        {
          inventoryId: String(sourceInventory._id),
          productVariantId,
          outletId: sourceOutletId,
          type: MOVEMENT_TYPES.TRANSFER_OUT,
          quantity,
          fromLocation: null,
          toLocation: null,
          reason,
          referenceType,
          referenceId,
          performedBy,
          metadata: {},
        },
        { session }
      );

      await this.movementRepository.create(
        {
          inventoryId: String(destinationInventory._id),
          productVariantId,
          outletId: destinationOutletId,
          type: MOVEMENT_TYPES.TRANSFER_IN,
          quantity,
          fromLocation: null,
          toLocation: null,
          reason,
          referenceType,
          referenceId,
          performedBy,
          metadata: {},
        },
        { session }
      );

      return created;
    });

    return serializeStockTransfer(transfer);
  }

  async getTransfer(id) {
    assertObjectId(id, 'id');
    const doc = await this.transferRepository.findById(id);
    if (!doc) {
      throw this.transferNotFound();
    }
    return serializeStockTransfer(doc);
  }

  async listTransfers({ page, limit } = {}) {
    const { page: safePage, limit: safeLimit, skip } = normalizePagination({ page, limit });
    const [docs, total] = await Promise.all([
      this.transferRepository.findMany({}, { sort: { createdAt: -1 }, skip, limit: safeLimit }),
      this.transferRepository.count({}),
    ]);
    return {
      transfers: docs.map((doc) => serializeStockTransfer(doc)),
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit),
      },
    };
  }
}

module.exports = { StockTransferService };
