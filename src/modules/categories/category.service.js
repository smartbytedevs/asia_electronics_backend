'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const {
  CATEGORY_FIELDS,
  CATEGORY_LIMITS,
  CATEGORY_MESSAGES,
  slugify,
} = require('./category.constants');

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

function isDuplicateKeyError(err) {
  return Boolean(err && err.code === 11000);
}

/**
 * Category business logic.
 *
 * Owns business rules: field allowlist (unknown/immutable/operator keys are
 * rejected), object-id validation, slug generation + collision handling,
 * duplicate detection, public-vs-admin visibility, and the safe API
 * representation. It never reads HTTP requests or sends responses, and it
 * never talks to MongoDB directly — persistence goes through the injected
 * repository.
 *
 * Public read rules (Phase 04):
 * - `listCategories`, `getCategoryById`, `getCategoryBySlug` only surface
 *   ACTIVE categories. Inactive categories behave as not-found for the
 *   storefront but remain stored for historical references.
 * - Administration (create/update/deactivate) is role-gated in the routes and
 *   operates on any category regardless of `isActive`.
 */
class CategoryService {
  constructor({ repository }) {
    if (!repository || typeof repository.create !== 'function') {
      throw new Error('CategoryService requires a repository');
    }
    this.repository = repository;
  }

  invalid(message) {
    return new ApiError(400, message, ERROR_CODES.INVALID_CATEGORY);
  }

  notFound() {
    return new ApiError(
      404,
      CATEGORY_MESSAGES.CATEGORY_NOT_FOUND,
      ERROR_CODES.CATEGORY_NOT_FOUND
    );
  }

  assertValidObjectId(id) {
    if (typeof id !== 'string' || !OBJECT_ID_PATTERN.test(id)) {
      throw this.invalid(CATEGORY_MESSAGES.INVALID_CATEGORY_ID);
    }
  }

