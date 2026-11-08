'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const cors = require('../../../src/middlewares/cors');

function buildApp(cfg) {
  const app = express();
  app.use(cors(cfg));
  app.get('/health', (req, res) => res.json({ success: true }));
  return app;
}

function withServer(app, fn) {
  return async () => {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    try {
      await fn(`http://127.0.0.1:${port}`);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

function prodCfg(origins) {
  return { env: 'production', cors: { origins } };
}

test('cors allows any origin when no allowlist is configured outside production', withServer(
  buildApp({ env: 'test', cors: { origins: [] } }),
  async (baseUrl) => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Origin: 'http://localhost:3000' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:3000');
    assert.equal(res.headers.get('access-control-allow-methods'), 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    assert.ok(res.headers.get('vary').includes('Origin'));
  }
));

test('cors allows an allowlisted origin in production', withServer(
  buildApp(prodCfg(['https://taqwactg.com'])),
  async (baseUrl) => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Origin: 'https://taqwactg.com' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://taqwactg.com');
  }
));

test('cors does not emit CORS headers for a non-allowlisted origin in production', withServer(
  buildApp(prodCfg(['https://taqwactg.com'])),
  async (baseUrl) => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Origin: 'https://evil.example.com' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  }
));

test('cors emits no CORS headers in production when no allowlist is configured', withServer(
  buildApp(prodCfg([])),
  async (baseUrl) => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Origin: 'https://taqwactg.com' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  }
));

test('cors answers preflight OPTIONS with 204 and the allowed headers', withServer(
  buildApp(prodCfg(['https://taqwactg.com'])),
  async (baseUrl) => {
    const res = await fetch(`${baseUrl}/health`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://taqwactg.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type, Authorization, Idempotency-Key',
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://taqwactg.com');
    assert.equal(res.headers.get('access-control-allow-headers'), 'Content-Type, Authorization, Idempotency-Key, X-Guest-Id, X-Request-Id');
    assert.equal(res.headers.get('access-control-expose-headers'), 'X-Request-Id, Retry-After');
    assert.ok(res.headers.get('access-control-max-age'));
  }
));

test('cors does not set Access-Control-Allow-Credentials (no cookies used)', withServer(
  buildApp(prodCfg(['https://taqwactg.com'])),
  async (baseUrl) => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Origin: 'https://taqwactg.com' },
    });
    assert.equal(res.headers.get('access-control-allow-credentials'), null);
  }
));
