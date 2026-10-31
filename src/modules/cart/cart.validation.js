'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const { CART_LIMITS, CART_ITEM_INPUT_FIELDS } = require('./cart.constants');

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

function invalid(message) {
  return new ApiError(400, message, ERROR_CODES.INVALID_CART_ITEM);
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

function assertNoUnknownKeys(data, allowlist) {
  const unknownKeys = Object.keys(data).filter((key) => !allowlist.includes(key));
  if (unknownKeys.length > 0) {
    throw invalid(`unknown field(s): ${unknownKeys.join(', ')}`);
  }
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

function normalizeOptionalObjectId(raw, name) {
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  return assertObjectId(raw, name);
}

function normalizeQuantity(raw) {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw invalid('quantity must be a positive integer');
  }
  if (raw > CART_LIMITS.QUANTITY_MAX) {
    throw invalid(`quantity must be at most ${CART_LIMITS.QUANTITY_MAX}`);
  }
  return raw;
}

function normalizeSelectedSize(raw) {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'string') {
    throw invalid('selectedSize must be a string when provided');
  }
  const value = raw.trim();
  if (value.length === 0) {
    throw invalid('selectedSize must not be empty');
  }
  if (value.length > CART_LIMITS.SELECTED_SIZE_MAX) {
    throw invalid(
      `selectedSize must be at most ${CART_LIMITS.SELECTED_SIZE_MAX} characters`
    );
  }
  return value;
}

function validateAddItemInput(body) {
  assertBodyShape(body);
  assertNoUnknownKeys(body, CART_ITEM_INPUT_FIELDS);
  const raw = body;
  const productId = normalizeOptionalObjectId(raw.productId, 'productId');
  const productVariantId = normalizeOptionalObjectId(
    raw.productVariantId,
    'productVariantId'
  );
  if (!productId && !productVariantId) {
    throw invalid('productId or productVariantId is required');
  }
  return {
    value: {
      productId,
      productVariantId,
      quantity: normalizeQuantity(raw.quantity),
      selectedSize: normalizeSelectedSize(raw.selectedSize),
    },
  };
}

function validateUpdateItemInput(body) {
  assertBodyShape(body);
  assertNoUnknownKeys(body, ['quantity']);
  return {
    value: {
      quantity: normalizeQuantity(body.quantity),
    },
  };
}

module.exports = {
  validateAddItemInput,
  validateUpdateItemInput,
  isPlainObject,
  OBJECT_ID_PATTERN,
  assertObjectId,
};
