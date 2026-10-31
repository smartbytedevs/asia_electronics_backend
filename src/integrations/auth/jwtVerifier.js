'use strict';

const {
  createRemoteJWKSet,
  createLocalJWKSet,
  jwtVerify,
  errors: joseErrors,
} = require('jose');

/**
 * Errors produced by JWT verification. `reason` is a stable machine-readable
 * code used for observability; the message stays generic and never contains
 * token material, keys, or JWKS details.
 */
class JwtVerificationError extends Error {
  constructor(reason, message = 'Token verification failed') {
    super(message);
    this.name = 'JwtVerificationError';
    this.reason = reason;
  }
}

const REASONS = Object.freeze({
  NOT_CONFIGURED: 'VERIFIER_NOT_CONFIGURED',
  MALFORMED: 'TOKEN_MALFORMED',
  EXPIRED: 'TOKEN_EXPIRED',
  CLAIM_INVALID: 'CLAIM_VALIDATION_FAILED',
  SIGNATURE_INVALID: 'SIGNATURE_INVALID',
  NO_MATCHING_KEY: 'NO_MATCHING_KEY',
  KEY_SET_FAILURE: 'KEY_SET_FAILURE',
  ALGORITHM_NOT_ALLOWED: 'ALGORITHM_NOT_ALLOWED',
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
});

function toVerificationError(err) {
  if (err instanceof JwtVerificationError) return err;
  if (err instanceof joseErrors.JWTExpired) {
    return new JwtVerificationError(REASONS.EXPIRED);
  }
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    return new JwtVerificationError(REASONS.CLAIM_INVALID);
  }
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
    return new JwtVerificationError(REASONS.SIGNATURE_INVALID);
  }
  if (err instanceof joseErrors.JOSEAlgNotAllowed) {
    return new JwtVerificationError(REASONS.ALGORITHM_NOT_ALLOWED);
  }
  if (err instanceof joseErrors.JWKSNoMatchingKey) {
    return new JwtVerificationError(REASONS.NO_MATCHING_KEY);
  }
  if (
    err instanceof joseErrors.JWKSTimeout ||
    err instanceof joseErrors.JWKSInvalid ||
    err instanceof joseErrors.JWKInvalid
  ) {
    return new JwtVerificationError(REASONS.KEY_SET_FAILURE);
  }
  if (err instanceof joseErrors.JWTInvalid || err instanceof joseErrors.JWSInvalid) {
    return new JwtVerificationError(REASONS.MALFORMED);
  }
  return new JwtVerificationError(REASONS.VERIFICATION_FAILED);
}

/**
 * Creates a JWT verifier that cryptographically verifies tokens against a
 * public key set.
 *
 * Modes:
 *  - Remote (default): JWKS fetched from `jwksUrl` using jose's built-in
 *    caching and rotation handling (`createRemoteJWKSet`). Cache/cooldown/fetch
 *    behavior can be tuned via `jwksOptions`.
 *  - Local: pass `keys` (array of JWK objects) — used by tests/fixtures.
 *
 * The returned async function resolves to `{ payload, protectedHeader }` for a
 * valid token and throws `JwtVerificationError` otherwise. It never logs and
 * never exposes token material on failure.
 */
function createJwtVerifier({
  jwksUrl,
  keys,
  issuer,
  audience,
  algorithms = ['RS256'],
  clockTolerance = 30,
  jwksOptions = {},
}) {
  let keyset = null;
  if (keys) {
    keyset = createLocalJWKSet({ keys });
  } else if (jwksUrl) {
    keyset = createRemoteJWKSet(new URL(jwksUrl), jwksOptions);
  }

  const options = { algorithms, clockTolerance };
  if (issuer) options.issuer = issuer;
  if (audience) options.audience = audience;

  return async function verify(token) {
    if (!keyset) {
      throw new JwtVerificationError(
        REASONS.NOT_CONFIGURED,
        'Token verification is not configured'
      );
    }
    if (typeof token !== 'string' || token.length === 0) {
      throw new JwtVerificationError(REASONS.MALFORMED);
    }
    try {
      return await jwtVerify(token, keyset, options);
    } catch (err) {
      throw toVerificationError(err);
    }
  };
}

module.exports = { createJwtVerifier, JwtVerificationError, REASONS };
