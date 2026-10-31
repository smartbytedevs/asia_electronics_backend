'use strict';

/**
 * Inventory, Stock Ledger & Reservation constants (Phase 06, ADR-0014).
 *
 * Stock locations, movement (ledger) types, reservation statuses, limits, and
 * messages. Inventory is per SUBJECT and NEVER duplicates catalog data
 * (name/slug/size/color/SKU live in the catalog). A subject is either a Simple
 * Product (`productId`, `productVariantId: null`) or a ProductVariant
 * (`productId` + `productVariantId`).
 */

/**
 * The two physical stock locations. ONLINE is the storefront-visible stock
 * that can be reserved; OFFLINE is warehouse/other stock that is not sold
 * directly online.
 */
const STOCK_LOCATIONS = Object.freeze({
  ONLINE: 'ONLINE',
  OFFLINE: 'OFFLINE',
});

const STOCK_LOCATION_VALUES = Object.freeze([
  STOCK_LOCATIONS.ONLINE,
  STOCK_LOCATIONS.OFFLINE,
]);

/**
 * Immutable ledger movement types. Every mutation of an Inventory record
 * writes an InventoryMovement audit record in the SAME transaction.
 *
 * Movement `quantity` is always a POSITIVE integer magnitude. The direction
 * of the effect is carried by `fromLocation` (stock decreases) and
 * `toLocation` (stock increases):
 *
 * - INITIAL_STOCK          toLocation = seeded location
 * - STOCK_IN               toLocation = receiving location
 * - STOCK_OUT              fromLocation = source location
 * - TRANSFER               fromLocation + toLocation (locations differ)
 * - ADJUSTMENT             fromLocation (decrease) XOR toLocation (increase)
 * - RESERVATION            reservedQuantity += quantity (from ONLINE availability)
 * - RESERVATION_RELEASE    reservedQuantity -= quantity (returns to availability)
 * - RESERVATION_CONSUME    reservedQuantity -= quantity AND onlineQuantity -= quantity
 * - RETURN_RESTOCK         onlineQuantity += quantity (Phase 10, ADR-0018:
 *                          stock returned by a COMPLETED return; quantity is
 *                          a POSITIVE magnitude, toLocation = ONLINE)
 * - TRANSFER_OUT           source outlet stock -= quantity (Phase 14: an
 *                          outlet-to-outlet StockTransfer leaves its source;
 *                          `outletId` identifies the source outlet, locations
 *                          are null because the move spans two Inventory docs)
 * - TRANSFER_IN            destination outlet stock += quantity (Phase 14: an
 *                          outlet-to-outlet StockTransfer arrives at its
 *                          destination; `outletId` identifies the destination)
 *
 * Corrections are always NEW movements — there is no update/delete of a
 * movement and no generic inventory PATCH.
 */
const MOVEMENT_TYPES = Object.freeze({
  INITIAL_STOCK: 'INITIAL_STOCK',
  STOCK_IN: 'STOCK_IN',
  STOCK_OUT: 'STOCK_OUT',
  TRANSFER: 'TRANSFER',
  ADJUSTMENT: 'ADJUSTMENT',
  RESERVATION: 'RESERVATION',
  RESERVATION_RELEASE: 'RESERVATION_RELEASE',
  RESERVATION_CONSUME: 'RESERVATION_CONSUME',
  RETURN_RESTOCK: 'RETURN_RESTOCK',
  TRANSFER_OUT: 'TRANSFER_OUT',
  TRANSFER_IN: 'TRANSFER_IN',
});

const MOVEMENT_TYPE_VALUES = Object.freeze(Object.values(MOVEMENT_TYPES));

/**
 * Reservation lifecycle. ACTIVE is the only mutable state; RELEASED,
 * CONSUMED, and EXPIRED are terminal.
 *
 * - ACTIVE    → RELEASED   (reserved stock returned to availability)
 * - ACTIVE    → CONSUMED   (reserved stock physically leaves ONLINE)
 * - ACTIVE    → EXPIRED    (expiresAt passed; reserved stock released)
 */
const RESERVATION_STATUSES = Object.freeze({
  ACTIVE: 'ACTIVE',
  RELEASED: 'RELEASED',
  CONSUMED: 'CONSUMED',
  EXPIRED: 'EXPIRED',
});

const RESERVATION_STATUS_VALUES = Object.freeze(Object.values(RESERVATION_STATUSES));

