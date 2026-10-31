'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const { ANALYTICS_LIMITS } = require('./analytics.constants');

function invalidAnalyticsRange(message) {
  return new ApiError(400, message, ERROR_CODES.INVALID_ANALYTICS_RANGE);
}

function parseDate(value, name) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw invalidAnalyticsRange(`${name} must be an ISO-8601 date string`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw invalidAnalyticsRange(`${name} must be an ISO-8601 date string`);
  }
  return date;
}

/**
 * Resolves the analytics date range. Uses the backend's existing
 * `dateFrom`/`dateTo` convention. Both are OPT-IN; when neither is given the
 * range defaults to the trailing `DEFAULT_RANGE_DAYS` ending now. `dateFrom`
 * must not be after `dateTo`.
 */
function resolveAnalyticsRange({ dateFrom, dateTo } = {}) {
  const from = parseDate(dateFrom, 'dateFrom');
  const to = parseDate(dateTo, 'dateTo');
  if (from && to && from.getTime() > to.getTime()) {
    throw invalidAnalyticsRange('dateFrom must be on or before dateTo');
  }
  const end = to || new Date();
  const start =
    from || new Date(end.getTime() - ANALYTICS_LIMITS.DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000);
  return { start, end };
}

module.exports = { resolveAnalyticsRange, parseDate, invalidAnalyticsRange };
