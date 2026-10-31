'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const {
  STOCK_TRANSFER_INPUT_FIELDS,
  STOCK_TRANSFER_LIMITS,
  STOCK_TRANSFER_MESSAGES,
} = require('./stockTransfer.constants');

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

function invalid(message) {
  return new ApiError(400, message, ERROR_CODES.INVALID_STOCK_TRANSFER);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertObjectId(value, name) {
  if (typeof value !== 'string' || !OBJECT_ID_PATTERN.test(value)) {
    throw invalid(`${name} must be a valid 24-character hex ObjectId`);
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
  if (reason.length > STOCK_TRANSFER_LIMITS.REASON_MAX) {
    throw invalid(`reason must be at most ${STOCK_TRANSFER_LIMITS.REASON_MAX} characters`);
  }
  return reason;
}

/**
 * Server-side validation for a stock-transfer request. The frontend is never
 * trusted: the body is re-validated against the STOCK_TRANSFER_INPUT_FIELDS
 * allowlist, so `createdBy`, `status`, `completedAt`, `_id`, Mongo operators
 * (`$set`, ...), and any other unknown key are rejected (mass-assignment and
 * operator injection are impossible). Returns `{ value }` with only known,
 * normalized fields.
 */
function validateStockTransferInput(body) {
  if (!isPlainObject(body)) {
    throw invalid('Request body must be an object');
  }

  const unknownKeys = Object.keys(body).filter(
    (key) => !STOCK_TRANSFER_INPUT_FIELDS.includes(key)
  );
  if (unknownKeys.length > 0) {
    throw invalid(`Unknown or unsupported field(s): ${unknownKeys.join(', ')}`);
  }

  const sourceOutletId = assertObjectId(body.sourceOutletId, 'sourceOutletId');
  const destinationOutletId = assertObjectId(body.destinationOutletId, 'destinationOutletId');
  if (sourceOutletId === destinationOutletId) {
    throw invalid(STOCK_TRANSFER_MESSAGES.SAME_OUTLET);
  }

  const productVariantId = assertObjectId(body.productVariantId, 'productVariantId');

  const quantity = body.quantity;
  if (
    typeof quantity !== 'number' ||
    !Number.isInteger(quantity) ||
    quantity < 1
  ) {
    throw invalid('quantity must be a positive integer');
  }
  if (quantity > STOCK_TRANSFER_LIMITS.QUANTITY_MAX) {
    throw invalid(`quantity must be at most ${STOCK_TRANSFER_LIMITS.QUANTITY_MAX}`);
  }

  return {
    value: {
      sourceOutletId,
      destinationOutletId,
      productVariantId,
      quantity,
      reason: normalizeReason(body.reason),
    },
  };
}

module.exports = {
  validateStockTransferInput,
  OBJECT_ID_PATTERN,
  assertObjectId,
};
