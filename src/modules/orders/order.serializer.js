'use strict';

/**
 * Order serialization (Phase 07, ADR-0015).
 *
 * Never serializes `_id`, `__v`, or any internal/MongoDB detail. The customer
 * representation omits reservation internals; the ADMIN/STAFF representation
 * adds `reservationReference.reservationIds` for traceability. Snapshot items
 * are immutable embedded subdocuments — always serialized as-is.
 */

function serializeAddress(address) {
  return {
    fullName: address.fullName,
    phone: address.phone,
    line1: address.line1,
    line2: address.line2 || null,
    city: address.city,
    area: address.area,
    district: address.district,
    postalCode: address.postalCode,
    country: address.country,
    email: address.email || null,
  };
}

function serializeOrderItem(item) {
  return {
    id: String(item._id || item.id),
    productId: String(item.productId || ''),
    productVariantId: item.productVariantId ? String(item.productVariantId) : null,
    productName: item.productName,
    variantAttributes: item.variantAttributes || {},
    sku: item.sku ?? null,
    quantity: item.quantity,
    unitPriceMinorUnits: item.unitPriceMinorUnits,
    discountMinorUnits: item.discountMinorUnits,
    lineTotalMinorUnits: item.lineTotalMinorUnits,
  };
}

function serializeOrder(order, { includeReservations = false } = {}) {
  const safe = {
    id: String(order._id || order.id),
    orderNumber: order.orderNumber,
    customerId: String(order.customerId || ''),
    status: order.status,
    statusHistory: (order.statusHistory || []).map((entry) => ({
      status: entry.status,
      at: entry.at ? new Date(entry.at).toISOString() : null,
      by: String(entry.by || ''),
      note: entry.note || null,
    })),
    totals: {
      itemsSubtotalMinorUnits: order.totals.itemsSubtotalMinorUnits,
      totalDiscountMinorUnits: order.totals.totalDiscountMinorUnits,
      deliveryFeeMinorUnits: order.totals.deliveryFeeMinorUnits,
      grandTotalMinorUnits: order.totals.grandTotalMinorUnits,
    },
    delivery: {
      address: serializeAddress(order.delivery.address),
      zone: order.delivery.zone,
      deliveryFeeMinorUnits: order.delivery.deliveryFeeMinorUnits,
    },
    items: (order.items || []).map((item) => serializeOrderItem(item)),
    paymentMethod: order.paymentMethod,
    notes: order.notes || null,
    createdAt: order.createdAt ? new Date(order.createdAt).toISOString() : null,
    updatedAt: order.updatedAt ? new Date(order.updatedAt).toISOString() : null,
  };
  if (includeReservations && order.reservationReference) {
    safe.reservationReference = {
      reservationIds: (order.reservationReference.reservationIds || []).map(String),
      referenceType: order.reservationReference.referenceType,
    };
  }
  return safe;
}

function serializeCustomerOrder(order) {
  return serializeOrder(order, { includeReservations: false });
}

/**
 * Public order-status representation for `GET /orders/status`. Deliberately
 * omits the delivery address, `customerId`, `statusHistory`, and reservation
 * internals so a phone-verified lookup never exposes customer data.
 */
function serializeOrderStatus(order) {
  return {
    id: String(order._id || order.id),
    orderNumber: order.orderNumber,
    status: order.status,
    paymentMethod: order.paymentMethod,
    totals: {
      itemsSubtotalMinorUnits: order.totals.itemsSubtotalMinorUnits,
      totalDiscountMinorUnits: order.totals.totalDiscountMinorUnits,
      deliveryFeeMinorUnits: order.totals.deliveryFeeMinorUnits,
      grandTotalMinorUnits: order.totals.grandTotalMinorUnits,
    },
    items: (order.items || []).map((item) => ({
      id: String(item._id || item.id),
      productName: item.productName,
      quantity: item.quantity,
      lineTotalMinorUnits: item.lineTotalMinorUnits,
    })),
    createdAt: order.createdAt ? new Date(order.createdAt).toISOString() : null,
    updatedAt: order.updatedAt ? new Date(order.updatedAt).toISOString() : null,
  };
}

function serializeAdminOrder(order) {
  return serializeOrder(order, { includeReservations: true });
}

module.exports = {
  serializeOrder,
  serializeCustomerOrder,
  serializeOrderStatus,
  serializeAdminOrder,
};
