'use strict';

const slugify = require('../../utils/slugify');

/**
 * Centralized category constants.
 *
 * `slugify` is the SINGLE backend slug implementation (see
 * `src/utils/slugify.js`). It is re-exported here for the category model
 * setter and the category service — never re-implement slug logic elsewhere.
 */

const CATEGORY_LIMITS = Object.freeze({
  NAME_MAX: 100,
  SLUG_MAX: 120,
  DESCRIPTION_MAX: 1000,
  IMAGE_MAX: 500,
  SORT_ORDER_MIN: 0,
  SORT_ORDER_MAX: 9999,
});

/**
 * The complete set of client-writable category fields. Used by both the input
 * validator and the service to reject unknown/immutable keys (e.g. `_id`,
 * `createdAt`, or MongoDB operators such as `$set`). This is the field
 * allowlist that prevents mass-assignment and operator injection.
 */
const CATEGORY_FIELDS = Object.freeze([
  'name',
  'slug',
  'description',
  'image',
  'isActive',
  'sortOrder',
]);

const CATEGORY_MESSAGES = Object.freeze({
  LIST_FETCHED: 'Categories retrieved successfully',
  CATEGORY_FETCHED: 'Category retrieved successfully',
  CATEGORY_CREATED: 'Category created successfully',
  CATEGORY_UPDATED: 'Category updated successfully',
  CATEGORY_NOT_FOUND: 'Category not found',
  CATEGORY_ALREADY_EXISTS: 'A category with this name already exists',
  CATEGORY_SLUG_ALREADY_EXISTS: 'A category with this slug already exists',
  INVALID_CATEGORY: 'Invalid category data',
  INVALID_CATEGORY_ID: 'Invalid category id',
  INVALID_CATEGORY_SLUG: 'Invalid category slug',
  SLUG_GENERATION_FAILED: 'Category name cannot be converted to a URL slug',
});

module.exports = {
  CATEGORY_LIMITS,
  CATEGORY_FIELDS,
  CATEGORY_MESSAGES,
  slugify,
};
