'use strict';

/**
 * Shared variant size helpers (Phase 07 size selection).
 *
 * A variant's size lives in its `attributes` under a case-insensitive "size"
 * key and may be a single value ("52") or a packed list ("L, M, S" / "52/54").
 * These helpers centralise reading those tokens and replacing a variant's size
 * value (used when a customer picks ONE size out of a packed list).
 */

const SIZE_ATTRIBUTE_PATTERN = /^size$/i;
const SIZE_TOKEN_SEPARATOR = /\s*[,/&]\s*/;

function variantSizeAttribute(variant) {
  const attributes = variant && variant.attributes ? variant.attributes : {};
  const key = Object.keys(attributes).find((k) => SIZE_ATTRIBUTE_PATTERN.test(String(k).trim()));
  if (!key) {
    return null;
  }
  const value = String(attributes[key] ?? '').trim();
  return value ? { key, value } : null;
}

/** Individual size tokens for a variant ([] when it carries no size). */
function variantSizeTokens(variant) {
  const attr = variantSizeAttribute(variant);
  if (!attr) {
    return [];
  }
  return attr.value
    .split(SIZE_TOKEN_SEPARATOR)
    .map((size) => size.trim())
    .filter(Boolean);
}

/**
 * Returns a copy of `attributes` whose size value is replaced by
 * `selectedSize`. When the variant has no size attribute (or no size is
 * selected) the attributes are returned unchanged.
 */
function replaceVariantSize(attributes, selectedSize) {
  if (!selectedSize) {
    return attributes;
  }
  const attr = variantSizeAttribute({ attributes });
  if (!attr) {
    return attributes;
  }
  return { ...attributes, [attr.key]: selectedSize };
}

module.exports = {
  variantSizeAttribute,
  variantSizeTokens,
  replaceVariantSize,
};
