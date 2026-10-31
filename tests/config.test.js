'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const CONFIG_PATH = require.resolve('../src/config/index.js');

const ENV_KEYS = [
  'NODE_ENV',
  'MONGODB_URI',
  'MONGODB_SERVER_SELECTION_TIMEOUT_MS',
  'BETTER_AUTH_JWKS_URL',
  'BETTER_AUTH_ISSUER',
  'BETTER_AUTH_AUDIENCE',
  'BETTER_AUTH_ALGORITHMS',
  'BETTER_AUTH_CLOCK_TOLERANCE_SECONDS',
  'COURIER_PROVIDER',
  'PATHAO_BASE_URL',
  'PATHAO_CLIENT_ID',
  'PATHAO_CLIENT_SECRET',
  'PATHAO_USERNAME',
  'PATHAO_PASSWORD',
  'PATHAO_STORE_ID',
  'ADMIN_EMAIL',
  'ADMIN_DASHBOARD_BASE_URL',
  'STORE_URL',
  'EMAIL_PROVIDER',
  'EMAIL_HOST',
  'EMAIL_PORT',
  'EMAIL_USER',
  'EMAIL_PASSWORD',
  'EMAIL_FROM',
  'EMAIL_SECURE',
  'EMAIL_TIMEOUT_MS',
  'NOTIFICATIONS_ENABLED',
  'NOTIFICATIONS_DEDUPE_WINDOW_MS',
  'CORS_ORIGINS',
];

// Pathao's publicly published sandbox demo credentials (also embedded in
// src/config/index.js). They are NOT secrets; they are used only to verify the
// production guard that rejects them.
const SANDBOX_DEMO_CREDENTIALS = {
  PATHAO_CLIENT_ID: '7N1aMJQbWm',
  PATHAO_CLIENT_SECRET: 'wRcaibZkUdSNz2EI9ZyuXLlNrnAv0TdPUPXMnD39',
  PATHAO_USERNAME: 'test@pathao.com',
  PATHAO_PASSWORD: 'lovePathao',
  PATHAO_STORE_ID: '56088',
};

// A production environment that satisfies the non-Pathao requirements so that
// only Pathao-related validation decides the outcome. BETTER_AUTH_ISSUER /
// BETTER_AUTH_AUDIENCE mirror the real frontend contract (they are required in
// production and must be https). The email block mirrors the real production
// contract as well: EMAIL_PROVIDER=smtp plus SMTP credentials and the
// admin/storefront URLs are all REQUIRED in production (fail fast), so every
// production scenario below starts from a valid email configuration.
function productionBaseEnv(extra = {}) {
  return {
    NODE_ENV: 'production',
    MONGODB_URI: 'mongodb://host:27017/taqwa',
    BETTER_AUTH_JWKS_URL: 'https://auth.example.com/jwks',
    BETTER_AUTH_ISSUER: 'https://auth.example.com',
    BETTER_AUTH_AUDIENCE: 'https://auth.example.com',
    PATHAO_BASE_URL: '',
    EMAIL_PROVIDER: 'smtp',
    EMAIL_HOST: 'smtp.example.com',
    EMAIL_PORT: '587',
    EMAIL_USER: 'smtp-user',
    EMAIL_PASSWORD: 'smtp-password',
    EMAIL_FROM: 'noreply@example.com',
    ADMIN_EMAIL: 'orders@example.com',
    STORE_URL: 'https://www.taqwactg.com',
    ADMIN_DASHBOARD_BASE_URL: 'https://www.taqwactg.com/admin/dashboard',
    ...extra,
  };
}

// Placeholder (non-demo, non-empty) merchant credentials used to prove real
// values are accepted. Never a real secret.
function realPathaoCreds(overrides = {}) {
  return {
    PATHAO_CLIENT_ID: 'merchant-client-id',
    PATHAO_CLIENT_SECRET: 'merchant-client-secret',
    PATHAO_USERNAME: 'merchant@example.com',
    PATHAO_PASSWORD: 'merchant-password',
    PATHAO_STORE_ID: '12345',
    ...overrides,
  };
}

