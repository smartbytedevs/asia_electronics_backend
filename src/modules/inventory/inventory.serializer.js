'use strict';

/**
 * Inventory serialization (Phase 06, ADR-0014).
 *
 * Centralizes the DERIVED inventory quantities (never stored):
 *
 *   availableOnlineQuantity = onlineQuantity - reservedQuantity
 *   totalPhysicalQuantity   = onlineQuantity + offlineQuantity
 *   isLowStock              = availableOnlineQuantity <= lowStockThreshold
 *   isOutOfStock            = availableOnlineQuantity <= 0
 *
 * Never serializes `_id`, `__v`, or any internal/MongoDB detail. These
 * endpoints are ADMIN-only, but the serializer still exposes no
 * authentication or purchase data.
 */

function availableOnlineQuantity(inventory) {
  return Number(inventory.onlineQuantity || 0) - Number(inventory.reservedQuantity || 0);
}

function totalPhysicalQuantity(inventory) {
  return Number(inventory.onlineQuantity || 0) + Number(inventory.offlineQuantity || 0);
}

function isLowStock(inventory) {
  return availableOnlineQuantity(inventory) <= Number(inventory.lowStockThreshold || 0);
}

function isOutOfStock(inventory) {
  return availableOnlineQuantity(inventory) <= 0;
}

function serializeInventory(inventory) {
  return {
    id: String(inventory._id || inventory.id),
    productId: inventory.productId ? String(inventory.productId) : null,
    productVariantId: inventory.productVariantId ? String(inventory.productVariantId) : null,
    outletId: inventory.outletId ? String(inventory.outletId) : null,
    isInitialized: true,
    onlineQuantity: inventory.onlineQuantity,
    offlineQuantity: inventory.offlineQuantity,
    reservedQuantity: inventory.reservedQuantity,
    availableOnlineQuantity: availableOnlineQuantity(inventory),
    totalPhysicalQuantity: totalPhysicalQuantity(inventory),
    isLowStock: isLowStock(inventory),
    isOutOfStock: isOutOfStock(inventory),
    lowStockThreshold: inventory.lowStockThreshold,
    createdAt: inventory.createdAt ? new Date(inventory.createdAt).toISOString() : null,
    updatedAt: inventory.updatedAt ? new Date(inventory.updatedAt).toISOString() : null,
  };
}

/**
 * Synthetic "Not initialized" row for an ACTIVE product that has NO inventory
 * record (neither a Simple-Product record with `productVariantId: null` nor a
 * record for any of its variants). The inventory list returns these so admins
 * can see and initialize stock for catalog products that were never set up.
 * NO inventory record is created by listing — the `id` is `null` and every
 * quantity is `0`. Initialization must go through `POST /inventory/initialize`.
 */
function serializeUninitializedProduct(product) {
  return {
    id: null,
    productId: String(product._id || product.id),
    productVariantId: null,
    outletId: null,
    isInitialized: false,
    productName: product.name || null,
    onlineQuantity: 0,
    offlineQuantity: 0,
    reservedQuantity: 0,
    availableOnlineQuantity: 0,
    totalPhysicalQuantity: 0,
    isLowStock: true,
    isOutOfStock: true,
    lowStockThreshold: 0,
    createdAt: null,
    updatedAt: null,
  };
}

function serializeInventoryMovement(movement) {
  return {
    id: String(movement._id || movement.id),
    inventoryId: String(movement.inventoryId || ''),
    productId: movement.productId ? String(movement.productId) : null,
    productVariantId: movement.productVariantId ? String(movement.productVariantId) : null,
    outletId: movement.outletId ? String(movement.outletId) : null,
    type: movement.type,
    quantity: movement.quantity,
    fromLocation: movement.fromLocation || null,
    toLocation: movement.toLocation || null,
    reason: movement.reason || null,
    referenceType: movement.referenceType || null,
    referenceId: movement.referenceId || null,
    performedBy: String(movement.performedBy || ''),
    createdAt: movement.createdAt ? new Date(movement.createdAt).toISOString() : null,
  };
}

function serializeReservation(reservation) {
  return {
    id: String(reservation._id || reservation.id),
    productId: reservation.productId ? String(reservation.productId) : null,
    productVariantId: reservation.productVariantId
      ? String(reservation.productVariantId)
      : null,
    quantity: reservation.quantity,
    status: reservation.status,
    expiresAt: reservation.expiresAt ? new Date(reservation.expiresAt).toISOString() : null,
    referenceType: reservation.referenceType,
    referenceId: reservation.referenceId,
    metadata: reservation.metadata || {},
    createdBy: String(reservation.createdBy || ''),
    resolvedAt: reservation.resolvedAt ? new Date(reservation.resolvedAt).toISOString() : null,
    resolvedBy: reservation.resolvedBy ? String(reservation.resolvedBy) : null,
    createdAt: reservation.createdAt ? new Date(reservation.createdAt).toISOString() : null,
    updatedAt: reservation.updatedAt ? new Date(reservation.updatedAt).toISOString() : null,
  };
}

module.exports = {
  availableOnlineQuantity,
  totalPhysicalQuantity,
  isLowStock,
  isOutOfStock,
  serializeInventory,
  serializeUninitializedProduct,
  serializeInventoryMovement,
  serializeReservation,
};
