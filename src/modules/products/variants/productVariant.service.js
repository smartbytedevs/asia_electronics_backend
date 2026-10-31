'use strict';

const ApiError = require('../../../utils/ApiError');
const { ERROR_CODES } = require('../../../constants');
const {
  VARIANT_FIELDS,
  VARIANT_MESSAGES,
  SKU_GENERATION,
  PRODUCT_LIMITS,
} = require('./productVariant.constants');
const { MEASUREMENT_KEY_PATTERN } = require('../product.constants');

const ATTRIBUTE_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9]{0,39}$/;

function invalid(message) {
  return new ApiError(400, message, ERROR_CODES.INVALID_VARIANT);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Canonical, order-stable serialization of variant attributes.
 * `{ size: "52", color: "Black" }` and `{ color: "Black", size: "52" }` both
 * produce the same key, so the unique index { productId, attributeKey }
 * reliably prevents duplicate variants regardless of key order.
 */
function buildAttributeKey(attributes) {
  const sorted = Object.keys(attributes)
    .sort()
    .map((key) => [key, attributes[key]]);
  return JSON.stringify(sorted);
}

function normalizeSku(raw) {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw invalid('sku must be a non-empty string');
  }
  const sku = raw.trim().toUpperCase();
  if (sku.length > PRODUCT_LIMITS.SKU_MAX) {
    throw invalid(`sku must be at most ${PRODUCT_LIMITS.SKU_MAX} characters`);
  }
  return sku;
}

/**
 * Uppercases and strips a fragment to [A-Z0-9] for SKU composition.
 */
