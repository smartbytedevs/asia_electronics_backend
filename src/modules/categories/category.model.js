'use strict';

const mongoose = require('mongoose');
const { CATEGORY_LIMITS, slugify } = require('./category.constants');

/**
 * Taqwa Category — catalog taxonomy entity (Phase 04).
 *
 * A category is a generic taxonomy node for the catalog. It is deliberately
 * decoupled from Product: no product/variant/stock fields live here, and no
 * Product model exists yet (see ADR-0012 and docs/architecture.md §15).
 *
 * Lifecycle:
 * - Categories are deactivated (`isActive: false`), not hard-deleted, so
 *   future products/orders can keep historical references. There is no DELETE
 *   endpoint in this phase and no cascading deletion.
 * - `slug` is a stable, unique, URL-safe identifier normalized through the
 *   single `slugify` implementation. The unique index is the final consistency
 *   layer for slug (and name) collisions.
 */
const categorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: CATEGORY_LIMITS.NAME_MAX,
    },
    slug: {
      type: String,
      required: true,
      trim: true,
      set: slugify,
      maxlength: CATEGORY_LIMITS.SLUG_MAX,
    },
    description: {
      type: String,
      trim: true,
      maxlength: CATEGORY_LIMITS.DESCRIPTION_MAX,
    },
    image: {
      type: String,
      trim: true,
      maxlength: CATEGORY_LIMITS.IMAGE_MAX,
    },
    isActive: {
      type: Boolean,
      default: true,
      required: true,
    },
    sortOrder: {
      type: Number,
      default: 0,
      min: CATEGORY_LIMITS.SORT_ORDER_MIN,
      max: CATEGORY_LIMITS.SORT_ORDER_MAX,
    },
  },
  { timestamps: true }
);

// Stable public URL identifier — unique. Final consistency layer for slug
// collisions (the service additionally performs friendly pre-checks).
categorySchema.index({ slug: 1 }, { unique: true });

// Human-readable names are unique. Prevents near-duplicate taxonomy.
categorySchema.index({ name: 1 }, { unique: true });

// Supports the public catalog ordering: active categories sorted by
// sortOrder then creation time.
categorySchema.index({ isActive: 1, sortOrder: 1, createdAt: 1 });

module.exports = mongoose.model('Category', categorySchema);
