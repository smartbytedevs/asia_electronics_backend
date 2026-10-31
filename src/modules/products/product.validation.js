'use strict';

const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const {
  PRODUCT_LIMITS,
  PRODUCT_FIELDS,
  DISCOUNT_TYPES,
  slugify,
} = require('./product.constants');

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;
const IMAGE_URL_PATTERN = /^https?:\/\/\S+$/i;

function invalid(message) {
  return new ApiError(400, message, ERROR_CODES.INVALID_PRODUCT);
}

function invalidMeasurement(message) {
  return new ApiError(400, message, ERROR_CODES.INVALID_MEASUREMENT_GUIDE);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertNoUnknownKeys(data, allowlist, messagePrefix) {
  const unknownKeys = Object.keys(data).filter((key) => !allowlist.includes(key));
  if (unknownKeys.length > 0) {
    throw invalid(`${messagePrefix} unknown field(s): ${unknownKeys.join(', ')}`);
  }
}

function assertInteger(value, name, { min = null, max = null } = {}) {
  if (!Number.isInteger(value)) {
    throw invalid(`${name} must be an integer`);
  }
  if (min !== null && value < min) {
    throw invalid(`${name} must be at least ${min}`);
  }
  if (max !== null && value > max) {
    throw invalid(`${name} must be at most ${max}`);
  }
}

function normalizeImages(raw) {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw invalid('images must be a non-empty array of { url, alt?, sortOrder? }');
  }
  if (raw.length > PRODUCT_LIMITS.IMAGES_MAX) {
    throw invalid(`images must contain at most ${PRODUCT_LIMITS.IMAGES_MAX} items`);
  }
  return raw.map((image, index) => {
    if (!isPlainObject(image)) {
      throw invalid('each image must be an object with a url');
    }
    const url = typeof image.url === 'string' ? image.url.trim() : '';
    if (!IMAGE_URL_PATTERN.test(url)) {
      throw invalid('each image url must be a valid http(s) URL');
    }
    if (url.length > PRODUCT_LIMITS.IMAGE_URL_MAX) {
      throw invalid(`image url must be at most ${PRODUCT_LIMITS.IMAGE_URL_MAX} characters`);
    }
    let alt = image.alt === undefined ? null : image.alt;
    if (alt !== null && typeof alt !== 'string') {
      throw invalid('image alt must be a string or null');
    }
    alt = alt === null ? '' : alt.trim();
    if (alt.length > PRODUCT_LIMITS.IMAGE_ALT_MAX) {
      throw invalid(`image alt must be at most ${PRODUCT_LIMITS.IMAGE_ALT_MAX} characters`);
    }
    let sortOrder = image.sortOrder === undefined ? index : image.sortOrder;
    assertInteger(sortOrder, 'image sortOrder', {
      min: PRODUCT_LIMITS.IMAGE_SORT_ORDER_MIN,
      max: PRODUCT_LIMITS.IMAGE_SORT_ORDER_MAX,
    });
    return { url, alt, sortOrder };
  });
}

function normalizeDiscount(raw) {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (!isPlainObject(raw)) {
    throw invalid('discount must be null or { type, value }');
  }
  const type = raw.type;
  if (type !== DISCOUNT_TYPES.PERCENTAGE && type !== DISCOUNT_TYPES.FIXED) {
    throw invalid(`discount.type must be "${DISCOUNT_TYPES.PERCENTAGE}" or "${DISCOUNT_TYPES.FIXED}"`);
  }
  const value = raw.value;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalid('discount.value must be a finite number');
  }
  if (type === DISCOUNT_TYPES.PERCENTAGE) {
    if (value <= 0 || value > PRODUCT_LIMITS.DISCOUNT_PERCENT_MAX) {
      throw invalid(
        `percentage discount must be greater than 0 and at most ${PRODUCT_LIMITS.DISCOUNT_PERCENT_MAX}`
      );
    }
  } else {
    assertInteger(value, 'fixed discount.value', { min: PRODUCT_LIMITS.PRICE_MIN });
  }
  return { type, value };
}

