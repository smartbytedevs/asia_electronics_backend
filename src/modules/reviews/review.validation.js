'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const {
  REVIEW_LIMITS,
  REVIEW_INPUT_FIELDS,
  REVIEW_REVIEW_INPUT_FIELDS,
  REVIEW_STATUS_VALUES,
  REVIEW_MESSAGES,
} = require('./review.constants');

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

function invalidReview(message) {
  return new ApiError(400, message, ERROR_CODES.INVALID_REVIEW);
}

function invalidStatus(message) {
  return new ApiError(400, message, ERROR_CODES.INVALID_REVIEW_STATUS);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertObjectId(value, name) {
  if (typeof value !== 'string' || !OBJECT_ID_PATTERN.test(value)) {
    throw invalidReview(`${name} must be a valid 24-character hex ObjectId`);
  }
  return value;
}

function assertBodyShape(body) {
  if (!isPlainObject(body)) {
    throw invalidReview('Request body must be an object');
  }
  for (const key of Object.keys(body)) {
    if (key.startsWith('$')) {
      throw invalidReview(`MongoDB update operators are not allowed (found "${key}")`);
    }
  }
}

function assertNoUnknownKeys(data, allowlist) {
  const unknownKeys = Object.keys(data).filter((key) => !allowlist.includes(key));
  if (unknownKeys.length > 0) {
    throw invalidReview(`unknown field(s): ${unknownKeys.join(', ')}`);
  }
}

function optionalString(value, name, max) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw invalidReview(`${name} must be a string or null`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > max) {
    throw invalidReview(`${name} must be at most ${max} characters`);
  }
  return trimmed;
}

function assertRating(value) {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < REVIEW_LIMITS.RATING_MIN ||
    value > REVIEW_LIMITS.RATING_MAX
  ) {
    throw invalidReview(
      `rating must be an integer between ${REVIEW_LIMITS.RATING_MIN} and ${REVIEW_LIMITS.RATING_MAX}`
    );
  }
  return value;
}

/**
 * Validates the customer review-creation body. The allowlist rejects
 * status/actor/identity fields (`status`, `customerId`, `approvedBy`, `$set`,
 * ...) so a customer can never force APPROVED or impersonate an actor.
 */
function validateCreateInput(body) {
  assertBodyShape(body);
  assertNoUnknownKeys(body, REVIEW_INPUT_FIELDS);

  return {
    value: {
      rating: assertRating(body.rating),
      comment: optionalString(body.comment, 'comment', REVIEW_LIMITS.COMMENT_MAX),
    },
  };
}

/**
 * Validates the optional `{ note }` body for admin moderation actions
 * (approve/reject).
 */
function validateReviewInput(body) {
  assertBodyShape(body);
  assertNoUnknownKeys(body, REVIEW_REVIEW_INPUT_FIELDS);
  return {
    value: {
      note: optionalString(body.note, 'note', REVIEW_LIMITS.NOTE_MAX),
    },
  };
}

/**
 * Validates the admin review-list query. Unknown query keys are ignored (the
 * API surface is explicit); known keys are validated.
 */
function validateReviewListQuery(query = {}) {
  const filter = {};
  if (query.status !== undefined && query.status !== null && query.status !== '') {
    if (!REVIEW_STATUS_VALUES.includes(query.status)) {
      throw invalidStatus(REVIEW_MESSAGES.INVALID_STATUS);
    }
    filter.status = query.status;
  }
  if (query.productId !== undefined && query.productId !== null && query.productId !== '') {
    filter.productId = assertObjectId(query.productId, 'productId');
  }
  return { filter };
}

module.exports = {
  validateCreateInput,
  validateReviewInput,
  validateReviewListQuery,
  isPlainObject,
  OBJECT_ID_PATTERN,
  assertObjectId,
};
