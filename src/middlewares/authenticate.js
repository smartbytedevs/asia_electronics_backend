'use strict';

const ApiError = require('../utils/ApiError');
const {
  defaultVerifier,
  mapAuthClaims,
  JwtVerificationError,
} = require('../integrations/auth');

const MESSAGES = {
  UNAUTHORIZED: 'Authentication required',
};

/**
 * Authenticates a request by verifying the `Authorization: Bearer <token>`
 * header against the Better Auth JWKS, then maps the verified claims to the
 * normalized AUTHENTICATION identity on `req.auth`.
 *
 * - Missing/malformed/invalid/expired/tampered tokens → 401 (UNAUTHORIZED).
 * - `req.auth` carries only identity claims ({ authProviderId, email,
 *   displayName }); it deliberately carries NO role — the application role is
 *   resolved from the MongoDB User by `resolveCurrentUser` (see ADR-0011).
 * - Authorization decisions are made AFTER user resolution; never trust
 *   client-supplied role claims.
 * - Tokens are never logged and never echoed in responses.
 *
 * Accepts an optional verifier for tests; production uses the default verifier
 * bound to the centralized Better Auth configuration.
 */
function authenticate(verifier = defaultVerifier) {
  return async function authenticateMiddleware(req, res, next) {
    const token = extractBearerToken(req);
    if (!token) {
      return next(ApiError.unauthorized(MESSAGES.UNAUTHORIZED));
    }

    try {
      const { payload } = await verifier(token);
      req.auth = mapAuthClaims(payload);
      return next();
    } catch (err) {
      if (err instanceof JwtVerificationError) {
        return next(ApiError.unauthorized(MESSAGES.UNAUTHORIZED));
      }
      return next(err);
    }
  };
}

function extractBearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;

  const parts = header.split(' ');
  if (parts.length !== 2) return null;
  const [scheme, token] = parts;

  if (scheme.toLowerCase() !== 'bearer') return null;
  if (typeof token !== 'string' || token.length === 0) return null;
  return token;
}

module.exports = authenticate;
