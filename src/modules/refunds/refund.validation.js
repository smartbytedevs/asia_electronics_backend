'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const { REFUND_LIMITS, REFUND_MESSAGES, REFUND_STATUS_VALUES } = require('./refund.constants');
const { isPlainObject } = require('../returns/return.validation');

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

function invalidRefund(message) {
  return new ApiError(400, message, ERROR_CODES.INVALID_REFUND);
}

function invalidStatus(message) {
  return new ApiError(400, message, ERROR_CODES.INVALID_REFUND_STATUS);
}

function assertObjectId(value, name) {
  if (typeof value !== 'string' || !OBJECT_ID_PATTERN.test(value)) {
    throw invalidRefund(`${name} must be a valid 24-character hex ObjectId`);
  }
  return value;
}

function parseDate(value, name) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw invalidRefund(`${name} must be an ISO-8601 date string`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw invalidRefund(`${name} must be an ISO-8601 date string`);
  }
  return date;
}

/**
 * Validates the admin refund-list query. Unknown query keys are ignored (the
 * API surface is explicit); known keys are validated.
 */
function validateRefundListQuery(query = {}) {
  const filter = {};
  if (query.status !== undefined && query.status !== null && query.status !== '') {
    if (!REFUND_STATUS_VALUES.includes(query.status)) {
      throw invalidStatus(REFUND_MESSAGES.INVALID_STATUS);
    }
    filter.status = query.status;
  }
  if (query.orderId !== undefined && query.orderId !== null && query.orderId !== '') {
    filter.orderId = assertObjectId(query.orderId, 'orderId');
  }
  if (query.returnId !== undefined && query.returnId !== null && query.returnId !== '') {
    filter.returnId = assertObjectId(query.returnId, 'returnId');
  }
  if (query.customerId !== undefined && query.customerId !== null && query.customerId !== '') {
    filter.customerId = assertObjectId(query.customerId, 'customerId');
  }
  if (query.refundNumber !== undefined && query.refundNumber !== null && query.refundNumber !== '') {
    filter.refundNumber = String(query.refundNumber);
  }
  const dateFrom = parseDate(query.dateFrom, 'dateFrom');
  const dateTo = parseDate(query.dateTo, 'dateTo');
  if (dateFrom && dateTo && dateFrom.getTime() > dateTo.getTime()) {
    throw invalidRefund('dateFrom must be on or before dateTo');
  }
  return { filter, dateFrom, dateTo };
}

/**
 * Validates the optional `{ note }` body for staff/admin refund actions.
 */
function validateReviewInput(body = {}) {
  if (!isPlainObject(body)) {
    throw invalidRefund('Request body must be an object');
  }
  for (const key of Object.keys(body)) {
    if (key.startsWith('$')) {
      throw invalidRefund(`MongoDB update operators are not allowed (found "${key}")`);
    }
  }
  const unknownKeys = Object.keys(body).filter((key) => !['note'].includes(key));
  if (unknownKeys.length > 0) {
    throw invalidRefund(`unknown field(s): ${unknownKeys.join(', ')}`);
  }
  const value = {};
  if (body.note !== undefined && body.note !== null) {
    const note = String(body.note).trim();
    if (note.length > REFUND_LIMITS.NOTE_MAX) {
      throw invalidRefund(`note must not exceed ${REFUND_LIMITS.NOTE_MAX} characters`);
    }
    value.note = note;
  }
  return { value };
}

module.exports = {
  validateRefundListQuery,
  validateReviewInput,
  assertObjectId,
  OBJECT_ID_PATTERN,
  isPlainObject,
};