function normalizePrice(raw, name, { required = false } = {}) {
  if (raw === undefined || raw === null) {
    if (required) {
      throw invalid(`${name} is required`);
    }
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

function normalizeCategoryId(raw) {
  if (raw === undefined || raw === null) {
    throw invalid('categoryId is required');
  }
  if (typeof raw !== 'string' || !OBJECT_ID_PATTERN.test(raw)) {
    throw invalid('categoryId must be a valid 24-character hex ObjectId');
  }
  return raw;
}

function normalizeMeasurementGuide(raw) {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (!isPlainObject(raw)) {
    throw invalidMeasurement('measurementGuide must be an object or null');
  }
  const unknownGuideKeys = Object.keys(raw).filter((key) => !['imageUrl'].includes(key));
  if (unknownGuideKeys.length > 0) {
    throw invalidMeasurement(
      `measurementGuide unknown field(s): ${unknownGuideKeys.join(', ')}`
    );
  }

  if (raw.imageUrl === undefined || raw.imageUrl === null) {
    return null;
  }
  if (typeof raw.imageUrl !== 'string' || !IMAGE_URL_PATTERN.test(raw.imageUrl.trim())) {
    throw invalidMeasurement('measurementGuide.imageUrl must be a valid http(s) URL');
  }
  const imageUrl = raw.imageUrl.trim();
  if (imageUrl.length > PRODUCT_LIMITS.IMAGE_URL_MAX) {
    throw invalidMeasurement(
      `measurementGuide.imageUrl must be at most ${PRODUCT_LIMITS.IMAGE_URL_MAX} characters`
    );
  }
  return { imageUrl };
}

function normalizeVariants(raw) {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw invalid('variants must be an array');
  }
  if (raw.length > PRODUCT_LIMITS.VARIANTS_MAX) {
    throw invalid(`variants must contain at most ${PRODUCT_LIMITS.VARIANTS_MAX} items`);
  }
  return raw;
}

function normalizeBrand(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return '';
  }
  if (typeof raw !== 'string') {
    throw invalid('brand must be a string');
  }
  const brand = raw.trim();
  if (brand.length > PRODUCT_LIMITS.BRAND_MAX) {
    throw invalid(`brand must be at most ${PRODUCT_LIMITS.BRAND_MAX} characters`);
  }
  return brand;
}

function normalizeModelNumber(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return '';
  }
  if (typeof raw !== 'string') {
    throw invalid('modelNumber must be a string');
  }
  const modelNumber = raw.trim();
  if (modelNumber.length > PRODUCT_LIMITS.MODEL_NUMBER_MAX) {
    throw invalid(`modelNumber must be at most ${PRODUCT_LIMITS.MODEL_NUMBER_MAX} characters`);
  }
  return modelNumber;
}

function normalizeWarrantyPeriod(raw) {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!Number.isInteger(raw)) {
    throw invalid('warrantyPeriod must be an integer (months)');
  }
  if (raw < PRODUCT_LIMITS.WARRANTY_PERIOD_MIN || raw > PRODUCT_LIMITS.WARRANTY_PERIOD_MAX) {
    throw invalid(
      `warrantyPeriod must be between ${PRODUCT_LIMITS.WARRANTY_PERIOD_MIN} and ${PRODUCT_LIMITS.WARRANTY_PERIOD_MAX} months`
    );
  }
  return raw;
}

function normalizeSpecifications(raw) {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalid('specifications must be a JSON object');
  }
  try {
    JSON.stringify(raw);
  } catch (e) {
    throw invalid('specifications must be valid JSON');
  }
  return raw;
}

function normalizeStockKeepingUnit(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }
  if (typeof raw !== 'string') {
    throw invalid('stockKeepingUnit must be a string');
  }
  const sku = raw.trim().toUpperCase();
  if (sku.length === 0) {
    return undefined;
  }
  if (sku.length > PRODUCT_LIMITS.SKU_MAX) {
    throw invalid(`stockKeepingUnit must be at most ${PRODUCT_LIMITS.SKU_MAX} characters`);
  }
  if (!/^[A-Z0-9][A-Z0-9-_]*$/.test(sku)) {
    throw invalid('stockKeepingUnit contains invalid characters');
  }
  return sku;
}

function assertNoMongoOperators(data) {
  for (const key of Object.keys(data)) {
    if (key.startsWith('$')) {
      throw invalid(`MongoDB update operators are not allowed (found "${key}")`);
    }
  }
}

