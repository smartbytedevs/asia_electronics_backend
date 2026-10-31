'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const { NOTIFICATION_MESSAGES } = require('./notification.constants');
const {
  NOTIFICATION_STATUS_VALUES,
  NOTIFICATION_EVENT_TYPE_VALUES,
} = require('./notification.constants');

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

function invalidNotification(message, code) {
  return new ApiError(400, message, code);
}

function assertObjectId(value, name) {
  if (typeof value !== 'string' || !OBJECT_ID_PATTERN.test(value)) {
    throw invalidNotification(
      `${name} must be a valid 24-character hex ObjectId`,
      ERROR_CODES.INVALID_NOTIFICATION
    );
  }
  return value;
}

/**
 * Validates the admin notification-list query. Unknown query keys are ignored
 * (the API surface is explicit); known keys are validated against the real
 * status/event-type enums so the filters never offer an invented state.
 */
function validateNotificationListQuery(query = {}) {
  const filter = {};
  if (query.status !== undefined && query.status !== null && query.status !== '') {
    if (!NOTIFICATION_STATUS_VALUES.includes(query.status)) {
      throw invalidNotification(
        NOTIFICATION_MESSAGES.INVALID_STATUS,
        ERROR_CODES.INVALID_NOTIFICATION_STATUS
      );
    }
    filter.status = query.status;
  }
  if (query.eventType !== undefined && query.eventType !== null && query.eventType !== '') {
    if (!NOTIFICATION_EVENT_TYPE_VALUES.includes(query.eventType)) {
      throw invalidNotification(
        `eventType must be one of: ${NOTIFICATION_EVENT_TYPE_VALUES.join(', ')}`,
        ERROR_CODES.INVALID_NOTIFICATION_EVENT_TYPE
      );
    }
    filter.eventType = query.eventType;
  }
  return { filter };
}

module.exports = { assertObjectId, validateNotificationListQuery, OBJECT_ID_PATTERN };
