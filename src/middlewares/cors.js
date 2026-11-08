'use strict';

const config = require('../config');

/**
 * CORS middleware (deployment production-readiness).
 *
 * The backend is a browser-consumed REST API deployed on Vercel while the
 * storefront/admin dashboards are separate origins, so cross-origin browser
 * requests need explicit opt-in:
 *
 *   - `config.cors.origins` (from the CORS_ORIGINS env var, comma-separated)
 *     is the production allowlist. Only requests whose `Origin` is listed get
 *     CORS headers; anything else is same-origin-only (no headers = blocked by
 *     the browser).
 *   - When NO origins are configured and the environment is NOT production
 *     (development/test), every origin is allowed for convenience.
 *   - When NO origins are configured in production, cross-origin requests are
 *     denied entirely (secure by default).
 *
 * The API never uses cookies; identity travels in `Authorization: Bearer` plus
 * the `Idempotency-Key` and `X-Guest-Id` headers, so `Access-Control-Allow-
 * Credentials` is intentionally NOT set.
 */

const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'Idempotency-Key',
  'X-Guest-Id',
  'X-Request-Id',
];
const EXPOSED_HEADERS = ['X-Request-Id', 'Retry-After'];
const PREFLIGHT_MAX_AGE_SECONDS = 86400;

function isAllowedOrigin(origin, allowedOrigins) {
  return typeof origin === 'string' && allowedOrigins.includes(origin);
}

function cors(cfg = config) {
  const allowedOrigins = cfg.cors.origins;
  const allowAllOrigins = allowedOrigins.length === 0 && cfg.env !== 'production';

  return function corsMiddleware(req, res, next) {
    const origin = req.headers.origin;

    let allowOrigin = null;
    if (allowAllOrigins && typeof origin === 'string') {
      allowOrigin = origin;
    } else if (isAllowedOrigin(origin, allowedOrigins)) {
      allowOrigin = origin;
    }

    // Vary tells caches the response differs by Origin even when no CORS
    // headers are emitted for a given origin.
    res.setHeader('Vary', 'Origin');

    if (allowOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowOrigin);
      res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS.join(', '));
      res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS.join(', '));
      res.setHeader('Access-Control-Expose-Headers', EXPOSED_HEADERS.join(', '));
      res.setHeader('Access-Control-Max-Age', String(PREFLIGHT_MAX_AGE_SECONDS));
    }

    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }

    return next();
  };
}

module.exports = cors;