/**
 * Validates and normalizes a Product payload.
 *
 * - `partial=true` (PATCH) makes every field optional; `create` requires
 *   `name`, `categoryId`, and `sellingPrice`. `variants` is optional — a
 *   product may be created with no variants.
 * - Rejects unknown/immutable keys, Mongo operators, and non-object bodies.
 * - Normalizes slugs through the single backend `slugify`.
 *
 * Returns `{ value, variants }` where `variants` is the raw variant array
 * (the variant service validates each entry), or `undefined` when omitted.
 * Throws 400 ApiError otherwise.
 */
function validateProductInput(body, { partial = false } = {}) {
  if (!isPlainObject(body)) {
    throw invalid('Request body must be an object');
  }
  assertNoMongoOperators(body);
  assertNoUnknownKeys(body, PRODUCT_FIELDS, 'product');

  const value = {};
  let variants;

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      throw invalid('name is required and must be a non-empty string');
    }
    const name = body.name.trim();
    if (name.length > PRODUCT_LIMITS.NAME_MAX) {
      throw invalid(`name must be at most ${PRODUCT_LIMITS.NAME_MAX} characters`);
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
    if (!normalized) {
      throw invalid('slug must contain at least one letter or number');
    }
    if (normalized.length > PRODUCT_LIMITS.SLUG_MAX) {
      throw invalid(`slug must be at most ${PRODUCT_LIMITS.SLUG_MAX} characters`);
    }
    value.slug = normalized;
  }

  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== 'string') {
      throw invalid('description must be a string or null');
    }
    const description =
      body.description === null ? '' : body.description.trim();
    if (description.length > PRODUCT_LIMITS.DESCRIPTION_MAX) {
      throw invalid(
        `description must be at most ${PRODUCT_LIMITS.DESCRIPTION_MAX} characters`
      );
    }
    value.description = description;
  }

  if (body.categoryId !== undefined) {
    value.categoryId = normalizeCategoryId(body.categoryId);
  } else if (!partial) {
    throw invalid('categoryId is required');
  }

  if (body.images !== undefined) {
    value.images = normalizeImages(body.images);
  }

  if (body.sellingPrice !== undefined) {
    value.sellingPrice = normalizePrice(body.sellingPrice, 'sellingPrice', {
      required: false,
    });
  } else if (!partial) {
    throw invalid('sellingPrice is required');
  }

  if (body.purchasePrice !== undefined) {
    value.purchasePrice = normalizePrice(body.purchasePrice, 'purchasePrice');
  }

  if (body.discount !== undefined) {
    value.discount = normalizeDiscount(body.discount);
  }

  for (const flag of ['featured', 'newArrival', 'bestDeal']) {
    if (body[flag] !== undefined) {
      if (typeof body[flag] !== 'boolean') {
        throw invalid(`${flag} must be a boolean`);
      }
      value[flag] = body[flag];
    }
  }

  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') {
      throw invalid('isActive must be a boolean');
    }
    value.isActive = body.isActive;
  }

  if (body.measurementGuide !== undefined) {
    value.measurementGuide = normalizeMeasurementGuide(body.measurementGuide);
  }

  if (body.variants !== undefined) {
    variants = normalizeVariants(body.variants);
  }

  if (body.brand !== undefined) {
    value.brand = normalizeBrand(body.brand);
  }

  if (body.modelNumber !== undefined) {
    value.modelNumber = normalizeModelNumber(body.modelNumber);
  }

  if (body.warrantyPeriod !== undefined) {
    value.warrantyPeriod = normalizeWarrantyPeriod(body.warrantyPeriod);
  }

  if (body.specifications !== undefined) {
    value.specifications = normalizeSpecifications(body.specifications);
  }

  if (body.stockKeepingUnit !== undefined) {
    value.stockKeepingUnit = normalizeStockKeepingUnit(body.stockKeepingUnit);
  }

  return { value, variants };
}

/**
 * Cross-field structural check: a fixed discount cannot exceed the selling
 * price (percentage discounts are bounded by normalizeDiscount already).
 * Runs in the service (which knows the effective sellingPrice) and here when
 * both values arrive in the same payload.
 */
function assertDiscountWithinPrice(discount, sellingPrice) {
  if (
    discount &&
    discount.type === DISCOUNT_TYPES.FIXED &&
    sellingPrice !== undefined &&
    discount.value > sellingPrice
  ) {
    throw invalid('fixed discount cannot exceed the selling price');
  }
}

module.exports = {
  validateProductInput,
  assertDiscountWithinPrice,
  isPlainObject,
  OBJECT_ID_PATTERN,
};
