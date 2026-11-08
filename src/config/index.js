'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Loads `.env` from the repository root into process.env.
 * Uses Node's built-in loader (Node >= 20.12.0) — no dotenv dependency.
 */
function loadEnvFile() {
  try {
    const envPath = path.resolve(__dirname, '..', '..', '.env');
    if (fs.existsSync(envPath)) {
      process.loadEnvFile(envPath);
    }
  } catch (err) {
    // Serverless runtimes (e.g. Vercel) may mount read-only filesystems and
    // never ship a .env file; environment variables come from the platform.
    // Never fail configuration because a local .env cannot be loaded.
    console.warn(`[config] Could not load .env file: ${err && err.message}`);
  }
}

loadEnvFile();

const PATHAO_SANDBOX_BASE_URL = 'https://courier-api-sandbox.pathao.com';
const PATHAO_PRODUCTION_BASE_URL = 'https://api-hermes.pathao.com';

// Pathao's publicly published sandbox demo credentials (documented in
// ADR-0017). They are NOT secrets. They are embedded here ONLY so the config
// can fail fast when a sandbox demo value accidentally reaches production.
const PATHAO_SANDBOX_DEMO_CREDENTIALS = Object.freeze({
  clientId: '7N1aMJQbWm',
  clientSecret: 'wRcaibZkUdSNz2EI9ZyuXLlNrnAv0TdPUPXMnD39',
  username: 'test@pathao.com',
  password: 'lovePathao',
  storeId: '56088',
});

const NODE_ENV = process.env.NODE_ENV || 'development';

// Pathao environment selection. Production always defaults to Hermes unless
// PATHAO_BASE_URL is intentionally provided; every other environment uses the
// public sandbox.
const PATHAO_BASE_URL =
  process.env.PATHAO_BASE_URL ||
  (NODE_ENV === 'production' ? PATHAO_PRODUCTION_BASE_URL : PATHAO_SANDBOX_BASE_URL);

const RECONCILE_INTERVAL_MIN_MS = 1000;
const RECONCILE_INTERVAL_DEFAULT_MS = 15 * 60 * 1000;

const EMAIL_PORT = Number.parseInt(process.env.EMAIL_PORT, 10) || 587;
const NOTIFICATIONS_DEDUPE_WINDOW_DEFAULT_MS = 60 * 60 * 1000;

/**
 * Parses COURIER_RECONCILE_INTERVAL_MS into a safe positive integer. Missing,
 * non-integer, out-of-range, or below-the-floor values fall back to the
 * default — a 0/negative/absurdly-small interval would create a busy
 * reconciliation loop against the provider.
 */
function parseReconcileIntervalMs(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return RECONCILE_INTERVAL_DEFAULT_MS;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < RECONCILE_INTERVAL_MIN_MS) {
    return RECONCILE_INTERVAL_DEFAULT_MS;
  }
  return parsed;
}

/**
 * Strips trailing slashes from a base URL so URLs assembled from it never
 * contain a double slash (e.g. ".../admin/orders/<id>").
 */
function normalizeBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

/**
 * Centralized configuration.
 *
 * Future code MUST NOT read process.env directly; it should read from this
 * module so that variables are parsed, validated, and documented in one place.
 *
 * Validation:
 * - MONGODB_URI is REQUIRED for the application (the server refuses to start
 *   without a reachable database). It throws in production (fail fast) and
 *   warns in development; running the server without it always fails clearly.
 * - BETTER_AUTH_JWKS_URL is REQUIRED in production (fail fast); in development
 *   and test it is optional and only disables authentication (protected routes
 *   reject all tokens).
 * - Future integrations (Pathao, Cloudinary, email) stay optional until their
 *   phases tighten validation.
 */
