'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES, ROLES, ACCOUNT_STATUSES } = require('../../constants');
const { USER_MESSAGES } = require('./user.constants');

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

function invalidUser(message, code) {
  return new ApiError(400, message, code);
}

function assertObjectId(value, name) {
  if (typeof value !== 'string' || !OBJECT_ID_PATTERN.test(value)) {
    throw invalidUser(
      `${name} must be a valid 24-character hex ObjectId`,
      ERROR_CODES.INVALID_USER
    );
  }
  return value;
}

/**
 * Validates the admin customer-list query. Unknown query keys are ignored (the
 * API surface is explicit); known keys are validated against the real
 * ROLES/ACCOUNT_STATUSES values so the filters never offer an invented state.
 */
function validateCustomerListQuery(query = {}) {
  const filter = {};
  if (query.role !== undefined && query.role !== null && query.role !== '') {
    if (!Object.values(ROLES).includes(query.role)) {
      throw invalidUser(USER_MESSAGES.INVALID_ROLE, ERROR_CODES.INVALID_USER_ROLE);
    }
    filter.role = query.role;
  }
  if (query.status !== undefined && query.status !== null && query.status !== '') {
    if (!Object.values(ACCOUNT_STATUSES).includes(query.status)) {
      throw invalidUser(USER_MESSAGES.INVALID_STATUS, ERROR_CODES.INVALID_USER_STATUS);
    }
    filter.status = query.status;
  }
  return { filter };
}

module.exports = { assertObjectId, validateCustomerListQuery, OBJECT_ID_PATTERN };
