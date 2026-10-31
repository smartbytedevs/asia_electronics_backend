'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const {
  PAYMENT_LIMITS,
  PROOF_MEDIA_RULES,
  PAYMENT_SUBMIT_FIELDS,
  REACHABLE_PAYMENT_STATUSES,
  PAYMENT_MESSAGES,
} = require('./payment.constants');

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

function invalidPayment(message) {
  return new ApiError(400, message, ERROR_CODES.INVALID_PAYMENT);
}

function invalidProof(message) {
  return new ApiError(400, message, ERROR_CODES.INVALID_PAYMENT_PROOF);
}

function invalidStatus(message) {
  return new ApiError(400, message, ERROR_CODES.INVALID_PAYMENT_STATUS);
}

function proofRequired() {
  return new ApiError(400, PAYMENT_MESSAGES.PROOF_REQUIRED, ERROR_CODES.PAYMENT_PROOF_REQUIRED);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertObjectId(value, name) {
  if (typeof value !== 'string' || !OBJECT_ID_PATTERN.test(value)) {
    throw invalidPayment(`${name} must be a valid 24-character hex ObjectId`);
  }
  return value;
}

function assertBodyShape(body) {
  if (!isPlainObject(body)) {
    throw invalidPayment('Request body must be an object');
  }
  for (const key of Object.keys(body)) {
    if (key.startsWith('$')) {
      throw invalidPayment(`MongoDB update operators are not allowed (found "${key}")`);
    }
  }
}

function assertNoUnknownKeys(data, allowlist, errorFn) {
  const unknownKeys = Object.keys(data).filter((key) => !allowlist.includes(key));
  if (unknownKeys.length > 0) {
    throw errorFn(`unknown field(s): ${unknownKeys.join(', ')}`);
  }
}

function assertRequiredString(value, name, max, errorFn) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw errorFn(`${name} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw errorFn(`${name} must be at most ${max} characters`);
  }
  return trimmed;
}

function optionalString(value, name, max, errorFn) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw errorFn(`${name} must be a string or null`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > max) {
    throw errorFn(`${name} must be at most ${max} characters`);
  }
  return trimmed;
}

function extensionOf(originalName) {
  if (typeof originalName !== 'string') {
    return null;
  }
  const base = originalName.trim().toLowerCase();
  const dot = base.lastIndexOf('.');
  if (dot === -1 || dot === base.length - 1) {
    return null;
  }
  return base.slice(dot + 1);
}

const MAGIC_BYTES = Object.freeze({
  'image/jpeg': Object.freeze([[0xff, 0xd8, 0xff]]),
  'image/png': Object.freeze([[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]]),
  'image/webp': Object.freeze([
    [0x52, 0x49, 0x46, 0x46], // "RIFF"
    // WEBP magic is verified structurally below (bytes 8-11 == "WEBP").
  ]),
});

function matchesMagic(buffer, patterns) {
  for (const pattern of patterns) {
    if (buffer.length < pattern.length) {
      continue;
    }
    const ok = pattern.every((byte, index) => buffer[index] === byte);
    if (ok) {
      return true;
    }
  }
  return false;
}

/**
 * Validates the submitted proof file: presence, MIME allowlist, extension ↔
 * MIME consistency, magic bytes, and size. Rejects SVG/HTML/JS/PDF/executables
 * and polyglot files that pass a MIME check but carry foreign content.
 */
function validateProofFile(file) {
  if (!file) {
    throw proofRequired();
  }
  if (!file.buffer || file.buffer.length === 0) {
    throw proofRequired();
  }
  if (file.buffer.length > PAYMENT_LIMITS.PROOF_MAX_BYTES) {
    throw invalidProof(`proof exceeds the ${PAYMENT_LIMITS.PROOF_MAX_BYTES} byte limit`);
  }

  const mimeType = typeof file.contentType === 'string' ? file.contentType.toLowerCase() : null;
  const allowedExtensions = PROOF_MEDIA_RULES[mimeType];
  if (!allowedExtensions) {
    throw invalidProof('proof must be a JPEG, PNG, or WEBP image');
  }

  const extension = extensionOf(file.originalName);
  if (!extension || !allowedExtensions.includes(extension)) {
    throw invalidProof(`proof extension must be one of: ${allowedExtensions.join(', ')}`);
  }

  if (mimeType === 'image/webp') {
    const isRiff = matchesMagic(file.buffer, MAGIC_BYTES['image/webp']);
    const webpTag =
      file.buffer.length >= 12 &&
      file.buffer[8] === 0x57 && // W
      file.buffer[9] === 0x45 && // E
      file.buffer[10] === 0x42 && // B
      file.buffer[11] === 0x50; // P
    if (!isRiff || !webpTag) {
      throw invalidProof('proof is not a valid image (magic bytes do not match)');
    }
  } else if (!matchesMagic(file.buffer, MAGIC_BYTES[mimeType])) {
    throw invalidProof('proof is not a valid image (magic bytes do not match)');
  }

  return file;
}

/**
 * Validates the multipart submission: text fields + the proof file. The
 * allowlist rejects status/actor/amount/identity fields, and `$`-operators.
 */
function validateSubmitMultipart({ fields, files }) {
  if (!isPlainObject(fields)) {
    throw invalidPayment('multipart text fields are required');
  }
  for (const key of Object.keys(fields)) {
    if (key.startsWith('$')) {
      throw invalidPayment(`MongoDB update operators are not allowed (found "${key}")`);
    }
  }
  assertNoUnknownKeys(fields, PAYMENT_SUBMIT_FIELDS, invalidPayment);

  const rawAmount = fields.submittedAmountMinorUnits;
  if (typeof rawAmount !== 'string' || !/^\d+$/.test(rawAmount)) {
    throw invalidPayment('submittedAmountMinorUnits must be a non-negative integer');
  }
  const submittedAmountMinorUnits = Number(rawAmount);
  if (!Number.isSafeInteger(submittedAmountMinorUnits)) {
    throw invalidPayment('submittedAmountMinorUnits must be a non-negative integer');
  }

  const proofFiles = (files || []).filter((file) => file.fieldName === 'proof');
  if (proofFiles.length === 0) {
    throw proofRequired();
  }
  if (proofFiles.length > 1) {
    throw invalidProof('only a single proof file may be submitted');
  }
  const proof = validateProofFile(proofFiles[0]);

  return {
    value: {
      paymentMethodId: assertObjectId(fields.paymentMethodId, 'paymentMethodId'),
      submittedAmountMinorUnits,
      transactionReference: assertRequiredString(
        fields.transactionReference,
        'transactionReference',
        PAYMENT_LIMITS.TRANSACTION_REFERENCE_MAX,
        invalidPayment
      ),
      notes: optionalString(fields.notes, 'notes', PAYMENT_LIMITS.NOTES_MAX, invalidPayment),
    },
    proof,
  };
}

/**
 * Validates the `Idempotency-Key` header for payment submission.
 */
function validateIdempotencyKey(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw invalidPayment(PAYMENT_MESSAGES.IDEMPOTENCY_KEY_REQUIRED);
  }
  const key = raw.trim();
  if (key.length > PAYMENT_LIMITS.IDEMPOTENCY_KEY_MAX) {
    throw invalidPayment(`Idempotency-Key must be at most ${PAYMENT_LIMITS.IDEMPOTENCY_KEY_MAX} characters`);
  }
  return key;
}

/**
 * Validates the optional `{ note }` body for staff/admin verify/reject.
 */
function validateReviewInput(body) {
  assertBodyShape(body);
  assertNoUnknownKeys(body, ['note'], invalidPayment);
  return {
    value: {
      note: optionalString(body.note, 'note', PAYMENT_LIMITS.NOTE_MAX, invalidPayment),
    },
  };
}

function parseDate(value, name) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw invalidPayment(`${name} must be an ISO-8601 date string`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw invalidPayment(`${name} must be an ISO-8601 date string`);
  }
  return date;
}

/**
 * Validates the admin payment-list query. Unknown query keys are ignored (the
 * API surface is explicit); known keys are validated.
 */
function validatePaymentListQuery(query = {}) {
  const filter = {};
  if (query.status !== undefined && query.status !== null && query.status !== '') {
    if (!REACHABLE_PAYMENT_STATUSES.includes(query.status)) {
      throw invalidStatus(PAYMENT_MESSAGES.INVALID_STATUS);
    }
    filter.status = query.status;
  }
  if (query.paymentMethodId !== undefined && query.paymentMethodId !== null && query.paymentMethodId !== '') {
    filter.paymentMethodId = assertObjectId(query.paymentMethodId, 'paymentMethodId');
  }
  if (query.customerId !== undefined && query.customerId !== null && query.customerId !== '') {
    filter.customerId = assertObjectId(query.customerId, 'customerId');
  }
  if (query.orderNumber !== undefined && query.orderNumber !== null && query.orderNumber !== '') {
    filter.orderNumber = assertRequiredString(
      query.orderNumber,
      'orderNumber',
      64,
      invalidPayment
    );
  }
  const dateFrom = parseDate(query.dateFrom, 'dateFrom');
  const dateTo = parseDate(query.dateTo, 'dateTo');
  if (dateFrom && dateTo && dateFrom.getTime() > dateTo.getTime()) {
    throw invalidPayment('dateFrom must be on or before dateTo');
  }
  return { filter, dateFrom, dateTo };
}

module.exports = {
  validateSubmitMultipart,
  validateIdempotencyKey,
  validateReviewInput,
  validatePaymentListQuery,
  validateProofFile,
  isPlainObject,
  OBJECT_ID_PATTERN,
  assertObjectId,
};
