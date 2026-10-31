'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const {
  PAYMENT_METHOD_TYPES,
  PAYMENT_METHOD_TYPE_VALUES,
  PAYMENT_LIMITS,
  PAYMENT_METHOD_INPUT_FIELDS,
  PAYMENT_METHOD_METADATA_FIELDS_BY_TYPE,
  PAYMENT_MESSAGES,
} = require('./payment.constants');

function invalidPaymentMethod(message) {
  return new ApiError(400, message, ERROR_CODES.INVALID_PAYMENT_METHOD);
}

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

function assertObjectId(value, name) {
  if (typeof value !== 'string' || !OBJECT_ID_PATTERN.test(value)) {
    throw invalidPaymentMethod(`${name} must be a valid 24-character hex ObjectId`);
  }
  return value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertNoUnknownKeys(data, allowlist, errorFn) {
  const unknownKeys = Object.keys(data).filter((key) => !allowlist.includes(key));
  if (unknownKeys.length > 0) {
    throw errorFn(`unknown field(s): ${unknownKeys.join(', ')}`);
  }
}

function normalizeCode(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw invalidPaymentMethod('code is required');
  }
  const code = raw.trim().toUpperCase();
  if (
    code.length < PAYMENT_LIMITS.CODE_MIN ||
    code.length > PAYMENT_LIMITS.CODE_MAX ||
    !PAYMENT_LIMITS.CODE_PATTERN.test(code)
  ) {
    throw invalidPaymentMethod(
      `code must be ${PAYMENT_LIMITS.CODE_MIN}-${PAYMENT_LIMITS.CODE_MAX} uppercase letters, digits, or underscores`
    );
  }
  return code;
}

function normalizeDisplayName(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw invalidPaymentMethod('displayName is required');
  }
  const displayName = raw.trim();
  if (displayName.length > PAYMENT_LIMITS.DISPLAY_NAME_MAX) {
    throw invalidPaymentMethod(`displayName must be at most ${PAYMENT_LIMITS.DISPLAY_NAME_MAX} characters`);
  }
  return displayName;
}

function normalizeType(raw) {
  if (raw === undefined || raw === null) {
    return PAYMENT_METHOD_TYPES.MANUAL;
  }
  if (typeof raw !== 'string' || !PAYMENT_METHOD_TYPE_VALUES.includes(raw)) {
    throw invalidPaymentMethod(
      `type must be one of: ${PAYMENT_METHOD_TYPE_VALUES.join(', ')}`
    );
  }
  return raw;
}

/**
 * Normalizes metadata against the type-specific allowlist. MANUAL methods
 * accept the full legacy field set (bKash and bank transfer); CARD methods
 * accept NO manual metadata — any key is rejected and the result is `{}`.
 */
function normalizeMetadata(raw, type) {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (!isPlainObject(raw)) {
    throw invalidPaymentMethod('metadata must be an object');
  }
  for (const key of Object.keys(raw)) {
    if (key.startsWith('$')) {
      throw invalidPaymentMethod(`MongoDB update operators are not allowed (found "${key}")`);
    }
  }
  const allowedFields = PAYMENT_METHOD_METADATA_FIELDS_BY_TYPE[type] || [];
  assertNoUnknownKeys(raw, allowedFields, invalidPaymentMethod);

  const metadata = {};
  for (const field of allowedFields) {
    const value = raw[field];
    if (value === undefined || value === null || value === '') {
      metadata[field] = null;
    } else if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > PAYMENT_LIMITS.METADATA_FIELD_MAX) {
        throw invalidPaymentMethod(`metadata.${field} must be at most ${PAYMENT_LIMITS.METADATA_FIELD_MAX} characters`);
      }
      metadata[field] = trimmed;
    } else {
      throw invalidPaymentMethod(`metadata.${field} must be a string or null`);
    }
  }
  return metadata;
}

function normalizeBoolean(value, name) {
  if (typeof value !== 'boolean') {
    throw invalidPaymentMethod(`${name} must be a boolean`);
  }
  return value;
}

function normalizeSortOrder(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalidPaymentMethod('sortOrder must be a non-negative integer');
  }
  if (value > PAYMENT_LIMITS.SORT_ORDER_MAX) {
    throw invalidPaymentMethod(`sortOrder must be at most ${PAYMENT_LIMITS.SORT_ORDER_MAX}`);
  }
  return value;
}

/**
 * Validates an admin payment-method create body. All fields are validated; the
 * `code` becomes the unique, immutable identity of the method.
 */
function validatePaymentMethodCreate(body) {
  if (!isPlainObject(body)) {
    throw invalidPaymentMethod('Request body must be an object');
  }
  for (const key of Object.keys(body)) {
    if (key.startsWith('$')) {
      throw invalidPaymentMethod(`MongoDB update operators are not allowed (found "${key}")`);
    }
  }
  assertNoUnknownKeys(body, PAYMENT_METHOD_INPUT_FIELDS, invalidPaymentMethod);

  const type = normalizeType(body.type);

  return {
    value: {
      code: normalizeCode(body.code),
      displayName: normalizeDisplayName(body.displayName),
      type,
      metadata: normalizeMetadata(body.metadata, type),
      isActive: body.isActive === undefined ? true : normalizeBoolean(body.isActive, 'isActive'),
      sortOrder: body.sortOrder === undefined ? 0 : normalizeSortOrder(body.sortOrder),
    },
  };
}

/**
 * Validates an admin payment-method PATCH body. `code` is immutable after
 * creation (it is the unique identity referenced by payment snapshots), so a
 * PATCH attempt to change it is rejected. At least one mutable field is
 * required.
 */
function validatePaymentMethodUpdate(body) {
  if (!isPlainObject(body)) {
    throw invalidPaymentMethod('Request body must be an object');
  }
  for (const key of Object.keys(body)) {
    if (key.startsWith('$')) {
      throw invalidPaymentMethod(`MongoDB update operators are not allowed (found "${key}")`);
    }
  }
  assertNoUnknownKeys(body, PAYMENT_METHOD_INPUT_FIELDS, invalidPaymentMethod);

  if (body.code !== undefined) {
    throw invalidPaymentMethod('code is immutable after creation');
  }

  const value = {};
  if (body.displayName !== undefined) value.displayName = normalizeDisplayName(body.displayName);
  if (body.type !== undefined) value.type = normalizeType(body.type);
  // Metadata is validated against the effective type in this body (defaults to
  // MANUAL when the type is not being changed here; a CARD doc patched with
  // metadata alone is caught in the service).
  if (body.metadata !== undefined) value.metadata = normalizeMetadata(body.metadata, value.type || PAYMENT_METHOD_TYPES.MANUAL);
  if (body.isActive !== undefined) value.isActive = normalizeBoolean(body.isActive, 'isActive');
  if (body.sortOrder !== undefined) value.sortOrder = normalizeSortOrder(body.sortOrder);

  if (Object.keys(value).length === 0) {
    throw invalidPaymentMethod('at least one mutable field is required');
  }
  return { value };
}

module.exports = {
  validatePaymentMethodCreate,
  validatePaymentMethodUpdate,
  assertObjectId,
  isPlainObject,
};
