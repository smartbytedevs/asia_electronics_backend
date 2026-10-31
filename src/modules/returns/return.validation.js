'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const {
  RETURN_LIMITS,
  RETURN_INPUT_FIELDS,
  RETURN_ITEM_INPUT_FIELDS,
  RETURN_STATUS_VALUES,
  RETURN_MESSAGES,
} = require('./return.constants');

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

function invalidReturn(message) {
  return new ApiError(400, message, ERROR_CODES.INVALID_RETURN);
}

function invalidStatus(message) {
  return new ApiError(400, message, ERROR_CODES.INVALID_RETURN_STATUS);
}

function duplicateItem() {
  return new ApiError(400, RETURN_MESSAGES.RETURN_ITEM_DUPLICATE, ERROR_CODES.RETURN_ITEM_DUPLICATE);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertObjectId(value, name) {
  if (typeof value !== 'string' || !OBJECT_ID_PATTERN.test(value)) {
    throw invalidReturn(`${name} must be a valid 24-character hex ObjectId`);
  }
  return value;
}

function assertBodyShape(body) {
  if (!isPlainObject(body)) {
    throw invalidReturn('Request body must be an object');
  }
  for (const key of Object.keys(body)) {
    if (key.startsWith('$')) {
      throw invalidReturn(`MongoDB update operators are not allowed (found "${key}")`);
    }
  }
}

function assertNoUnknownKeys(data, allowlist, errorFn) {
  const unknownKeys = Object.keys(data).filter((key) => !allowlist.includes(key));
  if (unknownKeys.length > 0) {
    throw errorFn(`unknown field(s): ${unknownKeys.join(', ')}`);
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

function assertPositiveInteger(value, name, errorFn, max) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw errorFn(`${name} must be a positive integer`);
  }
  if (max !== undefined && value > max) {
    throw errorFn(`${name} must be at most ${max}`);
  }
  return value;
}

/**
 * Validates the return-request body. The allowlist rejects status/actor/
 * identity/money fields, and `$`-operators are rejected at every level. Each
 * order item may appear once, and quantities are capped at the return limit
 * (the per-item available check happens in the service against the order).
 */
function validateCreateInput(body) {
  assertBodyShape(body);
  assertNoUnknownKeys(body, RETURN_INPUT_FIELDS, invalidReturn);

  const reason = assertRequiredString(body.reason, 'reason', RETURN_LIMITS.REASON_MAX, invalidReturn);

  if (!Array.isArray(body.items)) {
    throw invalidReturn('items must be an array');
  }
  if (body.items.length === 0) {
    throw invalidReturn('items must contain at least one order item');
  }
  if (body.items.length > RETURN_LIMITS.ITEMS_MAX) {
    throw invalidReturn(`items must contain at most ${RETURN_LIMITS.ITEMS_MAX} entries`);
  }

  const seen = new Set();
  const items = body.items.map((raw, index) => {
    const name = `items[${index}]`;
    if (!isPlainObject(raw)) {
      throw invalidReturn(`${name} must be an object`);
    }
    for (const key of Object.keys(raw)) {
      if (key.startsWith('$')) {
        throw invalidReturn(`MongoDB update operators are not allowed (found "${key}")`);
      }
    }
    assertNoUnknownKeys(raw, RETURN_ITEM_INPUT_FIELDS, invalidReturn);
    const orderItemId = assertObjectId(raw.orderItemId, `${name}.orderItemId`);
    if (seen.has(orderItemId)) {
      throw duplicateItem();
    }
    seen.add(orderItemId);
    const quantity = assertPositiveInteger(
      raw.quantity,
      `${name}.quantity`,
      invalidReturn,
      RETURN_LIMITS.QUANTITY_MAX
    );
    return { orderItemId, quantity };
  });

  return {
    value: {
      reason,
      items,
      notes: optionalString(body.notes, 'notes', RETURN_LIMITS.NOTES_MAX, invalidReturn),
    },
  };
}

/**
 * Validates the `Idempotency-Key` header for return submission.
 */
function validateIdempotencyKey(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw invalidReturn(RETURN_MESSAGES.IDEMPOTENCY_KEY_REQUIRED);
  }
  const key = raw.trim();
  if (key.length > RETURN_LIMITS.IDEMPOTENCY_KEY_MAX) {
    throw invalidReturn(`Idempotency-Key must be at most ${RETURN_LIMITS.IDEMPOTENCY_KEY_MAX} characters`);
  }
  return key;
}

/**
 * Validates the optional `{ note }` body for staff/admin status actions.
 */
function validateReviewInput(body) {
  assertBodyShape(body);
  assertNoUnknownKeys(body, ['note'], invalidReturn);
  return {
    value: {
      note: optionalString(body.note, 'note', RETURN_LIMITS.NOTE_MAX, invalidReturn),
    },
  };
}

function parseDate(value, name) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw invalidReturn(`${name} must be an ISO-8601 date string`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw invalidReturn(`${name} must be an ISO-8601 date string`);
  }
  return date;
}

/**
 * Validates the admin return-list query. Unknown query keys are ignored (the
 * API surface is explicit); known keys are validated. `orderNumber` is
 * resolved to an `orderId` by the service.
 */
function validateReturnListQuery(query = {}) {
  const filter = {};
  if (query.status !== undefined && query.status !== null && query.status !== '') {
    if (!RETURN_STATUS_VALUES.includes(query.status)) {
      throw invalidStatus(RETURN_MESSAGES.INVALID_STATUS);
    }
    filter.status = query.status;
  }
  if (query.customerId !== undefined && query.customerId !== null && query.customerId !== '') {
    filter.customerId = assertObjectId(query.customerId, 'customerId');
  }
  if (query.orderId !== undefined && query.orderId !== null && query.orderId !== '') {
    filter.orderId = assertObjectId(query.orderId, 'orderId');
  }
  if (query.orderNumber !== undefined && query.orderNumber !== null && query.orderNumber !== '') {
    filter.orderNumber = assertRequiredString(query.orderNumber, 'orderNumber', 64, invalidReturn);
  }
  const dateFrom = parseDate(query.dateFrom, 'dateFrom');
  const dateTo = parseDate(query.dateTo, 'dateTo');
  if (dateFrom && dateTo && dateFrom.getTime() > dateTo.getTime()) {
    throw invalidReturn('dateFrom must be on or before dateTo');
  }
  return { filter, dateFrom, dateTo };
}

module.exports = {
  validateCreateInput,
  validateIdempotencyKey,
  validateReviewInput,
  validateReturnListQuery,
  isPlainObject,
  OBJECT_ID_PATTERN,
  assertObjectId,
};