const config = {
  env: NODE_ENV,
  port: Number.parseInt(process.env.PORT, 10) || 4000,

  db: {
    uri: process.env.MONGODB_URI || '',
    // Bounded timeouts so an unreachable/overloaded database fails fast and
    // the API can return a retryable 503 instead of hanging until the
    // serverless function times out. All values are tunable per environment.
    serverSelectionTimeoutMs:
      Number.parseInt(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS, 10) || 10000,
    connectTimeoutMs:
      Number.parseInt(process.env.MONGODB_CONNECT_TIMEOUT_MS, 10) || 10000,
    socketTimeoutMs:
      Number.parseInt(process.env.MONGODB_SOCKET_TIMEOUT_MS, 10) || 45000,
    waitQueueTimeoutMs:
      Number.parseInt(process.env.MONGODB_WAIT_QUEUE_TIMEOUT_MS, 10) || 10000,
    maxPoolSize: Number.parseInt(process.env.MONGODB_MAX_POOL_SIZE, 10) || 10,
    minPoolSize: Number.parseInt(process.env.MONGODB_MIN_POOL_SIZE, 10) || 0,
    maxIdleTimeMs:
      Number.parseInt(process.env.MONGODB_MAX_IDLE_TIME_MS, 10) || 60000,
    autoIndex:
      process.env.MONGODB_AUTO_INDEX !== undefined
        ? (process.env.MONGODB_AUTO_INDEX || 'false').toLowerCase() === 'true'
        : NODE_ENV !== 'production',
  },

  auth: {
    // Issuer/audience/JWKS must match the frontend Better Auth configuration
    // exactly (see src/integrations/auth/jwtVerifier.js). Production
    // validation below fail-fasts when any of them is missing, not https, or
    // points at localhost.
    jwksUrl: process.env.BETTER_AUTH_JWKS_URL || '',
    issuer: process.env.BETTER_AUTH_ISSUER || '',
    audience: process.env.BETTER_AUTH_AUDIENCE || '',
    // Comma-separated allowlist of accepted JWS algorithms. Tokens signed with
    // any other algorithm are rejected (prevents algorithm-confusion attacks).
    algorithms: (process.env.BETTER_AUTH_ALGORITHMS || 'RS256')
      .split(',')
      .map((alg) => alg.trim())
      .filter(Boolean),
    // Leeway (seconds) for clock skew between the frontend and this backend.
    clockToleranceSeconds:
      Number.parseInt(process.env.BETTER_AUTH_CLOCK_TOLERANCE_SECONDS, 10) || 30,
  },

  users: {
    // When an authenticated request arrives with a verified identity that has
    // no application User record, auto-create a CUSTOMER user. This is the ONLY
    // automatic provisioning path: ADMIN/STAFF are never created from JWT claims
    // and must be set up by trusted application-side processes.
    autoProvisionCustomers:
      (process.env.AUTO_PROVISION_CUSTOMERS || 'true').toLowerCase() === 'true',
  },

  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
    apiKey: process.env.CLOUDINARY_API_KEY || '',
    apiSecret: process.env.CLOUDINARY_API_SECRET || '',
  },

  pathao: {
    // 'sandbox' in every non-production environment (development/test default)
    // vs 'production'. Matches the application env; the actual target host is
    // `baseUrl`. Production validation rejects a sandbox `baseUrl`.
    mode: NODE_ENV === 'production' ? 'production' : 'sandbox',
    // Production defaults to Hermes (https://api-hermes.pathao.com) unless
    // PATHAO_BASE_URL is intentionally provided; every other environment uses
    // the public sandbox. Production validation rejects a sandbox base URL.
    baseUrl: PATHAO_BASE_URL,
    clientId: process.env.PATHAO_CLIENT_ID || '',
    clientSecret: process.env.PATHAO_CLIENT_SECRET || '',
    username: process.env.PATHAO_USERNAME || '',
    password: process.env.PATHAO_PASSWORD || '',
    storeId: process.env.PATHAO_STORE_ID || '',
    // Outbound HTTP timeout (ms) for token + courier API calls.
    timeoutMs: Number.parseInt(process.env.PATHAO_TIMEOUT_MS, 10) || 15000,
    // Shared secret for Pathao webhook signature verification
    // (X-Pathao-Signature header). Empty disables webhook acceptance.
    webhookSecret: process.env.PATHAO_WEBHOOK_SECRET || '',
    // Fallback parcel weight in kg (Pathao requires 0.5–10). The order does
    // not capture item weights yet; dispatch uses this single value.
    defaultItemWeightKg: Number.parseFloat(process.env.PATHAO_DEFAULT_ITEM_WEIGHT_KG) || 0.5,
  },

  courier: {
    // Provider selection: 'mock' (deterministic, no credentials — used by
    // development and the test suite) or 'pathao'. Production MUST set
    // COURIER_PROVIDER=pathao explicitly; running production on 'mock' emits a
    // loud warning. COURIER_PROVIDER=pathao requires all five PATHAO_*
    // credentials — missing values, sandbox demo credentials, or a sandbox
    // base URL all fail fast in production.
    provider: process.env.COURIER_PROVIDER || 'mock',
    // Best-effort courier dispatch immediately after an admin confirms an
    // order (true) vs. explicit dispatch via POST /admin/orders/:id/courier/
    // dispatch (false). Defaults to false so confirming never creates real
    // courier orders implicitly.
    autoDispatchOnConfirm:
      (process.env.COURIER_AUTO_DISPATCH_ON_CONFIRM || 'false').toLowerCase() === 'true',
    // Periodic reconciliation of ACTIVE shipments with the provider.
    reconcileEnabled:
      (process.env.COURIER_RECONCILE_ENABLED || 'false').toLowerCase() === 'true',
    // Interval between reconciliation passes (ms). Invalid values (0, negative,
    // NaN, non-integer, below the 1000 ms floor, out of safe-integer range)
    // fall back to the 15-minute default.
    reconcileIntervalMs: parseReconcileIntervalMs(process.env.COURIER_RECONCILE_INTERVAL_MS),
    // A shipment is stale once it has not been checked for this long.
    reconcileStaleAfterMs:
      Number.parseInt(process.env.COURIER_RECONCILE_STALE_AFTER_MS, 10) || 5 * 60 * 1000,
  },

  email: {
    // Provider selection: 'mock' (deterministic, in-memory — used by
    // development and the test suite) or 'smtp'. Production MUST set
    // EMAIL_PROVIDER=smtp explicitly; running production on 'mock' emits a
    // loud warning.
    provider: process.env.EMAIL_PROVIDER || 'mock',
    host: process.env.EMAIL_HOST || '',
    port: EMAIL_PORT,
    user: process.env.EMAIL_USER || '',
    password: process.env.EMAIL_PASSWORD || '',
    from: process.env.EMAIL_FROM || '',
    // Outbound SMTP timeout (ms) for connect + per-command round trips.
    timeoutMs: Number.parseInt(process.env.EMAIL_TIMEOUT_MS, 10) || 15000,
    // Implicit-TLS (SMTPS, port 465) vs. opportunistic STARTTLS (587).
    // Defaults to true only when EMAIL_PORT is 465; EMAIL_SECURE overrides.
    secure:
      process.env.EMAIL_SECURE !== undefined && process.env.EMAIL_SECURE !== ''
        ? (process.env.EMAIL_SECURE || 'false').toLowerCase() === 'true'
        : EMAIL_PORT === 465,
  },

  admin: {
    // Recipient of the admin NEW ORDER email (Phase 11, ADR-0019). Every
    // successfully placed order triggers a separate HTML email to this address
    // in addition to the customer confirmation. Empty disables the admin email
    // (the order flow never fails because of it).
    email: process.env.ADMIN_EMAIL || '',
    // Base URL of the admin dashboard, used to build the "View Order in Admin
    // Dashboard" link in the admin NEW ORDER email. Trailing slashes are
    // stripped. Defaults to the local admin dashboard for development.
    dashboardBaseUrl: normalizeBaseUrl(
      process.env.ADMIN_DASHBOARD_BASE_URL || 'http://localhost:3000'
    ),
  },

  storefront: {
    // Base URL of the public customer storefront, used to build the "Track Your
    // Order" link in the customer ORDER_PLACED email. Trailing slashes are
    // stripped. Defaults to the local storefront for development; empty leaves
    // the tracking CTA out of the email entirely.
    baseUrl: normalizeBaseUrl(process.env.STORE_URL || 'http://localhost:3000'),
  },

  notifications: {
    // Master switch for customer notifications (Phase 11, ADR-0019). When
    // disabled the NotificationService is a no-op and business flows run
    // exactly as they did before Phase 11.
    enabled:
      (process.env.NOTIFICATIONS_ENABLED || 'true').toLowerCase() === 'true',
    // Within-window deduplication: identical { recipient, eventType, entityRef }
    // notifications created inside this window are skipped (defense-in-depth on
    // top of the business services' own idempotency short-circuits).
    dedupeWindowMs:
      Number.parseInt(process.env.NOTIFICATIONS_DEDUPE_WINDOW_MS, 10) ||
      NOTIFICATIONS_DEDUPE_WINDOW_DEFAULT_MS,
  },

  cors: {
    // Comma-separated allowlist of browser origins that may call the API
    // cross-origin (the storefront and admin dashboard). Empty in production
    // denies all cross-origin requests (same-origin only); empty in
    // development/test allows every origin for convenience.
    origins: (process.env.CORS_ORIGINS || '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  },
};

/**
 * Returns the names of any Pathao fields still set to Pathao's publicly
 * published sandbox demo values. Used to prevent demo credentials from
 * accidentally reaching production.
 */
function sandboxDemoCredentialFields() {
  const demo = PATHAO_SANDBOX_DEMO_CREDENTIALS;
  const matched = [];
  if (config.pathao.clientId === demo.clientId) matched.push('PATHAO_CLIENT_ID');
  if (config.pathao.clientSecret === demo.clientSecret) matched.push('PATHAO_CLIENT_SECRET');
  if (config.pathao.username === demo.username) matched.push('PATHAO_USERNAME');
  if (config.pathao.password === demo.password) matched.push('PATHAO_PASSWORD');
  if (config.pathao.storeId === demo.storeId) matched.push('PATHAO_STORE_ID');
  return matched;
}

/**
 * Validates a production URL value. Returns a problem description string, or
 * null when the value is acceptable.
 *
 * Production requirements (per the deployment audit):
 *  - must be a valid absolute URL,
 *  - must use https,
 *  - must NOT point at localhost / 127.0.0.1 / ::1.
 */
function productionUrlProblem(value) {
  if (!value) {
    return 'is required in production';
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return 'must be a valid absolute URL';
  }
  const problems = [];
  if (url.protocol !== 'https:') {
    problems.push('must use https in production');
  }
  const host = url.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    problems.push('must not point at localhost in production');
  }
  return problems.length > 0 ? problems.join(' and ') : null;
}

