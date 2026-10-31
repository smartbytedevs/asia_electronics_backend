'use strict';

const mongoose = require('mongoose');
const { REVIEW_STATUSES, REVIEW_LIMITS } = require('./review.constants');

const { Schema } = mongoose;

const statusHistorySchema = new Schema(
  {
    status: {
      type: String,
      required: true,
      enum: REVIEW_STATUSES,
    },
    at: { type: Date, required: true, default: Date.now },
    by: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    note: { type: String, default: null, trim: true, maxlength: REVIEW_LIMITS.NOTE_MAX },
  },
  { _id: false }
);

/**
 * Review — a customer's rating/comment about a PRODUCT (Phase 12: Product
 * Reviews + Admin Moderation).
 *
 * Customers submit reviews that start PENDING; an ADMIN approves or rejects
 * them. Only APPROVED reviews are publicly visible — public endpoints ALWAYS
 * filter on `status: APPROVED`. `customerId` is always the authenticated
 * application user (never a client-supplied value); `customerDisplayName` is a
 * snapshot taken at submission time so public reviews can display the author
 * without a cross-collection join. `statusHistory` records every transition
 * with the acting user.
 */
const reviewSchema = new Schema(
  {
    productId: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
      index: true,
    },
    customerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    customerDisplayName: {
      type: String,
      trim: true,
      maxlength: REVIEW_LIMITS.DISPLAY_NAME_MAX,
      default: null,
    },
    rating: {
      type: Number,
      required: true,
      min: REVIEW_LIMITS.RATING_MIN,
      max: REVIEW_LIMITS.RATING_MAX,
      validate: {
        validator: (value) => Number.isInteger(value),
        message: 'rating must be an integer',
      },
    },
    comment: {
      type: String,
      trim: true,
      maxlength: REVIEW_LIMITS.COMMENT_MAX,
      default: null,
    },
    status: {
      type: String,
      required: true,
      default: REVIEW_STATUSES.PENDING,
      enum: REVIEW_STATUSES,
    },
    statusHistory: {
      type: [statusHistorySchema],
      required: true,
      default: [],
    },
    approvedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    approvedAt: { type: Date, default: null },
    rejectedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    rejectedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Public list: a product's APPROVED reviews, newest first.
reviewSchema.index({ productId: 1, status: 1, createdAt: -1 });

// Admin list: filter by status, newest first.
reviewSchema.index({ status: 1, createdAt: -1 });

// Customer review history (future customer-facing listing).
reviewSchema.index({ customerId: 1, createdAt: -1 });

module.exports = mongoose.model('Review', reviewSchema);
