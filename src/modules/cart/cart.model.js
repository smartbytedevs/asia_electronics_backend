'use strict';

const mongoose = require('mongoose');
const { CART_LIMITS } = require('./cart.constants');

const { Schema } = mongoose;

function isInteger(value) {
  return Number.isInteger(value);
}

/**
 * Cart — server-side draft cart for ONE customer (Phase 07, ADR-0015).
 *
 * One cart per customer (`customerId` unique). A cart stores ONLY
 * `productVariantId` + `quantity` per line — it NEVER persists prices,
 * discounts, effective prices, or fees; all money is derived server-side from
 * the live catalog at read time and recomputed authoritatively at checkout.
 *
 * `isCheckedOut` is a soft-close flag: a successful checkout sets it and
 * clears `items` in the SAME transaction, so a cleared cart does not need to
 * be hard-deleted and can be reused by adding items again.
 */
const cartItemSchema = new Schema(
  {
    productVariantId: {
      type: Schema.Types.ObjectId,
      ref: 'ProductVariant',
      default: null,
    },
    productId: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      max: CART_LIMITS.QUANTITY_MAX,
      validate: {
        validator: isInteger,
        message: 'quantity must be an integer',
      },
    },
    selectedSize: {
      type: String,
      default: null,
      trim: true,
      maxlength: CART_LIMITS.SELECTED_SIZE_MAX,
    },
  },
  { _id: true }
);

const cartSchema = new Schema(
  {
    customerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    items: {
      type: [cartItemSchema],
      default: [],
      validate: {
        validator: (items) => items.length <= CART_LIMITS.ITEMS_MAX,
        message: `A cart cannot contain more than ${CART_LIMITS.ITEMS_MAX} items`,
      },
    },
    isCheckedOut: {
      type: Boolean,
      required: true,
      default: false,
    },
  },
  { timestamps: true }
);

// One cart per customer — the database-level guard for concurrent first-add
// races (the service maps the duplicate key to CART_NOT_FOUND, then returns
// the existing cart).
cartSchema.index({ customerId: 1 }, { unique: true });

module.exports = mongoose.model('Cart', cartSchema);
