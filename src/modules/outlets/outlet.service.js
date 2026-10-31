'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const {
  OUTLET_FIELDS,
  OUTLET_LIMITS,
  OUTLET_MESSAGES,
} = require('./outlet.constants');
const { serializeOutlet } = require('./outlet.serializer');

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]*$/;

function isDuplicateKeyError(err) {
  return Boolean(err && err.code === 11000);
}

/**
 * Outlet business logic (Phase 14).
 *
 * Owns business rules: field allowlist (unknown/immutable/operator keys are
 * rejected), object-id validation, code normalization + collision handling,
 * duplicate detection, and the safe API representation. It never reads HTTP
 * requests or sends responses, and it never talks to MongoDB directly —
 * persistence goes through the injected repository.
 *
 * Public read rules mirror categories:
 * - `listOutlets`, `getOutletById`, `getOutletByCode` only surface ACTIVE
 *   outlets. Inactive outlets behave as not-found for the storefront but
 *   remain stored so historical Inventory records keep their references.
 * - Administration (create/update/deactivate) is role-gated in the routes and
 *   operates on any outlet regardless of `isActive`.
 */
class OutletService {
  constructor({ repository }) {
    if (!repository || typeof repository.create !== 'function') {
      throw new Error('OutletService requires a repository');
    }
    this.repository = repository;
  }

  invalid(message) {
    return new ApiError(400, message, ERROR_CODES.INVALID_OUTLET);
  }

  notFound() {
    return new ApiError(
      404,
      OUTLET_MESSAGES.OUTLET_NOT_FOUND,
      ERROR_CODES.OUTLET_NOT_FOUND
    );
  }

  assertValidObjectId(id) {
    if (typeof id !== 'string' || !OBJECT_ID_PATTERN.test(id)) {
      throw this.invalid(OUTLET_MESSAGES.INVALID_OUTLET_ID);
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
      (key) => !OUTLET_FIELDS.includes(key)
    );
    if (unknownKeys.length > 0) {
      throw this.invalid(
        `Unknown or unsupported field(s): ${unknownKeys.join(', ')}`
      );
    }
  }

  normalizeCode(code) {
    if (typeof code !== 'string' || code.trim().length === 0) {
      throw this.invalid(OUTLET_MESSAGES.INVALID_OUTLET_CODE);
    }
    const normalized = code.trim().toUpperCase();
    if (!CODE_PATTERN.test(normalized)) {
      throw this.invalid(OUTLET_MESSAGES.INVALID_OUTLET_CODE);
    }
    return normalized;
  }

  mapDuplicateKeyError(err) {
    const keyPattern = err && err.keyPattern ? err.keyPattern : {};
    if (keyPattern.code) {
      return new ApiError(
        400,
        OUTLET_MESSAGES.OUTLET_CODE_ALREADY_EXISTS,
        ERROR_CODES.OUTLET_CODE_ALREADY_EXISTS
      );
    }
    return new ApiError(400, OUTLET_MESSAGES.OUTLET_NOT_FOUND, ERROR_CODES.INVALID_OUTLET);
  }

  /**
   * Public listing: ACTIVE outlets only, deterministic ordering by name.
   */
  async listOutlets() {
    const docs = await this.repository.findMany(
      { isActive: true },
      { sort: { name: 1, createdAt: 1 } }
    );
    return docs.map((doc) => serializeOutlet(doc));
  }

  /**
   * ADMIN listing: ALL outlets (active and inactive), deterministic ordering
   * by name. Admin management surfaces must see deactivated outlets so they
   * can be re-activated.
   */
  async listOutletsAdmin() {
    const docs = await this.repository.findMany(
      {},
      { sort: { name: 1, createdAt: 1 } }
    );
    return docs.map((doc) => serializeOutlet(doc));
  }

  async getOutletById(id) {
    this.assertValidObjectId(id);
    const doc = await this.repository.findById(id);
    if (!doc || !doc.isActive) {
      throw this.notFound();
    }
    return serializeOutlet(doc);
  }

