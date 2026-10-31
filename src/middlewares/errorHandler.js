'use strict';

const ApiError = require('../utils/ApiError');

/**
 * Central error handler. Serializes errors into the documented envelope:
 *
 * {
 *   "success": false,
 *   "message": "Human readable message",
 *   "error": { "code": "ERROR_CODE" }
 * }
 *
 * Internal (non-operational) errors never leak details to clients.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const isOperational =
    err instanceof ApiError && err.isOperational === true;

  const statusCode = isOperational ? err.statusCode : err.status || 500;
  const code = isOperational ? err.code : 'INTERNAL_ERROR';
  const message =
    statusCode >= 500 && !isOperational
      ? 'Internal server error'
      : err.message || 'Internal server error';

  if (statusCode >= 500) {
    console.error(err);
  }

  return res.status(statusCode).json({
    success: false,
    message,
    error: { code },
  });
}

module.exports = errorHandler;
