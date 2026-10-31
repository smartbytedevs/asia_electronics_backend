'use strict';

const { ERROR_CODES } = require('../constants');

/**
 * Operational error carrying an HTTP status and a stable machine-readable code.
 * Thrown by controllers/services and serialized by the error handler middleware.
 */
class ApiError extends Error {
  constructor(statusCode, message, code = ERROR_CODES.INTERNAL_ERROR) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

ApiError.notFound = (message = 'Resource not found') =>
  new ApiError(404, message, ERROR_CODES.NOT_FOUND);

ApiError.badRequest = (message = 'Bad request') =>
  new ApiError(400, message, ERROR_CODES.BAD_REQUEST);

ApiError.unauthorized = (message = 'Unauthorized') =>
  new ApiError(401, message, ERROR_CODES.UNAUTHORIZED);

ApiError.forbidden = (message = 'Forbidden') =>
  new ApiError(403, message, ERROR_CODES.FORBIDDEN);

module.exports = ApiError;
