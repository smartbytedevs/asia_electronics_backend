'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const {
  OUTLET_FIELDS,
  OUTLET_LIMITS,
} = require('./outlet.constants');

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]*$/;

function invalid(message) {
  return new ApiError(400, message, ERROR_CODES.INVALID_OUTLET);
}

/**
 * Server-side syntactic validation for outlet input. The frontend is never
 * trusted: every request body is re-validated here against the allowlist.
 *
 * - Rejects unknown/immutable keys (`_id`, `createdAt`, Mongo operators such
 *   as `$set`, ...) — see the OUTLET_FIELDS allowlist.
 * - Normalizes: `name` trimmed; `code` trimmed/uppercased through the single
 *   CODE_PATTERN.
 * - `partial` mode (used by PATCH) makes every field optional.
 *
 * Returns `{ value }` with only known, normalized fields. Throws a 400
 * ApiError (INVALID_OUTLET) otherwise.
 */
function validateOutletInput(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw invalid('Request body must be an object');
  }

  const unknownKeys = Object.keys(body).filter(
    (key) => !OUTLET_FIELDS.includes(key)
  );
  if (unknownKeys.length > 0) {
    throw invalid(`Unknown or unsupported field(s): ${unknownKeys.join(', ')}`);
  }

  const value = {};

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      throw invalid('name is required and must be a non-empty string');
    }
    const name = body.name.trim();
    if (name.length > OUTLET_LIMITS.NAME_MAX) {
      throw invalid(`name must be at most ${OUTLET_LIMITS.NAME_MAX} characters`);
    }
    value.name = name;
  } else if (!partial) {
    throw invalid('name is required');
  }

  if (body.code !== undefined) {
    if (typeof body.code !== 'string' || body.code.trim().length === 0) {
      throw invalid('code is required and must be a non-empty string');
    }
    const code = body.code.trim().toUpperCase();
    if (!CODE_PATTERN.test(code)) {
      throw invalid(
        'code must start with a letter or digit and contain only letters, digits, underscores, and hyphens'
      );
    }
    if (code.length > OUTLET_LIMITS.CODE_MAX) {
      throw invalid(`code must be at most ${OUTLET_LIMITS.CODE_MAX} characters`);
    }
    value.code = code;
  } else if (!partial) {
    throw invalid('code is required');
  }

  if (body.address !== undefined) {
    if (body.address !== null && typeof body.address !== 'string') {
      throw invalid('address must be a string or null');
    }
    if (body.address === null) {
      value.address = null;
    } else {
      const address = body.address.trim();
      if (address.length > OUTLET_LIMITS.ADDRESS_MAX) {
        throw invalid(
          `address must be at most ${OUTLET_LIMITS.ADDRESS_MAX} characters`
        );
      }
      value.address = address;
    }
  }

  if (body.phone !== undefined) {
    if (body.phone !== null && typeof body.phone !== 'string') {
      throw invalid('phone must be a string or null');
    }
    if (body.phone === null) {
      value.phone = null;
    } else {
      const phone = body.phone.trim();
      if (phone.length > OUTLET_LIMITS.PHONE_MAX) {
        throw invalid(`phone must be at most ${OUTLET_LIMITS.PHONE_MAX} characters`);
      }
      value.phone = phone;
    }
  }

  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') {
      throw invalid('isActive must be a boolean');
    }
    value.isActive = body.isActive;
  }

  return { value };
}

module.exports = { validateOutletInput, CODE_PATTERN };
