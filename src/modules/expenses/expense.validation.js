'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const { EXPENSE_LIMITS, EXPENSE_INPUT_FIELDS, EXPENSE_MESSAGES } = require('./expense.constants');

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

function invalidExpense(message) {
  return new ApiError(400, message, ERROR_CODES.INVALID_EXPENSE);
}

function assertObjectId(value, name) {
  if (typeof value !== 'string' || !OBJECT_ID_PATTERN.test(value)) {
    throw invalidExpense(`${name} must be a valid 24-character hex ObjectId`);
  }
  return value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseDate(value, name) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw invalidExpense(`${name} must be an ISO-8601 date string`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw invalidExpense(`${name} must be an ISO-8601 date string`);
  }
  return date;
}

/**
 * Validates the expense-create body. Whitelist-only: unknown, immutable, and
 * Mongo operator keys are rejected. `createdBy`/`_id`/`createdAt`/`updatedAt`
 * are NEVER client-writable.
 */
function validateCreateExpenseInput(body = {}) {
  if (!isPlainObject(body)) {
    throw invalidExpense('Request body must be an object');
  }
  for (const key of Object.keys(body)) {
    if (key.startsWith('$')) {
      throw invalidExpense(`MongoDB update operators are not allowed (found "${key}")`);
    }
  }
  const unknownKeys = Object.keys(body).filter((key) => !EXPENSE_INPUT_FIELDS.includes(key));
  if (unknownKeys.length > 0) {
    throw invalidExpense(`unknown field(s): ${unknownKeys.join(', ')}`);
  }

  const value = {};

  if (body.amountMinorUnits === undefined || body.amountMinorUnits === null || body.amountMinorUnits === '') {
    throw invalidExpense('amountMinorUnits is required');
  }
  if (!Number.isInteger(body.amountMinorUnits) || body.amountMinorUnits <= 0) {
    throw invalidExpense('amountMinorUnits must be a positive integer');
  }
  value.amountMinorUnits = body.amountMinorUnits;

  if (body.description === undefined || body.description === null || body.description === '') {
    throw invalidExpense('description is required');
  }
  const description = String(body.description).trim();
  if (!description) {
    throw invalidExpense('description must not be empty');
  }
  if (description.length > EXPENSE_LIMITS.DESCRIPTION_MAX) {
    throw invalidExpense(`description must not exceed ${EXPENSE_LIMITS.DESCRIPTION_MAX} characters`);
  }
  value.description = description;

  if (body.category !== undefined && body.category !== null && body.category !== '') {
    const category = String(body.category).trim();
    if (category) {
      if (category.length > EXPENSE_LIMITS.CATEGORY_MAX) {
        throw invalidExpense(`category must not exceed ${EXPENSE_LIMITS.CATEGORY_MAX} characters`);
      }
      value.category = category;
    }
  }

  if (body.expenseDate !== undefined && body.expenseDate !== null && body.expenseDate !== '') {
    value.expenseDate = parseDate(body.expenseDate, 'expenseDate');
  }

  return { value };
}

/**
 * Validates the admin expense-list query. Unknown query keys are ignored; the
 * known keys (category, dateFrom, dateTo) are validated. Date filtering uses
 * the backend's existing `dateFrom`/`dateTo` convention.
 */
function validateExpenseListQuery(query = {}) {
  const filter = {};
  if (query.category !== undefined && query.category !== null && query.category !== '') {
    filter.category = String(query.category).trim();
  }
  const dateFrom = parseDate(query.dateFrom, 'dateFrom');
  const dateTo = parseDate(query.dateTo, 'dateTo');
  if (dateFrom && dateTo && dateFrom.getTime() > dateTo.getTime()) {
    throw invalidExpense('dateFrom must be on or before dateTo');
  }
  return { filter, dateFrom, dateTo };
}

module.exports = {
  validateCreateExpenseInput,
  validateExpenseListQuery,
  assertObjectId,
  isPlainObject,
  OBJECT_ID_PATTERN,
};