  /**
   * ADMIN get: returns the outlet regardless of `isActive` (admin surfaces
   * can inspect a deactivated outlet to re-activate it).
   */
  async getOutletByIdAdmin(id) {
    this.assertValidObjectId(id);
    const doc = await this.repository.findById(id);
    if (!doc) {
      throw this.notFound();
    }
    return serializeOutlet(doc);
  }

  async getOutletByCode(code) {
    const normalized = this.normalizeCode(code);
    const doc = await this.repository.findByCode(normalized);
    if (!doc || !doc.isActive) {
      throw this.notFound();
    }
    return serializeOutlet(doc);
  }

  /**
   * Creates an outlet (ADMIN only). `name` and `code` are required; the code
   * is uppercased and must be unique.
   */
  async createOutlet(data) {
    this.assertKnownFields(data);

    if (typeof data.name !== 'string' || data.name.trim().length === 0) {
      throw this.invalid('name is required and must be a non-empty string');
    }
    const name = data.name.trim();
    if (name.length > OUTLET_LIMITS.NAME_MAX) {
      throw this.invalid(`name must be at most ${OUTLET_LIMITS.NAME_MAX} characters`);
    }

    const code = this.normalizeCode(data.code);

    // Friendly pre-check — the unique code index + duplicate-key mapping
    // remain the final consistency layer for concurrent requests.
    const existingByCode = await this.repository.findByCode(code);
    if (existingByCode) {
      throw new ApiError(
        400,
        OUTLET_MESSAGES.OUTLET_CODE_ALREADY_EXISTS,
        ERROR_CODES.OUTLET_CODE_ALREADY_EXISTS
      );
    }

    const payload = {
      name,
      code,
      address: data.address,
      phone: data.phone,
      isActive: data.isActive,
    };
    for (const key of Object.keys(payload)) {
      if (payload[key] === undefined) {
        delete payload[key];
      }
    }

    try {
      const created = await this.repository.create(payload);
      return serializeOutlet(created);
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
   * is simply `updateOutlet(id, { isActive: false })`.
   */
  async updateOutlet(id, data) {
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
      if (name.length > OUTLET_LIMITS.NAME_MAX) {
        throw this.invalid(`name must be at most ${OUTLET_LIMITS.NAME_MAX} characters`);
      }
      update.name = name;
    }

    if (data.code !== undefined) {
      const code = this.normalizeCode(data.code);
      const clash = await this.repository.findByCode(code);
      if (clash && String(clash._id) !== String(id)) {
        throw new ApiError(
          400,
          OUTLET_MESSAGES.OUTLET_CODE_ALREADY_EXISTS,
          ERROR_CODES.OUTLET_CODE_ALREADY_EXISTS
        );
      }
      update.code = code;
    }

    if (data.address !== undefined) {
      if (data.address !== null && typeof data.address !== 'string') {
        throw this.invalid('address must be a string or null');
      }
      if (data.address === null) {
        update.address = null;
      } else {
        const address = data.address.trim();
        if (address.length > OUTLET_LIMITS.ADDRESS_MAX) {
          throw this.invalid(
            `address must be at most ${OUTLET_LIMITS.ADDRESS_MAX} characters`
          );
        }
        update.address = address;
      }
    }

    if (data.phone !== undefined) {
      if (data.phone !== null && typeof data.phone !== 'string') {
        throw this.invalid('phone must be a string or null');
      }
      if (data.phone === null) {
        update.phone = null;
      } else {
        const phone = data.phone.trim();
        if (phone.length > OUTLET_LIMITS.PHONE_MAX) {
          throw this.invalid(`phone must be at most ${OUTLET_LIMITS.PHONE_MAX} characters`);
        }
        update.phone = phone;
      }
    }

    if (data.isActive !== undefined) {
      if (typeof data.isActive !== 'boolean') {
        throw this.invalid('isActive must be a boolean');
      }
      update.isActive = data.isActive;
    }

    if (Object.keys(update).length === 0) {
      throw this.invalid('No valid fields to update');
    }

    try {
      const updated = await this.repository.updateById(id, update);
      if (!updated) {
        throw this.notFound();
      }
      return serializeOutlet(updated);
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw this.mapDuplicateKeyError(err);
      }
      throw err;
    }
  }
}

module.exports = { OutletService };
