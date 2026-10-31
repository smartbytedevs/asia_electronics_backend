'use strict';

/**
 * StockTransfer constants (Phase 14 — outlet-to-outlet stock movement).
 *
 * A StockTransfer moves `quantity` of ONE product variant between two
 * PHYSICAL outlets. It executes atomically inside a MongoDB transaction and
 * appends two immutable InventoryMovement records (TRANSFER_OUT on the source
 * outlet, TRANSFER_IN on the destination outlet) in the same commit.
 */

/**
 * Transfer lifecycle. A transfer is executed synchronously: it is created in
 * its COMPLETED state (with `completedAt` set) or it never exists at all
 * (atomic rollback). The enum exists for extensibility; `status` is
 * SERVER-SET ONLY and is never accepted from a client.
 */
const STOCK_TRANSFER_STATUSES = Object.freeze({
  COMPLETED: 'COMPLETED',
});

const STOCK_TRANSFER_STATUS_VALUES = Object.freeze(
  Object.values(STOCK_TRANSFER_STATUSES)
);

const STOCK_TRANSFER_LIMITS = Object.freeze({
  QUANTITY_MAX: 1_000_000_000,
  REASON_MAX: 500,
});

/**
 * Whitelist of every client-writable field. Shared by the validator and the
 * service to reject unknown/immutable/operator keys (`$set`, `_id`,
 * `createdBy`, `status`, `completedAt`, `role`, ...). The actor
 * (`createdBy`) is ALWAYS derived from `req.user`, never from the body.
 */
const STOCK_TRANSFER_INPUT_FIELDS = Object.freeze([
  'sourceOutletId',
  'destinationOutletId',
  'productVariantId',
  'quantity',
  'reason',
]);

const STOCK_TRANSFER_MESSAGES = Object.freeze({
  LIST_FETCHED: 'Stock transfers retrieved successfully',
  TRANSFER_FETCHED: 'Stock transfer retrieved successfully',
  TRANSFER_COMPLETED: 'Stock transferred successfully',
  TRANSFER_NOT_FOUND: 'Stock transfer not found',
  INVALID_TRANSFER: 'Invalid stock transfer',
  SAME_OUTLET: 'Source and destination outlets must be different',
  INSUFFICIENT_STOCK: 'Insufficient stock at the source outlet',
  OUTLET_NOT_FOUND: 'Outlet not found',
  OUTLET_INACTIVE: 'Cannot transfer to or from an inactive outlet',
  VARIANT_NOT_FOUND: 'Product variant not found',
  VARIANT_INACTIVE: 'Cannot transfer an inactive product variant',
});

module.exports = {
  STOCK_TRANSFER_STATUSES,
  STOCK_TRANSFER_STATUS_VALUES,
  STOCK_TRANSFER_LIMITS,
  STOCK_TRANSFER_INPUT_FIELDS,
  STOCK_TRANSFER_MESSAGES,
};
