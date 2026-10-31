'use strict';

const mongoose = require('mongoose');
const { OUTLET_LIMITS } = require('./outlet.constants');

const { Schema } = mongoose;

/**
 * Outlet — a physical store the business operates (Phase 14).
 *
 * Per-outlet inventory keys each Inventory record by `productVariantId +
 * outletId`. `outletId: null` on an Inventory record is the CENTRAL / online
 * pool (the storefront-visible stock that reservations draw from); every
 * physical outlet gets its own Inventory record.
 *
 * `code` is a stable, globally unique operator label (e.g. "CTG-MAIN",
 * "DHK-GULSHAN"). It is the natural lookup key for warehouse integrations and
 * is unique at the database level.
 */
const outletSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: OUTLET_LIMITS.NAME_MAX,
    },
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: OUTLET_LIMITS.CODE_MAX,
      match: /^[A-Z0-9][A-Z0-9_-]*$/,
    },
    address: {
      type: String,
      trim: true,
      default: null,
      maxlength: OUTLET_LIMITS.ADDRESS_MAX,
    },
    phone: {
      type: String,
      trim: true,
      default: null,
      maxlength: OUTLET_LIMITS.PHONE_MAX,
    },
    // Catalog/operations status: an outlet can be deactivated without deleting
    // it (historical inventory references stay intact).
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Outlet codes are globally unique — enforced at the database level.
outletSchema.index({ code: 1 }, { unique: true });

module.exports = mongoose.model('Outlet', outletSchema);
