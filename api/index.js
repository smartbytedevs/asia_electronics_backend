'use strict';

const app = require('../src/app');

/**
 * Vercel serverless function entrypoint.
 *
 * Vercel routes every /api/* request here (see vercel.json rewrites) and
 * reuses the same Node instance for warm invocations, so the existing Express
 * app (src/app.js) is served as a plain (req, res) handler. MongoDB is
 * connected lazily by the app itself when running under Vercel (see the VERCEL
 * guard in src/app.js); local development and the test suite are unaffected.
 *
 * The long-lived boot path (src/server.js) is NOT used here: it starts an HTTP
 * listener and the courier reconciliation scheduler (setInterval), neither of
 * which is reliable in a serverless runtime. Keep COURIER_RECONCILE_ENABLED
 * false in production or run reconciliation from a dedicated worker instead.
 */

module.exports = function handler(req, res) {
  app(req, res);
};
