'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const { COURIER_LIMITS } = require('./courier.constants');

function invalidCourierRequest(message) {
  return new ApiError(400, message, ERROR_CODES.INVALID_COURIER_REQUEST);
}

function assertBodyShape(body) {
  if (body === undefined || body === null) {
    return {};
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw invalidCourierRequest('Request body must be an object');
  }
  for (const key of Object.keys(body)) {
    if (key.startsWith('$')) {
      throw invalidCourierRequest(`MongoDB update operators are not allowed (found "${key}")`);
    }
  }
  return body;
}

/**
 * Validates the `{ note }` body for dispatch. Only the note is client-writable;
 * orderId/performedBy always come from the route/user, never the body.
 */
function validateDispatchInput(body) {
  const data = assertBodyShape(body);
  const unknownKeys = Object.keys(data).filter((key) => key !== 'note');
  if (unknownKeys.length > 0) {
    throw invalidCourierRequest(`unknown field(s): ${unknownKeys.join(', ')}`);
  }
  let note = null;
  if (data.note !== undefined && data.note !== null && data.note !== '') {
    if (typeof data.note !== 'string') {
      throw invalidCourierRequest('note must be a string');
    }
    note = data.note.trim();
    if (note.length > COURIER_LIMITS.NOTE_MAX) {
      throw invalidCourierRequest(`note must be at most ${COURIER_LIMITS.NOTE_MAX} characters`);
    }
  }
  return { value: { note } };
}

module.exports = {
  validateDispatchInput,
  assertBodyShape,
  invalidCourierRequest,
};
