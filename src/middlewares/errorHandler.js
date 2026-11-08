'use strict';

const ApiError = require('../utils/ApiError');
const { classifyDatabaseError } = require('../utils/databaseError');

function logServerError(err, req, statusCode, code) {
  const entry = {
    level: 'error',
    type: 'api_error',
    requestId: req.id || null,
    method: req.method,
    path: req.originalUrl ? req.originalUrl.split('?')[0] : req.path,
    statusCode,
    code,
    errorName: err && err.name ? err.name : null,
    errorCode: err && typeof err.code === 'string' ? err.code : null,
  };

  if (err && err.stack) {
    entry.stack = String(err.stack).split('\n').slice(0, 8).join('\n');
  }

  console.error('[api-error]', JSON.stringify(entry));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const isOperational =
    err instanceof ApiError && err.isOperational === true;

  let statusCode = isOperational ? err.statusCode : err.status || 500;
  let code = isOperational ? err.code : 'INTERNAL_ERROR';
  let message =
    statusCode >= 500 && !isOperational
      ? 'Internal server error'
      : err.message || 'Internal server error';

  if (!isOperational && statusCode >= 500) {
    const databaseError = classifyDatabaseError(err);
    if (databaseError) {
      statusCode = databaseError.statusCode;
      code = databaseError.code;
      message =
        statusCode === 504
          ? 'The database request timed out. Please try again shortly.'
          : 'The service is temporarily unavailable. Please try again shortly.';
    }
  }

  if (statusCode >= 500) {
    logServerError(err, req, statusCode, code);
  }

  if (statusCode === 503 || statusCode === 504) {
    res.setHeader('Retry-After', '5');
  }

  const payload = {
    success: false,
    message,
    error: { code },
  };

  if (req.id) {
    payload.requestId = req.id;
  }

  return res.status(statusCode).json(payload);
}

module.exports = errorHandler;
