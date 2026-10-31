'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const {
  ORDER_LIMITS,
  ORDER_INPUT_FIELDS,
  DELIVERY_ZONE_VALUES,
  PAYMENT_METHODS,
  PAYMENT_METHOD_VALUES,
  ORDER_MESSAGES,
} = require('./order.constants');

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function invalidOrder(message) {
  return new ApiError(400, message, ERROR_CODES.INVALID_ORDER);
}

function invalidDelivery(message) {
  return new ApiError(400, message, ERROR_CODES.INVALID_DELIVERY_ADDRESS);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertObjectId(value, name) {
  if (typeof value !== 'string' || !OBJECT_ID_PATTERN.test(value)) {
    throw invalidOrder(`${name} must be a valid 24-character hex ObjectId`);
  }
  return value;
}

function assertNoUnknownKeys(data, allowlist, errorFn) {
  const unknownKeys = Object.keys(data).filter((key) => !allowlist.includes(key));
  if (unknownKeys.length > 0) {
    throw errorFn(`unknown field(s): ${unknownKeys.join(', ')}`);
  }
}

function assertBodyShape(body) {
  if (!isPlainObject(body)) {
    throw invalidOrder('Request body must be an object');
  }
  for (const key of Object.keys(body)) {
    if (key.startsWith('$')) {
      throw invalidOrder(`MongoDB update operators are not allowed (found "${key}")`);
    }
  }
}

function assertRequiredString(value, name, max, errorFn) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw errorFn(`${name} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw errorFn(`${name} must be at most ${max} characters`);
  }
  return trimmed;
}

function optionalString(value, name, max, errorFn) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw errorFn(`${name} must be a string or null`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > max) {
    throw errorFn(`${name} must be at most ${max} characters`);
  }
  return trimmed;
}

/**
 * Optional email: validated ONLY when provided (guest checkout). Missing,
 * null, or empty/whitespace → null. When present it must be a string within
 * ORDER_LIMITS.EMAIL_MAX and match the basic email shape; the normalized value
 * is trimmed and lower-cased (mirrors the User email normalization).
 */
function optionalEmail(value, name, errorFn) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw errorFn(`${name} must be a string or null`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > ORDER_LIMITS.EMAIL_MAX) {
    throw errorFn(`${name} must be at most ${ORDER_LIMITS.EMAIL_MAX} characters`);
  }
  if (!EMAIL_PATTERN.test(trimmed)) {
    throw errorFn(`${name} must be a valid email address`);
  }
  return trimmed.toLowerCase();
}

function normalizeDeliveryAddress(raw, errorFn) {
  if (!isPlainObject(raw)) {
    throw errorFn('delivery.address must be an object');
  }
  for (const key of Object.keys(raw)) {
    if (key.startsWith('$')) {
      throw errorFn(`MongoDB update operators are not allowed (found "${key}")`);
    }
  }
  return {
    fullName: assertRequiredString(raw.fullName, 'delivery.address.fullName', ORDER_LIMITS.FULL_NAME_MAX, errorFn),
    phone: assertRequiredString(raw.phone, 'delivery.address.phone', ORDER_LIMITS.PHONE_MAX, errorFn),
    line1: assertRequiredString(raw.line1, 'delivery.address.line1', ORDER_LIMITS.LINE_MAX, errorFn),
    line2: optionalString(raw.line2, 'delivery.address.line2', ORDER_LIMITS.LINE_MAX, errorFn),
    city: assertRequiredString(raw.city, 'delivery.address.city', ORDER_LIMITS.CITY_MAX, errorFn),
    area: assertRequiredString(raw.area, 'delivery.address.area', ORDER_LIMITS.AREA_MAX, errorFn),
    district: assertRequiredString(raw.district, 'delivery.address.district', ORDER_LIMITS.DISTRICT_MAX, errorFn),
    postalCode: assertRequiredString(raw.postalCode, 'delivery.address.postalCode', ORDER_LIMITS.POSTAL_CODE_MAX, errorFn),
    country: normalizeCountry(raw.country, errorFn),
    email: optionalEmail(raw.email, 'delivery.address.email', errorFn),
  };
}

function normalizeCountry(raw, errorFn) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw errorFn('delivery.address.country is required');
  }
  const country = raw.trim().toUpperCase();
  if (country !== ORDER_LIMITS.COUNTRY) {
    throw errorFn(`delivery.address.country must be "${ORDER_LIMITS.COUNTRY}"`);
  }
  return country;
}

/**
 * Normalizes the optional customer-selected delivery zone. Absent / null /
 * blank → `null` (the service then derives the zone from the address). Any
 * other value must be a DELIVERY_ZONE enum; the fee is ALWAYS read from
 * `DELIVERY_FEES_MINOR_UNITS[zone]` server-side, never from the client.
 */
function normalizeDeliveryZone(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  if (typeof raw !== 'string') {
    throw invalidOrder('delivery.zone must be a string or null');
  }
  const zone = raw.trim().toUpperCase();
  if (zone === '') {
    return null;
  }
  if (!DELIVERY_ZONE_VALUES.includes(zone)) {
    throw invalidOrder(`delivery.zone must be one of: ${DELIVERY_ZONE_VALUES.join(', ')}`);
  }
  return zone;
}

/**
 * Validates the checkout body. Client-controlled money/status/orderNumber/
 * identity fields are rejected by the allowlist — totals, fees, and orderNumber
 * are ALWAYS server-derived at checkout. The delivery zone is the ONE exception
 * (the customer's declared delivery-charge selection); it is validated against
 * the enum and its fee is still computed server-side.
 */
function validateCheckoutInput(body) {
  assertBodyShape(body);
  assertNoUnknownKeys(body, ORDER_INPUT_FIELDS, invalidOrder);
  const raw = body;

  let delivery;
  if (raw.delivery !== undefined && raw.delivery !== null) {
    if (!isPlainObject(raw.delivery)) {
      throw invalidDelivery('delivery must be an object');
    }
    for (const key of Object.keys(raw.delivery)) {
      if (key.startsWith('$')) {
        throw invalidDelivery(`MongoDB update operators are not allowed (found "${key}")`);
      }
    }
    if (raw.delivery.deliveryFeeMinorUnits !== undefined) {
      throw invalidOrder('delivery.deliveryFeeMinorUnits is server-derived and cannot be set');
    }
    delivery = {
      address: normalizeDeliveryAddress(raw.delivery.address, invalidDelivery),
      zone: normalizeDeliveryZone(raw.delivery.zone),
    };
  } else {
    throw invalidOrder('delivery is required');
  }

  return {
    value: {
      delivery,
      notes: optionalString(raw.notes, 'notes', ORDER_LIMITS.NOTES_MAX, invalidOrder),
      paymentMethod: normalizePaymentMethod(raw.paymentMethod),
    },
  };
}

function normalizePaymentMethod(raw) {
  if (raw === undefined || raw === null) {
    return PAYMENT_METHODS.COD;
  }
  if (!PAYMENT_METHOD_VALUES.includes(raw)) {
    throw invalidOrder(
      `paymentMethod must be one of: ${PAYMENT_METHOD_VALUES.join(', ')}`
    );
  }
  return raw;
}

/**
 * Validates the `Idempotency-Key` header for checkout.
 */
function validateIdempotencyKey(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw invalidOrder('Idempotency-Key header is required for checkout');
  }
  const key = raw.trim();
  if (key.length > ORDER_LIMITS.IDEMPOTENCY_KEY_MAX) {
    throw invalidOrder(`Idempotency-Key must be at most ${ORDER_LIMITS.IDEMPOTENCY_KEY_MAX} characters`);
  }
  return key;
}

/**
 * Validates the optional `{ note }` body for staff/admin status actions.
 */
function validateTransitionInput(body) {
  assertBodyShape(body);
  assertNoUnknownKeys(body, ['note'], invalidOrder);
  return {
    value: {
      note: optionalString(body.note, 'note', ORDER_LIMITS.NOTE_MAX, invalidOrder),
    },
  };
}

/**
 * Validates the PUBLIC order-status lookup query. Requires the delivery phone
 * AND exactly one of `orderId` / `orderNumber`, so a bare order identifier can
 * never reveal an order.
 */
function validateOrderStatusLookup(query) {
  if (!isPlainObject(query)) {
    throw invalidOrder('Query parameters are required');
  }
  const hasOrderId = typeof query.orderId === 'string' && query.orderId.trim() !== '';
  const hasOrderNumber =
    typeof query.orderNumber === 'string' && query.orderNumber.trim() !== '';
  if (hasOrderId && hasOrderNumber) {
    throw invalidOrder('Provide either orderId or orderNumber, not both');
  }
  if (!hasOrderId && !hasOrderNumber) {
    throw invalidOrder('orderId or orderNumber is required');
  }
  const phone = assertRequiredString(query.phone, 'phone', ORDER_LIMITS.PHONE_MAX, invalidOrder);
  if (hasOrderId) {
    return {
      value: { orderId: assertObjectId(query.orderId.trim(), 'orderId'), phone },
    };
  }
  return { value: { orderNumber: query.orderNumber.trim(), phone } };
}

module.exports = {
  validateCheckoutInput,
  validateIdempotencyKey,
  validateOrderStatusLookup,
  validateTransitionInput,
  isPlainObject,
  OBJECT_ID_PATTERN,
  assertObjectId,
};