function normalizeSkuFragment(value) {
  return String(value === undefined || value === null ? '' : value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * Deterministic base for an auto-generated SKU: the product slug (the stable
 * catalog identifier) followed by the variant's attribute values in sorted
 * key order, e.g. slug "premium-abaya" + { size: "52", color: "Black" } →
 * `PREMIUMABAYA-52-BLACK`. Collisions are resolved with a `-<n>` suffix by
 * the caller; the base itself is capped so any suffix fits SKU_MAX.
 */
function buildSkuBase(product, attributes) {
  const slugBase = normalizeSkuFragment(product && product.slug ? product.slug : '')
    .slice(0, SKU_GENERATION.BASE_MAX);
  const base = slugBase || 'PROD';
  const parts = Object.keys(attributes || {})
    .sort()
    .map((key) => normalizeSkuFragment(attributes[key]))
    .filter(Boolean);
  const valueFragment = parts.join('-').slice(0, SKU_GENERATION.VALUE_MAX);
  const combined = valueFragment ? `${base}-${valueFragment}` : base;
  return combined.slice(0, SKU_GENERATION.BASE_MAX);
}

function normalizeAttributes(raw) {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (!isPlainObject(raw)) {
    throw invalid('attributes must be an object of key/value strings');
  }
  const keys = Object.keys(raw);
  if (keys.length > PRODUCT_LIMITS.ATTRIBUTES_MAX) {
    throw invalid(`attributes must contain at most ${PRODUCT_LIMITS.ATTRIBUTES_MAX} keys`);
  }
  const attributes = {};
  for (const key of keys) {
    if (!ATTRIBUTE_KEY_PATTERN.test(key)) {
      throw invalid(
        `attribute key "${key}" is invalid — keys must match ${ATTRIBUTE_KEY_PATTERN}`
      );
    }
    const value = raw[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw invalid(`attribute "${key}" must be a non-empty string`);
    }
    if (value.trim().length > PRODUCT_LIMITS.ATTRIBUTE_VALUE_MAX) {
      throw invalid(
        `attribute "${key}" must be at most ${PRODUCT_LIMITS.ATTRIBUTE_VALUE_MAX} characters`
      );
    }
    attributes[key] = value.trim();
  }
  return attributes;
}

function normalizePriceOverride(raw, name) {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!Number.isInteger(raw)) {
    throw invalid(`${name} must be an integer number of minor units (paisa)`);
  }
  if (raw < PRODUCT_LIMITS.PRICE_MIN || raw > PRODUCT_LIMITS.PRICE_MAX) {
    throw invalid(
      `${name} must be between ${PRODUCT_LIMITS.PRICE_MIN} and ${PRODUCT_LIMITS.PRICE_MAX} minor units`
    );
  }
  return raw;
}

function assertNoUnknownKeys(data, allowlist) {
  const unknownKeys = Object.keys(data).filter((key) => !allowlist.includes(key));
  if (unknownKeys.length > 0) {
    throw invalid(`unknown field(s): ${unknownKeys.join(', ')}`);
  }
}

function assertNoMongoOperators(data) {
  for (const key of Object.keys(data)) {
    if (key.startsWith('$')) {
      throw invalid(`MongoDB update operators are not allowed (found "${key}")`);
    }
  }
}

/**
 * Validates + normalizes a single variant payload.
 * `partial=true` (variant PATCH) makes every field optional.
 * `sku` is ALWAYS optional: when omitted the variant service auto-generates a
 * unique SKU at creation time (the normal product form manages sizes, not
 * SKUs). An explicitly provided SKU (legacy/manual) is validated as before.
 * Never accepts `productId` — a variant cannot move between products.
 */
function validateVariantInput(raw, { partial = false } = {}) {
  if (!isPlainObject(raw)) {
    throw invalid('variant must be an object');
  }
  assertNoMongoOperators(raw);
  assertNoUnknownKeys(raw, VARIANT_FIELDS);

  const value = {};

  if (raw.sku !== undefined) {
    value.sku = normalizeSku(raw.sku);
  }

  if (raw.attributes !== undefined) {
    value.attributes = normalizeAttributes(raw.attributes);
  }

  if (raw.sellingPriceOverride !== undefined) {
    value.sellingPriceOverride = normalizePriceOverride(
      raw.sellingPriceOverride,
      'sellingPriceOverride'
    );
  }

  if (raw.purchasePriceOverride !== undefined) {
    value.purchasePriceOverride = normalizePriceOverride(
      raw.purchasePriceOverride,
      'purchasePriceOverride'
    );
  }

  if (raw.isActive !== undefined) {
    if (typeof raw.isActive !== 'boolean') {
      throw invalid('isActive must be a boolean');
    }
    value.isActive = raw.isActive;
  }

  return value;
}

function isDuplicateKeyError(err) {
  return Boolean(err && err.code === 11000);
}

function mapDuplicateKeyError(err) {
  const keyPattern = err && err.keyPattern ? err.keyPattern : {};
  if (keyPattern.sku) {
    return new ApiError(
      400,
      VARIANT_MESSAGES.VARIANT_SKU_ALREADY_EXISTS,
      ERROR_CODES.VARIANT_SKU_ALREADY_EXISTS
    );
  }
  return new ApiError(
    400,
    VARIANT_MESSAGES.VARIANT_DUPLICATE_ATTRIBUTES,
    ERROR_CODES.VARIANT_DUPLICATE_ATTRIBUTES
  );
}

/**
 * Collects the distinct `size` attribute values across a list of variant
 * docs ({ attributes }). Empty array when the product has no sized variants.
 */
function collectVariantSizes(variants) {
  const sizes = new Set();
  for (const variant of variants || []) {
    const attributes = variant && variant.attributes ? variant.attributes : {};
    if (typeof attributes.size === 'string' && attributes.size.trim() !== '') {
      sizes.add(attributes.size);
    }
  }
  return [...sizes];
}

/**
 * MEASUREMENT-VARIANT SIZE CONSISTENCY (ADR-0013):
 * When a product carries a LEGACY structured measurement guide (with size
 * rows), every size row in the guide must correspond to a size actually
 * offered by the product's variants (no orphan measurement rows). Non-sized
 * products must not carry such a guide.
 *
 * Image-only guides (the current format, `{ imageUrl }`) have no size rows and
 * never require the product to offer sized variants.
 */
function assertGuideMatchesVariantSizes(measurementGuide, variants) {
  if (!measurementGuide) {
    return;
  }
  if (!Array.isArray(measurementGuide.sizes) || measurementGuide.sizes.length === 0) {
    return;
  }
  const offeredSizes = new Set(collectVariantSizes(variants));
  if (offeredSizes.size === 0) {
    throw new ApiError(
      400,
      'A measurement guide requires the product to offer sized variants',
      ERROR_CODES.INVALID_MEASUREMENT_GUIDE
    );
  }
  for (const row of measurementGuide.sizes) {
    if (!offeredSizes.has(row.size)) {
      throw new ApiError(
        400,
        `Measurement guide references size "${row.size}" which the product does not offer`,
        ERROR_CODES.INVALID_MEASUREMENT_GUIDE
      );
    }
  }
}

/**
 * ProductVariant business logic (Phase 05, ADR-0013).
 *
 * Owns variant rules: SKU normalization + uniqueness, attribute allowlisting
 * + canonicalization, duplicate-variant prevention (unique index on
 * { productId, attributeKey } is the DB-level final layer), price override
 * validation, and measurement/variant size consistency.
 *
 * Persistence goes through the injected repository; the product is only read
 * (through `productRepository`) when variant changes affect measurement size
 * consistency. No HTTP/RBAC logic here — permissions are enforced by the
 * routes/controller.
 */
function createVariantService({ repository, productRepository } = {}) {
  if (!repository || typeof repository.create !== 'function') {
    throw new Error('createVariantService requires a repository');
  }
  if (!productRepository || typeof productRepository.findById !== 'function') {
    throw new Error('createVariantService requires a productRepository');
  }

  const service = {
    buildAttributeKey,
    buildSkuBase,
    collectVariantSizes,
    assertGuideMatchesVariantSizes,
    validateVariantInput,

    invalid,
    isDuplicateKeyError,
    mapDuplicateKeyError,

    /**
     * Creates a single variant inside a transaction (`session`).
     * Friendly pre-checks (SKU + duplicate attributes) run against the
     * same session so the unique indexes remain the final consistency layer.
     *
     * When the client omits `sku`, a unique SKU is auto-generated from the
     * product slug + attribute values (buildSkuBase) with a `-<n>` collision
     * suffix; the global unique SKU index stays the final guard, and a
     * duplicate-key race is retried with the next candidate.
     */
    async createVariant({ productId, raw, session } = {}) {
      const value = validateVariantInput(raw);
      const attributes = value.attributes || {};
      const attributeKey = buildAttributeKey(attributes);
      const autoGenerateSku = value.sku === undefined;
      const explicitSku = value.sku;

      if (explicitSku !== undefined && (await service.existsBySku(explicitSku, session))) {
        throw new ApiError(
          400,
          VARIANT_MESSAGES.VARIANT_SKU_ALREADY_EXISTS,
          ERROR_CODES.VARIANT_SKU_ALREADY_EXISTS
        );
      }
      if (await service.existsAttributesForProduct(productId, attributeKey, null, session)) {
        throw new ApiError(
          400,
          VARIANT_MESSAGES.VARIANT_DUPLICATE_ATTRIBUTES,
          ERROR_CODES.VARIANT_DUPLICATE_ATTRIBUTES
        );
      }

      const product = autoGenerateSku
        ? await productRepository.findById(productId, session ? { session } : {})
        : null;

      const payload = {
        productId,
        attributes,
        attributeKey,
        sellingPriceOverride: value.sellingPriceOverride,
        purchasePriceOverride: value.purchasePriceOverride,
        isActive: value.isActive,
      };
      for (const key of Object.keys(payload)) {
        if (payload[key] === undefined) {
          delete payload[key];
        }
      }

      let attempts = 0;
      while (true) {
        payload.sku =
          explicitSku !== undefined
            ? explicitSku
            : await service.resolveGeneratedSku(product, attributes, session, attempts);
        try {
          const created = await repository.create(payload, session ? { session } : {});
          return created;
        } catch (err) {
          if (service.isDuplicateKeyError(err)) {
            const friendly = service.mapDuplicateKeyError(err);
            if (autoGenerateSku && friendly.code === ERROR_CODES.VARIANT_SKU_ALREADY_EXISTS) {
              // A concurrent write claimed our candidate — bump the collision
              // suffix and try again. `attempts` guarantees forward progress.
              attempts += 1;
              if (attempts >= SKU_GENERATION.MAX_ATTEMPTS) {
                throw friendly;
              }
              continue;
            }
            throw friendly;
          }
          throw err;
        }
      }
    },

    /**
     * Returns a globally unique SKU derived from `buildSkuBase`, appending a
     * `-<n>` collision suffix until one is free. `startAttempt` skips already
     * tried candidates (used on a duplicate-key race retry).
     */
    async resolveGeneratedSku(product, attributes, session, startAttempt = 0) {
      const base = buildSkuBase(product, attributes);
      let attempt = startAttempt;
      let candidate;
      while (true) {
        attempt += 1;
        if (attempt > SKU_GENERATION.MAX_ATTEMPTS) {
          throw invalid('could not generate a unique SKU for this variant');
        }
        candidate = attempt === 1 ? base : `${base}-${attempt}`;
        if (!(await service.existsBySku(candidate, session))) {
          return candidate;
        }
      }
    },

    async existsBySku(sku, session) {
      return repository.existsBySku(sku, session ? { session } : {});
    },

    async existsAttributesForProduct(productId, attributeKey, excludeVariantId, session) {
      const existing = await repository.findOneByProduct(
        productId,
        { attributeKey },
        session ? { session } : {}
      );
      if (!existing) {
        return false;
      }
      return excludeVariantId ? String(existing._id) !== String(excludeVariantId) : true;
    },

    /**
     * ADMIN-only variant update. `productId` is fixed by the route path and is
     * never writable. SKU/attribute changes are deliberate admin operations.
     * Re-validates measurement/variant size consistency when attributes change.
     */
    async updateVariant(productId, variantId, raw) {
      const existing = await repository.findByProductAndId(productId, variantId);
      if (!existing) {
        throw new ApiError(
          404,
          VARIANT_MESSAGES.VARIANT_NOT_FOUND,
          ERROR_CODES.VARIANT_NOT_FOUND
        );
      }

      const value = validateVariantInput(raw, { partial: true });

      const update = {};
      if (value.sku !== undefined) {
        if (value.sku !== existing.sku) {
          throw invalid('SKU cannot be changed after creation');
        }
        if (await service.existsBySku(value.sku)) {
          throw new ApiError(
            400,
            VARIANT_MESSAGES.VARIANT_SKU_ALREADY_EXISTS,
            ERROR_CODES.VARIANT_SKU_ALREADY_EXISTS
          );
        }
        update.sku = value.sku;
      }

      if (value.attributes !== undefined) {
        const attributeKey = buildAttributeKey(value.attributes);
        if (await service.existsAttributesForProduct(productId, attributeKey, existing._id)) {
          throw new ApiError(
            400,
            VARIANT_MESSAGES.VARIANT_DUPLICATE_ATTRIBUTES,
            ERROR_CODES.VARIANT_DUPLICATE_ATTRIBUTES
          );
        }
        update.attributes = value.attributes;
        update.attributeKey = attributeKey;

        // Size changes can orphan measurement-guide rows.
        const product = await productRepository.findById(productId);
        if (product && product.measurementGuide) {
          const variants = await service.listVariantsForProduct(productId, {
            includeInactive: true,
          });
          const projected = variants.map((variant) =>
            String(variant._id) === String(existing._id)
              ? { ...variant.toObject ? variant.toObject() : variant, attributes: value.attributes }
              : variant
          );
          service.assertGuideMatchesVariantSizes(product.measurementGuide, projected);
        }
      }

      if (value.sellingPriceOverride !== undefined) {
        update.sellingPriceOverride = value.sellingPriceOverride;
      }
      if (value.purchasePriceOverride !== undefined) {
        update.purchasePriceOverride = value.purchasePriceOverride;
      }
      if (value.isActive !== undefined) {
        update.isActive = value.isActive;
      }

      if (Object.keys(update).length === 0) {
        throw invalid('No valid fields to update');
      }

      try {
        const updated = await repository.updateById(variantId, update);
        if (!updated) {
          throw new ApiError(
            404,
            VARIANT_MESSAGES.VARIANT_NOT_FOUND,
            ERROR_CODES.VARIANT_NOT_FOUND
          );
        }
        return updated;
      } catch (err) {
        if (service.isDuplicateKeyError(err)) {
          throw service.mapDuplicateKeyError(err);
        }
        throw err;
      }
    },

    async listVariantsForProduct(productId, { includeInactive = false } = {}) {
      const filter = { productId };
      if (!includeInactive) {
        filter.isActive = true;
      }
      return repository.findMany(filter, { sort: { _id: 1 } });
    },

    /**
     * Safe variant representation. Never exposes `_id`, `__v`, `attributeKey`,
     * or (unless includePurchasePrice) purchasePriceOverride.
     */
    toSafeVariant(variant, { includePurchasePrice = false } = {}) {
      const safe = {
        id: String(variant._id || variant.id),
        sku: variant.sku,
        attributes: variant.attributes || {},
        sellingPriceOverride: variant.sellingPriceOverride ?? null,
        isActive: variant.isActive,
        createdAt: variant.createdAt ? new Date(variant.createdAt).toISOString() : null,
        updatedAt: variant.updatedAt ? new Date(variant.updatedAt).toISOString() : null,
      };
      if (includePurchasePrice) {
        safe.purchasePriceOverride = variant.purchasePriceOverride ?? null;
      }
      return safe;
    },
  };

  return service;
}

module.exports = {
  createVariantService,
  buildAttributeKey,
  buildSkuBase,
  validateVariantInput,
  collectVariantSizes,
  assertGuideMatchesVariantSizes,
  isPlainObject,
};
