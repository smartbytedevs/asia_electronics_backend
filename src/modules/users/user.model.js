'use strict';

const mongoose = require('mongoose');
const { ROLES, ACCOUNT_STATUSES } = require('../../constants');

/**
 * Normalizes email to a stable, comparable form: trimmed and lower-cased.
 * The unique email index is defined over this normalized value.
 */
function normalizeEmail(value) {
  if (typeof value !== 'string') {
    return value;
  }
  return value.trim().toLowerCase();
}

/**
 * Taqwa APPLICATION User.
 *
 * Represents who this person is within Taqwa (role, status, profile) and what
 * they are allowed to do. It is deliberately NOT an authentication record:
 *
 *   - NO passwords / password hashes
 *   - NO Better Auth sessions or refresh tokens
 *   - NO authentication secrets
 *
 * Authentication identity (Better Auth) is mapped to this record via
 * `authProviderId`, which is unique and immutable so one Better Auth identity
 * maps to at most one Taqwa user.
 *
 * The stored `role` is the AUTHORITATIVE role for application authorization
 * (see docs/architecture.md §4 and ADR-0011).
 */
const userSchema = new mongoose.Schema(
  {
    authProviderId: {
      type: String,
      required: true,
      immutable: true,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      set: normalizeEmail,
    },
    role: {
      type: String,
      required: true,
      enum: Object.values(ROLES),
      default: ROLES.CUSTOMER,
    },
    status: {
      type: String,
      required: true,
      enum: Object.values(ACCOUNT_STATUSES),
      default: ACCOUNT_STATUSES.ACTIVE,
    },
    displayName: {
      type: String,
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
);

// One Better Auth identity → at most one Taqwa user. Primary lookup key.
userSchema.index({ authProviderId: 1 }, { unique: true });

// Emails are unique when present; docs without an email are allowed
// (sparse) because some Better Auth identities may lack one.
userSchema.index({ email: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('User', userSchema);