/**
 * Reloads the config module with a controlled environment, then restores the
 * original environment. Config is read from process.env (the built-in .env
 * loader never overrides already-set variables).
 */
function loadConfig(env) {
  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
  }
  Object.assign(process.env, env);
  // Pre-seed every tracked key not explicitly provided by the test so the
  // config module's own .env loader can never leak a developer's local values
  // (e.g. ADMIN_EMAIL) into a hermetic test environment.
  for (const key of ENV_KEYS) {
    if (!(key in env)) {
      process.env[key] = '';
    }
  }
  delete require.cache[CONFIG_PATH];
  try {
    return require('../src/config/index.js');
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

test('config reads MONGODB_URI from the environment', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    MONGODB_URI: 'mongodb://user:pass@host:27017/taqwa',
  });
  assert.equal(config.db.uri, 'mongodb://user:pass@host:27017/taqwa');
});

test('config provides a bounded server selection timeout by default', () => {
  const config = loadConfig({ NODE_ENV: 'test' });
  assert.equal(config.db.serverSelectionTimeoutMs, 10000);
});

test('config throws in production when MONGODB_URI is missing', () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: 'production', MONGODB_URI: '' }),
    /MONGODB_URI/
  );
});

test('config warns but does not throw in development when MONGODB_URI is missing', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const config = loadConfig({ NODE_ENV: 'development', MONGODB_URI: '' });
    assert.equal(config.db.uri, '');
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(
    warnings.some((msg) => msg.includes('MONGODB_URI')),
    'a clear warning mentioning MONGODB_URI is emitted'
  );
});

test('config errors do not expose secret values', () => {
  let message = '';
  try {
    loadConfig({ NODE_ENV: 'production', MONGODB_URI: '' });
  } catch (err) {
    message = err.message;
  }
  assert.match(message, /MONGODB_URI/);
  assert.doesNotMatch(message, /mongodb(\+srv)?:\/\//);
});

test('config defaults the auth algorithm allowlist to RS256', () => {
  const config = loadConfig({ NODE_ENV: 'test' });
  assert.deepEqual(config.auth.algorithms, ['RS256']);
});

test('config parses the comma-separated auth algorithm allowlist', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    BETTER_AUTH_ALGORITHMS: 'RS256, ES256',
  });
  assert.deepEqual(config.auth.algorithms, ['RS256', 'ES256']);
});

test('config defaults the auth clock tolerance to 30 seconds', () => {
  const config = loadConfig({ NODE_ENV: 'test' });
  assert.equal(config.auth.clockToleranceSeconds, 30);
});

test('config throws in production when BETTER_AUTH_JWKS_URL is missing', () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: 'production',
        MONGODB_URI: 'mongodb://host:27017/taqwa',
        BETTER_AUTH_JWKS_URL: '',
      }),
    /BETTER_AUTH_JWKS_URL/
  );
});

test('config throws in production when BETTER_AUTH_ISSUER is missing', () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: 'production',
        MONGODB_URI: 'mongodb://host:27017/taqwa',
        BETTER_AUTH_JWKS_URL: 'https://auth.example.com/jwks',
        BETTER_AUTH_ISSUER: '',
        BETTER_AUTH_AUDIENCE: 'https://auth.example.com',
      }),
    /BETTER_AUTH_ISSUER/
  );
});

test('config throws in production when BETTER_AUTH_AUDIENCE is missing', () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: 'production',
        MONGODB_URI: 'mongodb://host:27017/taqwa',
        BETTER_AUTH_JWKS_URL: 'https://auth.example.com/jwks',
        BETTER_AUTH_ISSUER: 'https://auth.example.com',
        BETTER_AUTH_AUDIENCE: '',
      }),
    /BETTER_AUTH_AUDIENCE/
  );
});

test('config throws in production when a Better Auth URL points at localhost', () => {
  assert.throws(
    () =>
      loadConfig(
        productionBaseEnv({ BETTER_AUTH_ISSUER: 'http://localhost:3000' })
      ),
    /localhost/
  );
});

