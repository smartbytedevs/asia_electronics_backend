'use strict';

const ApiError = require('./ApiError');
const { ERROR_CODES } = require('../constants');

/**
 * Pagination parsing shared by the order services (Phase 07).
 * `page` is 1-indexed; `limit` defaults to 20 and caps at 100 (the same
 * conventions as the product catalog). Invalid values → 400 BAD_REQUEST.
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
    throw new ApiError(400, `${name} must be a positive integer`, ERROR_CODES.BAD_REQUEST);
  }
  return n;
}

module.exports = { normalizePagination };
