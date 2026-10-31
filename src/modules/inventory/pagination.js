'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');

/**
 * Pagination parsing shared by the inventory & reservation services.
 * `page` is 1-indexed; `limit` defaults to 20 and caps at 100 (the same
 * conventions as the product catalog). Returns `{ page, limit, skip }`.
 */
function normalizePagination({ page, limit } = {}) {
  const parsedPage = parsePositiveInteger(page, 1, 'page');
  const parsedLimit = parsePositiveInteger(limit, 20, 'limit');
  const safeLimit = Math.min(parsedLimit, 100);
  return { page: parsedPage, limit: safeLimit, skip: (parsedPage - 1) * safeLimit };
}

function parsePositiveInteger(value, fallback, name) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new ApiError(400, `${name} must be a positive integer`, ERROR_CODES.INVALID_INVENTORY_OPERATION);
  }
  return n;
}

module.exports = { normalizePagination };
