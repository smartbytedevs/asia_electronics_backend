'use strict';

const { COURIER_STATUSES, COURIER_LIMITS } = require('../courier.constants');

/**
 * Pathao Courier Merchant API mapping (Phase 09, ADR-0017).
 *
 * Pure functions — no HTTP, no state. Converts between the provider-agnostic
 * shipment payload (courier.provider.interface.js) and Pathao's create-order
 * body, and normalizes Pathao responses into the provider interface results.
 *
 * Verified against the public sandbox 2026-08-08:
 *   POST /aladdin/api/v1/orders →
 *     { message, type, code: 200, data: {
 *         consignment_id, merchant_order_id, order_status: 'Pending',
 *         delivery_fee: 60 } }
 *   GET /aladdin/api/v1/orders/{id} →
 *     { message, type, code: 200, data: { order_id, order_status,
 *         order_status_updated_at: 'YYYY-MM-DD HH:MM:SS', delivery_fee, ... } }
 */

const DELIVERY_TYPES = Object.freeze({
  NORMAL: 48,
  ON_DEMAND: 12,
});

const ITEM_TYPES = Object.freeze({
  DOCUMENT: 1,
  PARCEL: 2,
});

function truncate(value, max) {
  if (!value) {
    return '';
  }
  return String(value).slice(0, max);
}

/**
 * Normalizes a BD phone to the 11-digit local form Pathao accepts
 * (`01712345678`). Strips separators; drops an international `880`/`88` prefix.
 */
function normalizeBdPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('880') && digits.length === 13) {
    return `0${digits.slice(3)}`;
  }
  if (digits.startsWith('88') && digits.length === 12) {
    return `0${digits.slice(2)}`;
  }
  return digits;
}

function clampWeight(value) {
  const weight = Number(value);
  if (!Number.isFinite(weight)) {
    return COURIER_LIMITS.ITEM_WEIGHT_MIN_KG;
  }
  return Math.min(
    COURIER_LIMITS.ITEM_WEIGHT_MAX_KG,
    Math.max(COURIER_LIMITS.ITEM_WEIGHT_MIN_KG, weight)
  );
}

/**
 * Parses Pathao's `YYYY-MM-DD HH:MM:SS` timestamp. Pathao returns server-local
 * wall times without a zone; we interpret them as UTC to keep ordering
 * consistent. Returns null for unparseable values.
 */
function parsePathaoDateTime(value) {
  if (!value) {
    return null;
  }
  const normalized = String(value).replace(' ', 'T');
  const parsed = new Date(normalized.endsWith('Z') ? normalized : `${normalized}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Builds the Pathao create-order request body from the generic shipment
 * payload + the merchant store id (from config).
 */
function buildCreateOrderPayload({ payload, storeId }) {
  if (!payload) {
    throw new Error('buildCreateOrderPayload requires a payload');
  }
  const body = {
    store_id: Number(storeId),
    merchant_order_id: truncate(payload.merchantReference, COURIER_LIMITS.MERCHANT_REFERENCE_MAX),
    recipient_name: truncate(payload.recipientName, COURIER_LIMITS.RECIPIENT_NAME_MAX),
    recipient_phone: normalizeBdPhone(payload.recipientPhone),
    recipient_address: truncate(payload.recipientAddress, COURIER_LIMITS.ADDRESS_MAX),
    delivery_type: DELIVERY_TYPES[payload.deliveryType] || DELIVERY_TYPES.NORMAL,
    item_type: ITEM_TYPES.PARCEL,
    item_quantity: payload.itemQuantity > 0 ? payload.itemQuantity : 1,
    item_weight: clampWeight(payload.itemWeightKg),
    item_description: truncate(payload.itemDescription, COURIER_LIMITS.ITEM_DESCRIPTION_MAX) || 'Order items',
    amount_to_collect: Math.round((payload.amountToCollectMinorUnits || 0) / 100),
  };
  if (payload.specialInstruction) {
    body.special_instruction = truncate(
      payload.specialInstruction,
      COURIER_LIMITS.SPECIAL_INSTRUCTION_MAX
    );
  }
  return body;
}

/**
 * Normalizes the create-order response into a SubmitResult.
 */
function mapSubmitResult(response) {
  const data = (response && response.data) || {};
  const deliveryFeeTaka = Number(data.delivery_fee) || 0;
  return {
    // Pathao returns consignment_id as a number; normalize to string for storage.
    consignmentId: data.consignment_id ? String(data.consignment_id) : null,
    providerDeliveryFeeMinorUnits: Math.round(deliveryFeeTaka * 100),
    providerStatus: data.order_status || null,
    providerStatusUpdatedAt: parsePathaoDateTime(data.order_status_updated_at),
    raw: response,
  };
}

/**
 * Normalizes the order-status response into a StatusResult.
 */
function mapStatusResult(response) {
  const data = (response && response.data) || {};
  return {
    providerStatus: data.order_status || null,
    providerStatusUpdatedAt: parsePathaoDateTime(
      data.order_status_updated_at || data.order_updated_at
    ),
    raw: response,
  };
}

/**
 * Normalizes the cancel response into a CancelResult.
 */
function mapCancelResult(response) {
  const data = (response && response.data) || {};
  return {
    cancelledAt: parsePathaoDateTime(data.order_status_updated_at || data.updated_at),
    raw: response,
  };
}

/**
 * Maps a raw provider status label to a LOCAL courier status.
 *
 * DELIVERED only for confirmed delivery; CANCELLED only for confirmed
 * cancellations. Everything else (including exceptions like returns/partial
 * deliveries) stays ACTIVE so it keeps requiring fulfillment attention rather
 * than being silently misclassified as terminal.
 */
function mapProviderStatus(providerStatus) {
  const label = String(providerStatus || '').toLowerCase();
  if (label.includes('delivered')) {
    return COURIER_STATUSES.DELIVERED;
  }
  if (label.includes('cancelled')) {
    return COURIER_STATUSES.CANCELLED;
  }
  return COURIER_STATUSES.ACTIVE;
}

function isTerminalProviderStatus(providerStatus) {
  const mapped = mapProviderStatus(providerStatus);
  return mapped === COURIER_STATUSES.DELIVERED || mapped === COURIER_STATUSES.CANCELLED;
}

module.exports = {
  DELIVERY_TYPES,
  ITEM_TYPES,
  normalizeBdPhone,
  clampWeight,
  parsePathaoDateTime,
  buildCreateOrderPayload,
  mapSubmitResult,
  mapStatusResult,
  mapCancelResult,
  mapProviderStatus,
  isTerminalProviderStatus,
};
