'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const {
  CATEGORY_FIELDS,
  CATEGORY_LIMITS,
  slugify,
} = require('./category.constants');

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const IMAGE_PATTERN = /^https?:\/\/\S+$/i;

function invalid(message) {
  return new ApiError(400, message, ERROR_CODES.INVALID_CATEGORY);
}

/**
 * Server-side syntactic validation for category input. The frontend is never
 * trusted: every request body is re-validated here against the allowlist.
 *
 * - Rejects unknown/immutable keys (`_id`, `createdAt`, Mongo operators such
 *   as `$set`, ...) — see the CATEGORY_FIELDS allowlist.
 * - Normalizes: `name` trimmed; `slug` normalized through the single
 *   `slugify` implementation.
 * - `partial` mode (used by PATCH) makes every field optional.
 *
 * Returns `{ value }` with only known, normalized fields. Throws a 400
 * ApiError (INVALID_CATEGORY) otherwise.
 */
function validateCategoryInput(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw invalid('Request body must be an object');
  }

  const unknownKeys = Object.keys(body).filter(
    (key) => !CATEGORY_FIELDS.includes(key)
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
    if (name.length > CATEGORY_LIMITS.NAME_MAX) {
      throw invalid(`name must be at most ${CATEGORY_LIMITS.NAME_MAX} characters`);
    }
    value.name = name;
  } else if (!partial) {
    throw invalid('name is required');
  }

  if (body.slug !== undefined) {
    if (typeof body.slug !== 'string') {
      throw invalid('slug must be a string');
    }
    const normalized = slugify(body.slug);
    if (!normalized || !SLUG_PATTERN.test(normalized)) {
      throw invalid('slug must contain only lowercase letters, numbers, and hyphens');
    }
    if (normalized.length > CATEGORY_LIMITS.SLUG_MAX) {
      throw invalid(`slug must be at most ${CATEGORY_LIMITS.SLUG_MAX} characters`);
    }
    value.slug = normalized;
  }

  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== 'string') {
      throw invalid('description must be a string or null');
    }
    if (body.description === null) {
      value.description = null;
    } else {
      const description = body.description.trim();
      if (description.length > CATEGORY_LIMITS.DESCRIPTION_MAX) {
        throw invalid(
          `description must be at most ${CATEGORY_LIMITS.DESCRIPTION_MAX} characters`
        );
      }
      value.description = description;
    }
  }

  if (body.image !== undefined) {
    if (body.image !== null && typeof body.image !== 'string') {
      throw invalid('image must be a string or null');
    }
    if (body.image === null) {
      value.image = null;
    } else {
      const image = body.image.trim();
      if (!IMAGE_PATTERN.test(image)) {
        throw invalid('image must be a valid http(s) URL');
      }
      if (image.length > CATEGORY_LIMITS.IMAGE_MAX) {
        throw invalid(`image must be at most ${CATEGORY_LIMITS.IMAGE_MAX} characters`);
      }
      value.image = image;
    }
  }

  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') {
      throw invalid('isActive must be a boolean');
    }
    value.isActive = body.isActive;
  }

  if (body.sortOrder !== undefined) {
    if (
      !Number.isInteger(body.sortOrder) ||
      body.sortOrder < CATEGORY_LIMITS.SORT_ORDER_MIN ||
      body.sortOrder > CATEGORY_LIMITS.SORT_ORDER_MAX
    ) {
      throw invalid(
        `sortOrder must be an integer between ${CATEGORY_LIMITS.SORT_ORDER_MIN} and ${CATEGORY_LIMITS.SORT_ORDER_MAX}`
      );
    }
    value.sortOrder = body.sortOrder;
  }

  return { value };
}

module.exports = { validateCategoryInput };
