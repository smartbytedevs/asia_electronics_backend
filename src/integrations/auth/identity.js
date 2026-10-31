'use strict';

const { JwtVerificationError, REASONS } = require('./jwtVerifier');

/**
 * Maps verified JWT claims to the normalized AUTHENTICATION identity (attached
 * to `req.auth` by the `authenticate` middleware).
 *
 * This is the single place responsible for interpreting JWT identity claims.
 *
 * Security: the token's `role` claim is intentionally NOT copied. The JWT only
 * establishes WHO the subject is; the application role lives in the MongoDB
 * User record and is the authoritative role for authorization (see
 * docs/architecture.md §4 and ADR-0011). A client-controlled role claim must
 * never reach authorization.
 *
 * A valid authentication identity MUST carry a stable subject id
 * (authProviderId). Tokens that cannot be mapped are rejected as an
 * authentication failure — they are never partially accepted.
 */
function createAuthIdentityMapper({
  idClaim = 'sub',
  emailClaim = 'email',
  nameClaim = 'name',
} = {}) {
  return function mapAuthClaims(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new JwtVerificationError(REASONS.MALFORMED);
    }

    const authProviderId = payload[idClaim];
    if (typeof authProviderId !== 'string' || authProviderId.length === 0) {
      throw new JwtVerificationError(
        REASONS.CLAIM_INVALID,
        'Token is missing a user id'
      );
    }

    const identity = { authProviderId };
    if (typeof payload[emailClaim] === 'string' && payload[emailClaim].length > 0) {
      identity.email = payload[emailClaim];
    }
    if (typeof payload[nameClaim] === 'string' && payload[nameClaim].length > 0) {
      identity.displayName = payload[nameClaim];
    }
    return identity;
  };
}

// Default mapper (Better Auth style claims) used across the app.
const mapAuthClaims = createAuthIdentityMapper();

module.exports = { createAuthIdentityMapper, mapAuthClaims };
