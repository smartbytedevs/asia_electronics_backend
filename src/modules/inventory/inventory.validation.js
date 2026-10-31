'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const {
  STOCK_LOCATIONS,
  INVENTORY_LIMITS,
  INVENTORY_INPUT_FIELDS,
} = require('./inventory.constants');

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

function invalid(message) {
  return new ApiError(400, message, ERROR_CODES.INVALID_INVENTORY_OPERATION);
}

function invalidQuantity(message) {
  return new ApiError(400, message, ERROR_CODES.INVALID_STOCK_QUANTITY);
}

function invalidTransfer(message) {
  return new ApiError(400, message, ERROR_CODES.INVALID_STOCK_TRANSFER);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertBodyShape(body) {
  if (!isPlainObject(body)) {
    throw invalid('Request body must be an object');
  }
  for (const key of Object.keys(body)) {
    if (key.startsWith('$')) {
      throw invalid(`MongoDB update operators are not allowed (found "${key}")`);
    }
  }
}

function assertNoUnknownKeys(data, allowlist) {
  const unknownKeys = Object.keys(data).filter((key) => !allowlist.includes(key));
  if (unknownKeys.length > 0) {
    throw invalid(`unknown field(s): ${unknownKeys.join(', ')}`);
  }
}

function assertObjectId(value, name) {
  if (typeof value !== 'string' || !OBJECT_ID_PATTERN.test(value)) {
    throw invalid(`${name} must be a valid 24-character hex ObjectId`);
  }
  return value;
}

function assertPositiveInteger(value, name, max) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw invalidQuantity(`${name} must be a positive integer`);
  }
  if (value > max) {
    throw invalidQuantity(`${name} must be at most ${max}`);
  }
  return value;
}

function assertNonNegativeInteger(value, name, max) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalidQuantity(`${name} must be a non-negative integer`);
  }
  if (value > max) {
    throw invalidQuantity(`${name} must be at most ${max}`);
  }
  return value;
}

function assertLocation(value, name) {
  if (value !== STOCK_LOCATIONS.ONLINE && value !== STOCK_LOCATIONS.OFFLINE) {
    throw invalid(
      `${name} must be "${STOCK_LOCATIONS.ONLINE}" or "${STOCK_LOCATIONS.OFFLINE}"`
    );
  }
  return value;
}

function normalizeReason(raw) {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'string') {
    throw invalid('reason must be a string or null');
  }
  const reason = raw.trim();
  if (reason.length === 0) {
    return null;
  }
  if (reason.length > INVENTORY_LIMITS.REASON_MAX) {
    throw invalid(`reason must be at most ${INVENTORY_LIMITS.REASON_MAX} characters`);
  }
  return reason;
}

function normalizeMetadata(raw) {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (!isPlainObject(raw)) {
    throw invalid('metadata must be an object');
  }
  for (const key of Object.keys(raw)) {
    if (key.startsWith('$')) {
      throw invalid('metadata keys starting with "$" are not allowed');
    }
  }
  return raw;
}

function normalizeExpiresAt(raw) {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    if (raw.getTime() <= Date.now()) {
      throw new ApiError(400, 'expiresAt must be in the future', ERROR_CODES.RESERVATION_EXPIRED);
    }
    return raw;
  }
  if (typeof raw === 'string') {
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      throw invalid('expiresAt must be a valid date');
    }
    if (parsed.getTime() <= Date.now()) {
      throw new ApiError(400, 'expiresAt must be in the future', ERROR_CODES.RESERVATION_EXPIRED);
    }
    return parsed;
  }
  throw invalid('expiresAt must be a valid date or null');
}

/**
 * Normalizes the inventory SUBJECT of a stock command.
 *
 * A subject is either a Simple Product or a ProductVariant:
 *   - `productId` only           → Simple Product (`productVariantId: null`)
 *   - `productId` + `productVariantId` → ProductVariant subject
 *   - `productVariantId` only    → legacy variant subject (the service resolves
 *                                  the owning productId from the variant)
 *
 * At least one of `productId` / `productVariantId` is required and every
 * provided id must be a valid 24-hex ObjectId.
 */
function normalizeSubject(raw) {
  const hasProductId = raw.productId !== undefined && raw.productId !== null;
  const hasVariantId = raw.productVariantId !== undefined && raw.productVariantId !== null;
  if (!hasProductId && !hasVariantId) {
    throw invalid('productId or productVariantId is required');
  }
  const value = {};
  if (hasProductId) {
    value.productId = assertObjectId(raw.productId, 'productId');
  }
  if (hasVariantId) {
    value.productVariantId = assertObjectId(raw.productVariantId, 'productVariantId');
  } else {
    value.productVariantId = null;
  }
  return value;
}

function validateCommand(body, fields) {
  assertBodyShape(body);
  assertNoUnknownKeys(body, fields);
  return { value: body };
}