test('config throws in production when a Better Auth URL is not https', () => {
  assert.throws(
    () =>
      loadConfig(
        productionBaseEnv({ BETTER_AUTH_ISSUER: 'http://taqwactg.com' })
      ),
    /must use https/
  );
});

test('config accepts the real production Better Auth contract', () => {
  const config = loadConfig(
    productionBaseEnv({
      BETTER_AUTH_JWKS_URL: 'https://www.taqwactg.com/api/auth/jwks',
      BETTER_AUTH_ISSUER: 'https://www.taqwactg.com',
      BETTER_AUTH_AUDIENCE: 'https://www.taqwactg.com',
    })
  );
  assert.equal(config.auth.jwksUrl, 'https://www.taqwactg.com/api/auth/jwks');
  assert.equal(config.auth.issuer, 'https://www.taqwactg.com');
  assert.equal(config.auth.audience, 'https://www.taqwactg.com');
});

test('config throws in production when CORS_ORIGINS contains localhost', () => {
  assert.throws(
    () =>
      loadConfig(
        productionBaseEnv({ CORS_ORIGINS: 'https://taqwactg.com,http://localhost:3000' })
      ),
    /localhost/
  );
});

test('config throws in production when a CORS origin contains a path', () => {
  assert.throws(
    () =>
      loadConfig(
        productionBaseEnv({ CORS_ORIGINS: 'https://www.taqwactg.com/admin/dashboard' })
      ),
    /without a path/
  );
});

test('config accepts the real production CORS origins', () => {
  const config = loadConfig(
    productionBaseEnv({
      CORS_ORIGINS: 'https://www.taqwactg.com,https://taqwactg.com',
    })
  );
  assert.deepEqual(config.cors.origins, [
    'https://www.taqwactg.com',
    'https://taqwactg.com',
  ]);
});

test('config throws in production when STORE_URL points at localhost', () => {
  assert.throws(
    () => loadConfig(productionBaseEnv({ STORE_URL: 'http://localhost:3000' })),
    /STORE_URL/
  );
});

test('config throws in production when ADMIN_DASHBOARD_BASE_URL points at localhost', () => {
  assert.throws(
    () =>
      loadConfig(
        productionBaseEnv({ ADMIN_DASHBOARD_BASE_URL: 'http://localhost:3000/admin/dashboard' })
      ),
    /ADMIN_DASHBOARD_BASE_URL/
  );
});

test('config accepts the real production email base URLs', () => {
  const config = loadConfig(
    productionBaseEnv({
      STORE_URL: 'https://www.taqwactg.com',
      ADMIN_DASHBOARD_BASE_URL: 'https://www.taqwactg.com/admin/dashboard',
    })
  );
  assert.equal(config.storefront.baseUrl, 'https://www.taqwactg.com');
  assert.equal(
    config.admin.dashboardBaseUrl,
    'https://www.taqwactg.com/admin/dashboard'
  );
});

test('config selects the Pathao sandbox base URL in development', () => {
  const config = loadConfig({ NODE_ENV: 'development', PATHAO_BASE_URL: '' });
  assert.equal(config.pathao.baseUrl, 'https://courier-api-sandbox.pathao.com');
  assert.equal(config.pathao.mode, 'sandbox');
});

test('config selects the Pathao production base URL when NODE_ENV=production', () => {
  const config = loadConfig(productionBaseEnv());
  assert.equal(config.pathao.baseUrl, 'https://api-hermes.pathao.com');
  assert.equal(config.pathao.mode, 'production');
});

test('config honors an explicit PATHAO_BASE_URL override in production', () => {
  const config = loadConfig(
    productionBaseEnv({ PATHAO_BASE_URL: 'https://custom.pathao.example.com' })
  );
  assert.equal(config.pathao.baseUrl, 'https://custom.pathao.example.com');
  assert.equal(config.pathao.mode, 'production');
});

test('config throws in production when a required PATHAO value is missing', () => {
  assert.throws(
    () =>
      loadConfig(
        productionBaseEnv({ COURIER_PROVIDER: 'pathao', ...realPathaoCreds({ PATHAO_CLIENT_ID: '' }) })
      ),
    /PATHAO_CLIENT_ID/
  );
});

