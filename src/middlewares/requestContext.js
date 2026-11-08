'use strict';

const crypto = require('node:crypto');

const REQUEST_ID_HEADER = 'x-request-id';
const VALID_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

function createRequestId() {
  return crypto.randomUUID();
}

function resolveRequestId(value) {
  if (typeof value !== 'string') {
    return createRequestId();
  }
  const trimmed = value.trim();
  return VALID_REQUEST_ID.test(trimmed) ? trimmed : createRequestId();
}

function requestContext(req, res, next) {
  const requestId = resolveRequestId(req.headers[REQUEST_ID_HEADER]);

  req.id = requestId;
  req.requestId = requestId;

  res.setHeader('X-Request-Id', requestId);
  res.setHeader('Cache-Control', 'no-store');

  return next();
}

module.exports = requestContext;
module.exports.createRequestId = createRequestId;
module.exports.resolveRequestId = resolveRequestId;
module.exports.REQUEST_ID_HEADER = REQUEST_ID_HEADER;