function validateInitializeInput(body) {
  const { value: raw } = validateCommand(body, INVENTORY_INPUT_FIELDS.INITIALIZE);
  const value = {
    ...normalizeSubject(raw),
  };
  if (raw.outletId !== undefined && raw.outletId !== null) {
    value.outletId = assertObjectId(raw.outletId, 'outletId');
  }
  if (raw.onlineQuantity !== undefined) {
    value.onlineQuantity = assertNonNegativeInteger(
      raw.onlineQuantity,
      'onlineQuantity',
      INVENTORY_LIMITS.QUANTITY_MAX
    );
  }
  if (raw.offlineQuantity !== undefined) {
    value.offlineQuantity = assertNonNegativeInteger(
      raw.offlineQuantity,
      'offlineQuantity',
      INVENTORY_LIMITS.QUANTITY_MAX
    );
  }
  if (raw.lowStockThreshold !== undefined) {
    value.lowStockThreshold = assertNonNegativeInteger(
      raw.lowStockThreshold,
      'lowStockThreshold',
      INVENTORY_LIMITS.QUANTITY_MAX
    );
  }
  return { value };
}

function validateStockInInput(body) {
  const { value: raw } = validateCommand(body, INVENTORY_INPUT_FIELDS.STOCK_IN);
  return {
    value: {
      ...normalizeSubject(raw),
      location: assertLocation(raw.location, 'location'),
      quantity: assertPositiveInteger(raw.quantity, 'quantity', INVENTORY_LIMITS.QUANTITY_MAX),
      reason: normalizeReason(raw.reason),
    },
  };
}

function validateStockOutInput(body) {
  const { value: raw } = validateCommand(body, INVENTORY_INPUT_FIELDS.STOCK_OUT);
  return {
    value: {
      ...normalizeSubject(raw),
      location: assertLocation(raw.location, 'location'),
      quantity: assertPositiveInteger(raw.quantity, 'quantity', INVENTORY_LIMITS.QUANTITY_MAX),
      reason: normalizeReason(raw.reason),
    },
  };
}

function validateTransferInput(body) {
  const { value: raw } = validateCommand(body, INVENTORY_INPUT_FIELDS.TRANSFER);
  const fromLocation = assertLocation(raw.fromLocation, 'fromLocation');
  const toLocation = assertLocation(raw.toLocation, 'toLocation');
  if (fromLocation === toLocation) {
    throw invalidTransfer('fromLocation and toLocation must be different');
  }
  return {
    value: {
      ...normalizeSubject(raw),
      fromLocation,
      toLocation,
      quantity: assertPositiveInteger(raw.quantity, 'quantity', INVENTORY_LIMITS.QUANTITY_MAX),
      reason: normalizeReason(raw.reason),
    },
  };
}

function validateAdjustInput(body) {
  const { value: raw } = validateCommand(body, INVENTORY_INPUT_FIELDS.ADJUST);
  const quantity = raw.quantity;
  if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity === 0) {
    throw invalidQuantity('quantity must be a non-zero integer (positive to increase, negative to decrease)');
  }
  if (Math.abs(quantity) > INVENTORY_LIMITS.QUANTITY_MAX) {
    throw invalidQuantity(`quantity must be at most ${INVENTORY_LIMITS.QUANTITY_MAX} in magnitude`);
  }
  return {
    value: {
      ...normalizeSubject(raw),
      location: assertLocation(raw.location, 'location'),
      quantity,
      reason: normalizeReason(raw.reason),
    },
  };
}

function validateReservationInput(body) {
  const { value: raw } = validateCommand(body, INVENTORY_INPUT_FIELDS.RESERVE);
  const referenceType = raw.referenceType;
  if (typeof referenceType !== 'string' || referenceType.trim().length === 0) {
    throw invalid('referenceType is required and must be a non-empty string');
  }
  if (referenceType.trim().length > INVENTORY_LIMITS.REFERENCE_TYPE_MAX) {
    throw invalid(`referenceType must be at most ${INVENTORY_LIMITS.REFERENCE_TYPE_MAX} characters`);
  }
  const referenceId = raw.referenceId;
  if (typeof referenceId !== 'string' || referenceId.trim().length === 0) {
    throw invalid('referenceId is required and must be a non-empty string');
  }
  if (referenceId.trim().length > INVENTORY_LIMITS.REFERENCE_ID_MAX) {
    throw invalid(`referenceId must be at most ${INVENTORY_LIMITS.REFERENCE_ID_MAX} characters`);
  }
  return {
    value: {
      ...normalizeSubject(raw),
      quantity: assertPositiveInteger(raw.quantity, 'quantity', INVENTORY_LIMITS.QUANTITY_MAX),
      referenceType: referenceType.trim(),
      referenceId: referenceId.trim(),
      expiresAt: normalizeExpiresAt(raw.expiresAt),
      metadata: normalizeMetadata(raw.metadata),
    },
  };
}

module.exports = {
  validateInitializeInput,
  validateStockInInput,
  validateStockOutInput,
  validateTransferInput,
  validateAdjustInput,
  validateReservationInput,
  isPlainObject,
  OBJECT_ID_PATTERN,
  assertObjectId,
};