test('config accepts real (non-demo) Pathao credentials in production', () => {
  const config = loadConfig(
    productionBaseEnv({ COURIER_PROVIDER: 'pathao', ...realPathaoCreds() })
  );
  assert.equal(config.courier.provider, 'pathao');
  assert.equal(config.pathao.baseUrl, 'https://api-hermes.pathao.com');
  assert.equal(config.pathao.mode, 'production');
});

test('config throws in production when sandbox demo credentials are used with the pathao provider', () => {
  assert.throws(
    () =>
      loadConfig(
        productionBaseEnv({ COURIER_PROVIDER: 'pathao', ...SANDBOX_DEMO_CREDENTIALS })
      ),
    /sandbox demo credentials/i
  );
});

test('config throws in production when PATHAO_BASE_URL points at the sandbox', () => {
  assert.throws(
    () =>
      loadConfig(
        productionBaseEnv({
          COURIER_PROVIDER: 'pathao',
          ...realPathaoCreds(),
          PATHAO_BASE_URL: 'https://courier-api-sandbox.pathao.com',
        })
      ),
    /sandbox in production/i
  );
});

test('config warns but does not throw in development when PATHAO values are missing', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const config = loadConfig({
      NODE_ENV: 'development',
      COURIER_PROVIDER: 'pathao',
      PATHAO_CLIENT_ID: '',
      PATHAO_CLIENT_SECRET: '',
      PATHAO_USERNAME: '',
      PATHAO_PASSWORD: '',
      PATHAO_STORE_ID: '',
    });
    assert.equal(config.pathao.clientId, '');
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(
    warnings.some((msg) => msg.includes('PATHAO_CLIENT_ID')),
    'a clear warning mentioning PATHAO_CLIENT_ID is emitted'
  );
});

test('config warns (not throws) about demo credentials while the mock provider is active in production', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const config = loadConfig(
      productionBaseEnv({ COURIER_PROVIDER: 'mock', ...SANDBOX_DEMO_CREDENTIALS })
    );
    assert.equal(config.courier.provider, 'mock');
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(
    warnings.some((msg) => msg.includes('Sandbox demo Pathao credentials')),
    'a clear warning about sandbox demo credentials is emitted'
  );
});

test('config defaults the admin email recipient to empty and the dashboard base URL to localhost', () => {
  const config = loadConfig({ NODE_ENV: 'test' });
  assert.equal(config.admin.email, '');
  assert.equal(config.admin.dashboardBaseUrl, 'http://localhost:3000');
});

test('config reads ADMIN_EMAIL and ADMIN_DASHBOARD_BASE_URL from the environment', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    ADMIN_EMAIL: 'orders@taqwa.test',
    ADMIN_DASHBOARD_BASE_URL: 'https://admin.taqwa.com/',
  });
  assert.equal(config.admin.email, 'orders@taqwa.test');
  assert.equal(config.admin.dashboardBaseUrl, 'https://admin.taqwa.com');
});

test('config strips trailing slashes from the admin dashboard base URL', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    ADMIN_DASHBOARD_BASE_URL: 'https://admin.taqwa.com///',
  });
  assert.equal(config.admin.dashboardBaseUrl, 'https://admin.taqwa.com');
});

test('config defaults the storefront base URL to localhost', () => {
  const config = loadConfig({ NODE_ENV: 'test' });
  assert.equal(config.storefront.baseUrl, 'http://localhost:3000');
});

test('config reads STORE_URL and strips trailing slashes', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    STORE_URL: 'https://taqwactg.com/',
  });
  assert.equal(config.storefront.baseUrl, 'https://taqwactg.com');
});

test('config warns (not throws) when SMTP is active but ADMIN_EMAIL is missing', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const config = loadConfig({
      NODE_ENV: 'development',
      EMAIL_PROVIDER: 'smtp',
      EMAIL_HOST: 'smtp.example.com',
      EMAIL_FROM: 'noreply@example.com',
      ADMIN_EMAIL: '',
    });
    assert.equal(config.admin.email, '');
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(
    warnings.some((msg) => msg.includes('ADMIN_EMAIL')),
    'a clear warning mentioning ADMIN_EMAIL is emitted'
  );
});