  /**
   * Defense-in-depth allowlist. The controller validator already filters the
   * body; this guarantees that even a misconfigured caller cannot pass
   * immutable fields, Mongo operators (`$set`, ...), or unknown keys to the
   * repository.
   */
  assertKnownFields(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw this.invalid('Request data must be an object');
    }
    const unknownKeys = Object.keys(data).filter(
      (key) => !CATEGORY_FIELDS.includes(key)
    );
    if (unknownKeys.length > 0) {
      throw this.invalid(
        `Unknown or unsupported field(s): ${unknownKeys.join(', ')}`
      );
    }
  }

  async generateUniqueSlug(name) {
    const base = slugify(name);
    if (!base) {
      throw this.invalid(CATEGORY_MESSAGES.SLUG_GENERATION_FAILED);
    }
    let candidate = base;
    let suffix = 2;
    // Deterministic collision handling: never overwrite an existing slug.
    // The unique index remains the final guard against a concurrent race.
    while (await this.repository.existsBySlug(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  mapDuplicateKeyError(err) {
    const keyPattern = err && err.keyPattern ? err.keyPattern : {};
    if (keyPattern.slug) {
      return new ApiError(
        400,
        CATEGORY_MESSAGES.CATEGORY_SLUG_ALREADY_EXISTS,
        ERROR_CODES.CATEGORY_SLUG_ALREADY_EXISTS
      );
    }
    return new ApiError(
      400,
      CATEGORY_MESSAGES.CATEGORY_ALREADY_EXISTS,
      ERROR_CODES.CATEGORY_ALREADY_EXISTS
    );
  }

  /**
   * Public catalog listing: ACTIVE categories only, deterministic ordering
   * `sortOrder ASC, createdAt ASC`.
   */
  async listCategories() {
    const docs = await this.repository.findMany(
      { isActive: true },
      { sort: { sortOrder: 1, createdAt: 1 } }
    );
    return docs.map((doc) => this.toSafeCategory(doc));
  }

  async getCategoryById(id) {
    this.assertValidObjectId(id);
    const doc = await this.repository.findById(id);
    if (!doc || !doc.isActive) {
      throw this.notFound();
    }
    return this.toSafeCategory(doc);
  }

  async getCategoryBySlug(slug) {
    const normalized = slugify(slug);
    if (!normalized) {
      throw this.invalid(CATEGORY_MESSAGES.INVALID_CATEGORY_SLUG);
    }
    const doc = await this.repository.findBySlug(normalized);
    if (!doc || !doc.isActive) {
      throw this.notFound();
    }
    return this.toSafeCategory(doc);
  }

  /**
   * Creates a category (ADMIN only).
   *
   * Slug policy:
   * - Explicit client slug is respected and normalized; a collision is
   *   rejected (CATEGORY_SLUG_ALREADY_EXISTS).
   * - Missing slug is derived deterministically from `name` and made unique
   *   with a numeric suffix (`baby-dresses`, `baby-dresses-2`, ...).
   */
  async createCategory(data) {
    this.assertKnownFields(data);

    if (typeof data.name !== 'string' || data.name.trim().length === 0) {
      throw this.invalid('name is required and must be a non-empty string');
    }
    const name = data.name.trim();

    // Friendly pre-check — the unique indexes + duplicate-key mapping remain
    // the final consistency layer for concurrent requests.
    const existingByName = await this.repository.findOne({ name });
    if (existingByName) {
      throw new ApiError(
        400,
        CATEGORY_MESSAGES.CATEGORY_ALREADY_EXISTS,
        ERROR_CODES.CATEGORY_ALREADY_EXISTS
      );
    }

    const payload = {
      name,
      description: data.description,
      image: data.image,
      isActive: data.isActive,
      sortOrder: data.sortOrder,
    };
    // Drop undefined keys so Mongoose defaults apply (isActive, sortOrder).
    for (const key of Object.keys(payload)) {
      if (payload[key] === undefined) {
        delete payload[key];
      }
    }

    if (data.slug !== undefined && data.slug !== null && String(data.slug).trim() !== '') {
      const slug = slugify(data.slug);
      if (!slug) {
        throw this.invalid(CATEGORY_MESSAGES.INVALID_CATEGORY_SLUG);
      }
      if (await this.repository.existsBySlug(slug)) {
        throw new ApiError(
          400,
          CATEGORY_MESSAGES.CATEGORY_SLUG_ALREADY_EXISTS,
          ERROR_CODES.CATEGORY_SLUG_ALREADY_EXISTS
        );
      }
      payload.slug = slug;
    } else {
      payload.slug = await this.generateUniqueSlug(name);
    }

    try {
      const created = await this.repository.create(payload);
      return this.toSafeCategory(created);
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw this.mapDuplicateKeyError(err);
      }
      throw err;
    }
  }

  /**
   * PATCH-style update (ADMIN only): only the provided fields change; omitted
   * fields are preserved. Immutable/unknown fields are rejected. Deactivation
   * is simply `updateCategory(id, { isActive: false })`.
   */
  async updateCategory(id, data) {
    this.assertValidObjectId(id);
    this.assertKnownFields(data);

    const existing = await this.repository.findById(id);
    if (!existing) {
      throw this.notFound();
    }

    const update = {};

    if (data.name !== undefined) {
      if (typeof data.name !== 'string' || data.name.trim().length === 0) {
        throw this.invalid('name must be a non-empty string');
      }
      const name = data.name.trim();
      const clash = await this.repository.findOne({ name });
      if (clash && String(clash._id) !== String(id)) {
        throw new ApiError(
          400,
          CATEGORY_MESSAGES.CATEGORY_ALREADY_EXISTS,
          ERROR_CODES.CATEGORY_ALREADY_EXISTS
        );
      }
      update.name = name;
    }

    if (data.slug !== undefined) {
      const slug = slugify(data.slug);
      if (!slug) {
        throw this.invalid(CATEGORY_MESSAGES.INVALID_CATEGORY_SLUG);
      }
      const clash = await this.repository.findBySlug(slug);
      if (clash && String(clash._id) !== String(id)) {
        throw new ApiError(
          400,
          CATEGORY_MESSAGES.CATEGORY_SLUG_ALREADY_EXISTS,
          ERROR_CODES.CATEGORY_SLUG_ALREADY_EXISTS
        );
      }
      update.slug = slug;
    }

    if (data.description !== undefined) {
      update.description = data.description;
    }
    if (data.image !== undefined) {
      update.image = data.image;
    }
    if (data.isActive !== undefined) {
      if (typeof data.isActive !== 'boolean') {
        throw this.invalid('isActive must be a boolean');
      }
      update.isActive = data.isActive;
    }
    if (data.sortOrder !== undefined) {
      if (
        !Number.isInteger(data.sortOrder) ||
        data.sortOrder < CATEGORY_LIMITS.SORT_ORDER_MIN ||
        data.sortOrder > CATEGORY_LIMITS.SORT_ORDER_MAX
      ) {
        throw this.invalid(
          `sortOrder must be an integer between ${CATEGORY_LIMITS.SORT_ORDER_MIN} and ${CATEGORY_LIMITS.SORT_ORDER_MAX}`
        );
      }
      update.sortOrder = data.sortOrder;
    }

    if (Object.keys(update).length === 0) {
      throw this.invalid('No valid fields to update');
    }

    try {
      const updated = await this.repository.updateById(id, update);
      if (!updated) {
        throw this.notFound();
      }
      return this.toSafeCategory(updated);
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw this.mapDuplicateKeyError(err);
      }
      throw err;
    }
  }

  /**
   * Safe API representation. Never exposes `_id`, `__v`, or any internal
   * Mongoose/MongoDB details.
   */
  toSafeCategory(category) {
    return {
      id: String(category._id || category.id),
      name: category.name,
      slug: category.slug,
      description: category.description ?? null,
      image: category.image ?? null,
      isActive: category.isActive,
      sortOrder: category.sortOrder,
      createdAt: category.createdAt
        ? new Date(category.createdAt).toISOString()
        : null,
      updatedAt: category.updatedAt
        ? new Date(category.updatedAt).toISOString()
        : null,
    };
  }
}

module.exports = { CategoryService };