/**
 * Production-only URL guards. A production deployment that targets localhost or
 * plain-http origins is always a misconfiguration (broken issuer/audience
 * matching, CORS never letting the real storefront through, or localhost links
 * sent to customers/admins), so it fails fast instead of shipping a silently
 * broken deployment.
 */
function validateProductionUrls() {
  const isProd = config.env === 'production';
  if (!isProd) {
    return;
  }

  const problems = [];

  // Better Auth JWT verification targets. Missing/invalid here means every
  // authenticated request fails with 401 — the exact production outage fixed by
  // this deployment audit.
  const authUrlMap = {
    BETTER_AUTH_JWKS_URL: config.auth.jwksUrl,
    BETTER_AUTH_ISSUER: config.auth.issuer,
    BETTER_AUTH_AUDIENCE: config.auth.audience,
  };
  for (const [name, value] of Object.entries(authUrlMap)) {
    const problem = productionUrlProblem(value);
    if (problem) {
      problems.push(`${name} ${problem}`);
    }
  }

  // Email base URLs. When set they must be real https origins — never
  // localhost links sent to customers or admins. When unset the existing
  // warnings below still fire (the email just omits the CTA / falls back).
  for (const name of ['STORE_URL', 'ADMIN_DASHBOARD_BASE_URL']) {
    const raw = process.env[name];
    if (!raw) continue;
    const problem = productionUrlProblem(raw);
    if (problem) {
      problems.push(`${name} ${problem}`);
    }
  }

  // CORS origins: each entry must be an https origin (no path) and never
  // localhost. Origins only — paths like /admin/dashboard are rejected.
  for (const origin of config.cors.origins) {
    const problem = productionUrlProblem(origin);
    if (problem) {
      problems.push(`CORS_ORIGINS entry "${origin}" ${problem}`);
      continue;
    }
    const url = new URL(origin);
    if (url.pathname !== '/' && url.pathname !== '') {
      problems.push(
        `CORS_ORIGINS entry "${origin}" must be an origin without a path`
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid production configuration: ${problems.join('; ')}. ` +
        'See .env.example for the correct production values.'
    );
  }
}

function validate() {
  const isProd = config.env === 'production';
  const isTest = config.env === 'test';

  const missing = [];
  if (!config.db.uri) missing.push('MONGODB_URI');
  if (isProd && !config.auth.jwksUrl) missing.push('BETTER_AUTH_JWKS_URL');
  if (isProd && !config.auth.issuer) missing.push('BETTER_AUTH_ISSUER');
  if (isProd && !config.auth.audience) missing.push('BETTER_AUTH_AUDIENCE');

  if (config.courier.provider === 'pathao') {
    const pathaoMissing = [];
    if (!config.pathao.clientId) pathaoMissing.push('PATHAO_CLIENT_ID');
    if (!config.pathao.clientSecret) pathaoMissing.push('PATHAO_CLIENT_SECRET');
    if (!config.pathao.username) pathaoMissing.push('PATHAO_USERNAME');
    if (!config.pathao.password) pathaoMissing.push('PATHAO_PASSWORD');
    if (!config.pathao.storeId) pathaoMissing.push('PATHAO_STORE_ID');
    if (pathaoMissing.length > 0) {
      if (isProd) {
        throw new Error(
          `COURIER_PROVIDER=pathao requires: ${pathaoMissing.join(', ')}`
        );
      }
      if (!isTest) {
        console.warn(
          `[config] COURIER_PROVIDER=pathao requires: ${pathaoMissing.join(', ')}. See .env.example.`
        );
      }
    }
    if (isProd) {
      const demoFields = sandboxDemoCredentialFields();
      if (demoFields.length > 0) {
        throw new Error(
          `Sandbox demo credentials must not be used in production (${demoFields.join(', ')}). ` +
            'Set COURIER_PROVIDER=pathao with the real merchant PATHAO credentials from the Pathao merchant dashboard.'
        );
      }
      if (config.pathao.baseUrl === PATHAO_SANDBOX_BASE_URL) {
        throw new Error(
          'PATHAO_BASE_URL resolves to the Pathao sandbox in production. ' +
            'Unset PATHAO_BASE_URL so production uses https://api-hermes.pathao.com.'
        );
      }
    }
  } else if (isProd) {
    // COURIER_PROVIDER=mock is inert (no network, no credentials), but the
    // sandbox demo values must still be flagged so they are not carried into a
    // later provider switch.
    const demoFields = sandboxDemoCredentialFields();
    if (demoFields.length > 0) {
      console.warn(
        `[config] Sandbox demo Pathao credentials detected in production (${demoFields.join(', ')}). ` +
          'They are ignored while COURIER_PROVIDER=mock, but they MUST be replaced with the ' +
          'real merchant credentials before enabling COURIER_PROVIDER=pathao.'
      );
    }
    if (config.pathao.baseUrl === PATHAO_SANDBOX_BASE_URL) {
      console.warn(
        '[config] PATHAO_BASE_URL points at the Pathao sandbox in production. ' +
          'Unset PATHAO_BASE_URL so production uses https://api-hermes.pathao.com.'
      );
    }
  }
  if (isProd && config.courier.provider === 'mock') {
    console.warn(
      '[config] COURIER_PROVIDER=mock is active in production. No real courier orders will be created.'
    );
  }

  if (config.email.provider === 'smtp') {
    const smtpMissing = [];
    if (!config.email.host) smtpMissing.push('EMAIL_HOST');
    if (!config.email.user) smtpMissing.push('EMAIL_USER');
    if (!config.email.password) smtpMissing.push('EMAIL_PASSWORD');
    if (!config.email.from) smtpMissing.push('EMAIL_FROM');
    // Production throws below (after the shared missing-vars report) so a
    // missing MONGODB_URI / auth URL is always reported first. Non-production
    // environments only warn.
    if (smtpMissing.length > 0 && !isProd && !isTest) {
      console.warn(
        `[config] EMAIL_PROVIDER=smtp requires: ${smtpMissing.join(', ')}. See .env.example.`
      );
    }
  }

  if (config.email.provider === 'smtp' && !config.admin.email && !isProd && !isTest) {
    console.warn(
      '[config] ADMIN_EMAIL is not set. Admin "new order" emails will be skipped. Set ADMIN_EMAIL to receive them.'
    );
  }

  const rawInterval = process.env.COURIER_RECONCILE_INTERVAL_MS;
  if (
    !isTest &&
    rawInterval !== undefined &&
    rawInterval !== null &&
    String(rawInterval).trim() !== ''
  ) {
    const parsed = Number.parseInt(rawInterval, 10);
    if (!Number.isSafeInteger(parsed) || parsed < RECONCILE_INTERVAL_MIN_MS) {
      console.warn(
        `[config] COURIER_RECONCILE_INTERVAL_MS must be a positive integer of at least ` +
          `${RECONCILE_INTERVAL_MIN_MS}ms; falling back to ${RECONCILE_INTERVAL_DEFAULT_MS}ms.`
      );
    }
  }

  if (missing.length > 0) {
    if (isProd) {
      throw new Error(
        `Missing required environment variables: ${missing.join(', ')}`
      );
    }
    if (!isTest) {
      console.warn(
        `[config] Missing required environment variables: ${missing.join(', ')}. See .env.example.`
      );
    }
  }

  if (!isProd && !isTest && !config.auth.jwksUrl) {
    console.warn(
      '[config] BETTER_AUTH_JWKS_URL is not set. Authenticated endpoints will reject all tokens until the Better Auth JWKS URL is configured. See .env.example.'
    );
  }

  if (isProd) {
    // EMAIL — fail fast in production so a deployment (e.g. Vercel) can never
    // boot into a silently-broken email system:
    //   * EMAIL_PROVIDER=mock (or unset, which defaults to mock) discards every
    //     email while the notification records still read SENT — the exact
    //     silent outage this audit fixes;
    //   * missing SMTP credentials would make every send record NOT_CONFIGURED;
    //   * missing ADMIN_EMAIL silently disables the admin new-order email;
    //   * missing STORE_URL / ADMIN_DASHBOARD_BASE_URL would put localhost
    //     links inside production emails.
    if (config.email.provider !== 'smtp') {
      throw new Error(
        'EMAIL_PROVIDER must be "smtp" in production (found: ' +
          `${config.email.provider || '(unset — defaults to mock)'}). ` +
          'EMAIL_PROVIDER=mock silently discards every email while notifications record SENT. ' +
          'Set EMAIL_PROVIDER=smtp plus the real EMAIL_* values in the deployment environment.'
      );
    }
    const smtpMissing = [];
    if (!config.email.host) smtpMissing.push('EMAIL_HOST');
    if (!config.email.user) smtpMissing.push('EMAIL_USER');
    if (!config.email.password) smtpMissing.push('EMAIL_PASSWORD');
    if (!config.email.from) smtpMissing.push('EMAIL_FROM');
    if (smtpMissing.length > 0) {
      throw new Error(`EMAIL_PROVIDER=smtp requires: ${smtpMissing.join(', ')}`);
    }
    const prodEmailMissing = [];
    if (!config.admin.email) prodEmailMissing.push('ADMIN_EMAIL');
    if (!process.env.STORE_URL) prodEmailMissing.push('STORE_URL');
    if (!process.env.ADMIN_DASHBOARD_BASE_URL) prodEmailMissing.push('ADMIN_DASHBOARD_BASE_URL');
    if (prodEmailMissing.length > 0) {
      throw new Error(
        `Production email configuration requires: ${prodEmailMissing.join(', ')}. ` +
          'ADMIN_EMAIL receives the new-order email; STORE_URL and ADMIN_DASHBOARD_BASE_URL ' +
          'build the links inside customer/admin emails (never localhost in production).'
      );
    }

    // Run last so the friendlier "Missing required environment variables"
    // message (above) wins when multiple values are missing at once.
    validateProductionUrls();
  }
}

function deepFreeze(obj) {
  Object.values(obj).forEach((value) => {
    if (value && typeof value === 'object') {
      deepFreeze(value);
    }
  });
  return Object.freeze(obj);
}

validate();

module.exports = deepFreeze(config);
