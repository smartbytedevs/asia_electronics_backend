'use strict';

/**
 * The SINGLE URL-slug implementation for the whole backend.
 *
 * Deterministic, idempotent URL slug generation: ASCII-safe, lower-cased,
 * runs of non-alphanumeric characters collapse to a single hyphen, and edge
 * hyphens are removed. E.g. "Baby Dresses" → "baby-dresses",
 * "baby-dresses-2" → "baby-dresses-2".
 *
 * Returns '' when the input contains no slug-able ASCII characters.
 *
 * Every domain that needs a slug (categories, products, ...) MUST import this
 * function — never re-implement slug logic elsewhere (see ADR-0012).
 */
function slugify(input) {
  if (typeof input !== 'string') {
    return '';
  }
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

module.exports = slugify;
