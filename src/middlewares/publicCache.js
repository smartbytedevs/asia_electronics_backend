'use strict';

/**
 * Public CDN caching for PUBLIC, non-personalized catalog GET responses.
 *
 * `requestContext` defaults EVERY response to `Cache-Control: no-store`. This
 * middleware overrides that only on routes explicitly declared public:
 *
 *   Cache-Control: public, max-age=0, s-maxage=<s>, stale-while-revalidate=<swr>
 *
 * `s-maxage` is what lets Vercel's edge cache serve repeat catalog reads
 * without invoking the serverless function (zero Active CPU for a cache hit).
 * `max-age=0` keeps browsers revalidating so a stale page does not linger on
 * the client.
 *
 * NEVER attach this to authenticated, admin, cart, order, payment, or any
 * personalized response. Error responses are forced back to `no-store` by the
 * error handler, so a 4xx/5xx is never cached.
 */
function publicCache({ sMaxAge = 60, staleWhileRevalidate = 300, maxAge = 0 } = {}) {
  const cacheControl = [
    'public',
    `max-age=${Math.max(0, maxAge)}`,
    `s-maxage=${Math.max(0, sMaxAge)}`,
    `stale-while-revalidate=${Math.max(0, staleWhileRevalidate)}`,
  ].join(', ');

  return function publicCacheMiddleware(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD') {
      res.setHeader('Cache-Control', cacheControl);
    }
    return next();
  };
}

module.exports = publicCache;
