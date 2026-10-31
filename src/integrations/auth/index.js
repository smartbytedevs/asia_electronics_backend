'use strict';

const config = require('../../config');
const { createJwtVerifier, JwtVerificationError, REASONS } = require('./jwtVerifier');
const { createAuthIdentityMapper, mapAuthClaims } = require('./identity');

/**
 * Default verifier bound to the centralized Better Auth configuration.
 *
 * In development/test BETTER_AUTH_JWKS_URL is optional; when unset the verifier
 * rejects every token with `VERIFIER_NOT_CONFIGURED` (authenticated endpoints
 * return 401). In production the config validation requires BETTER_AUTH_JWKS_URL.
 */
const defaultVerifier = createJwtVerifier({
  jwksUrl: config.auth.jwksUrl,
  issuer: config.auth.issuer,
  audience: config.auth.audience,
  algorithms: config.auth.algorithms,
  clockTolerance: config.auth.clockToleranceSeconds,
});

module.exports = {
  createJwtVerifier,
  JwtVerificationError,
  REASONS,
  createAuthIdentityMapper,
  mapAuthClaims,
  defaultVerifier,
};
