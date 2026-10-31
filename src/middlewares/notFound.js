'use strict';

const ApiError = require('../utils/ApiError');

/**
 * 404 fallback for any unmatched route.
 */
function notFound(req, res, next) {
  next(ApiError.notFound('Route not found'));
}

module.exports = notFound;