test('config does not warn about a missing ADMIN_EMAIL when one is set', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const config = loadConfig({
      NODE_ENV: 'development',
      EMAIL_PROVIDER: 'smtp',
      EMAIL_HOST: 'smtp.example.com',
      EMAIL_FROM: 'noreply@example.com',
      ADMIN_EMAIL: 'orders@taqwa.test',
    });
    assert.equal(config.admin.email, 'orders@taqwa.test');
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(
    !warnings.some((msg) => msg.includes('ADMIN_EMAIL')),
    'no ADMIN_EMAIL warning is emitted when the variable is set'
  );
});

// --- Production email fail-fast guards (Phase 11 deployment audit) ---
// EMAIL_PROVIDER=mock (or unset, which defaults to mock) silently discards
// every email while notification records still read SENT. Production must
// therefore FAIL FAST instead of booting into a silently-broken email system.

test('config throws in production when EMAIL_PROVIDER is unset', () => {
  assert.throws(
    () => loadConfig(productionBaseEnv({ EMAIL_PROVIDER: '' })),
    /EMAIL_PROVIDER must be "smtp" in production/
  );
});

test('config throws in production when EMAIL_PROVIDER is mock', () => {
  assert.throws(
    () => loadConfig(productionBaseEnv({ EMAIL_PROVIDER: 'mock' })),
    /EMAIL_PROVIDER must be "smtp" in production/
  );
});

test('config throws in production when SMTP credentials are missing', () => {
  assert.throws(
    () => loadConfig(productionBaseEnv({ EMAIL_USER: '', EMAIL_PASSWORD: '' })),
    /EMAIL_USER, EMAIL_PASSWORD/
  );
});

test('config throws in production when EMAIL_FROM is missing', () => {
  assert.throws(
    () => loadConfig(productionBaseEnv({ EMAIL_FROM: '' })),
    /EMAIL_FROM/
  );
});

test('config throws in production when ADMIN_EMAIL is missing', () => {
  assert.throws(
    () => loadConfig(productionBaseEnv({ ADMIN_EMAIL: '' })),
    /ADMIN_EMAIL/
  );
});

test('config throws in production when STORE_URL is missing', () => {
  assert.throws(
    () => loadConfig(productionBaseEnv({ STORE_URL: '' })),
    /STORE_URL/
  );
});

test('config throws in production when ADMIN_DASHBOARD_BASE_URL is missing', () => {
  assert.throws(
    () => loadConfig(productionBaseEnv({ ADMIN_DASHBOARD_BASE_URL: '' })),
    /ADMIN_DASHBOARD_BASE_URL/
  );
});

test('config accepts the full real production email configuration', () => {
  const config = loadConfig(productionBaseEnv());
  assert.equal(config.email.provider, 'smtp');
  assert.equal(config.email.host, 'smtp.example.com');
  assert.equal(config.email.user, 'smtp-user');
  assert.equal(config.email.password, 'smtp-password');
  assert.equal(config.email.from, 'noreply@example.com');
  assert.equal(config.admin.email, 'orders@example.com');
  assert.equal(config.storefront.baseUrl, 'https://www.taqwactg.com');
});

test('config defaults to the mock email provider outside production', () => {
  const config = loadConfig({ NODE_ENV: 'test' });
  assert.equal(config.email.provider, 'mock');
});

test('config defaults the CORS allowlist to empty', () => {
  const config = loadConfig({ NODE_ENV: 'test' });
  assert.deepEqual(config.cors.origins, []);
});

test('config parses the comma-separated CORS allowlist and trims entries', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    CORS_ORIGINS: ' https://taqwactg.com , https://admin.taqwactg.com ',
  });
  assert.deepEqual(config.cors.origins, [
    'https://taqwactg.com',
    'https://admin.taqwactg.com',
  ]);
});