const INVENTORY_LIMITS = Object.freeze({
  QUANTITY_MAX: 1_000_000_000,
  REASON_MAX: 500,
  REFERENCE_TYPE_MAX: 50,
  REFERENCE_ID_MAX: 100,
});

/**
 * Whitelist of every client-writable field per inventory command. Shared by
 * the validator and service to reject unknown/immutable/operator keys
 * (`$set`, `_id`, `performedBy`, `role`, ...). Prevents mass-assignment,
 * operator injection, and audit-tampering. The actor (`performedBy`) is ALWAYS
 * derived from `req.user`, never accepted from the request body.
 *
 * The subject of every stock command is expressed as `productId` + optional
 * `productVariantId`:
 *   - `productId` only            → Simple Product subject (variantId: null)
 *   - `productId` + `productVariantId` → ProductVariant subject
 *   - `productVariantId` only     → legacy variant subject (service resolves
 *                                   the owning productId from the variant)
 */
const INVENTORY_INPUT_FIELDS = Object.freeze({
  INITIALIZE: Object.freeze([
    'productId',
    'productVariantId',
    'outletId',
    'onlineQuantity',
    'offlineQuantity',
    'lowStockThreshold',
  ]),
  STOCK_IN: Object.freeze(['productId', 'productVariantId', 'location', 'quantity', 'reason']),
  STOCK_OUT: Object.freeze(['productId', 'productVariantId', 'location', 'quantity', 'reason']),
  TRANSFER: Object.freeze([
    'productId',
    'productVariantId',
    'fromLocation',
    'toLocation',
    'quantity',
    'reason',
  ]),
  ADJUST: Object.freeze(['productId', 'productVariantId', 'location', 'quantity', 'reason']),
  RESERVE: Object.freeze([
    'productId',
    'productVariantId',
    'quantity',
    'referenceType',
    'referenceId',
    'expiresAt',
    'metadata',
  ]),
});

const INVENTORY_MESSAGES = Object.freeze({
  LIST_FETCHED: 'Inventory retrieved successfully',
  INVENTORY_FETCHED: 'Inventory retrieved successfully',
  LOW_STOCK_FETCHED: 'Low stock inventory retrieved successfully',
  MOVEMENTS_FETCHED: 'Inventory movements retrieved successfully',
  INVENTORY_INITIALIZED: 'Inventory initialized successfully',
  STOCK_IN: 'Stock added successfully',
  STOCK_OUT: 'Stock removed successfully',
  TRANSFER_COMPLETED: 'Stock transferred successfully',
  STOCK_ADJUSTED: 'Stock adjusted successfully',
  INVENTORY_NOT_FOUND: 'Inventory not found',
  INVENTORY_ALREADY_EXISTS: 'Inventory already exists for this variant',
  INSUFFICIENT_STOCK: 'Insufficient stock for this operation',
  INSUFFICIENT_AVAILABLE_STOCK: 'Insufficient available stock for this operation',
  NEGATIVE_STOCK_FORBIDDEN: 'Stock levels cannot go below zero',
  INVALID_STOCK_QUANTITY: 'Invalid stock quantity',
  INVALID_STOCK_TRANSFER: 'Invalid stock transfer',
  INVALID_INVENTORY_OPERATION: 'Invalid inventory operation',
  VARIANT_NOT_FOUND: 'Product variant not found',
  VARIANT_INACTIVE: 'Cannot operate on an inactive product variant',
  RESERVATION_CREATED: 'Reservation created successfully',
  RESERVATION_RELEASED: 'Reservation released successfully',
  RESERVATION_CONSUMED: 'Reservation consumed successfully',
  RESERVATION_EXPIRED: 'Reservation expired successfully',
  RESERVATION_FETCHED: 'Reservation retrieved successfully',
  RESERVATIONS_FETCHED: 'Reservations retrieved successfully',
  RESERVATION_NOT_FOUND: 'Reservation not found',
  RESERVATION_NOT_ACTIVE: 'Reservation is not in an active state',
  RESERVATION_EXPIRED_MSG: 'Reservation has expired',
  RESERVATION_CONFLICT: 'Reservation conflicts with an existing active reservation',
});

module.exports = {
  STOCK_LOCATIONS,
  STOCK_LOCATION_VALUES,
  MOVEMENT_TYPES,
  MOVEMENT_TYPE_VALUES,
  RESERVATION_STATUSES,
  RESERVATION_STATUS_VALUES,
  INVENTORY_LIMITS,
  INVENTORY_INPUT_FIELDS,
  INVENTORY_MESSAGES,
};
