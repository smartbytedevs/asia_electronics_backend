'use strict';

const mongoose = require('mongoose');
const { EXPENSE_LIMITS } = require('./expense.constants');

function isInteger(value) {
  return Number.isInteger(value);
}

/**
 * Expense — an ADMIN-recorded business cost line (Phase 13).
 *
 * All money is INTEGER MINOR UNITS (paisa). `createdBy` records the admin who
 * recorded the line for auditability. `expenseDate` defaults to the record
 * date but can be back-dated to the day the cost actually occurred, which is
 * also the field analytics aggregates on.
 */
const expenseSchema = new mongoose.Schema(
  {
    amountMinorUnits: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: isInteger,
        message: 'amountMinorUnits must be an integer',
      },
    },
    category: {
      type: String,
      default: null,
      trim: true,
      maxlength: EXPENSE_LIMITS.CATEGORY_MAX,
      description: 'Optional free-text cost label (no fixed enum yet)',
    },
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: EXPENSE_LIMITS.DESCRIPTION_MAX,
    },
    expenseDate: {
      type: Date,
      required: true,
      default: Date.now,
      description: 'Day the cost occurred; analytics aggregates on this field',
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      description: 'Admin who recorded the expense line',
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.__v;
        return ret;
      },
    },
  }
);

// Admin dashboard list + analytics date-range queries.
expenseSchema.index({ expenseDate: -1 });

module.exports = mongoose.model('Expense', expenseSchema);
