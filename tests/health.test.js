'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');

/**
 * Boots the app on an ephemeral port and runs assertions against it.
 * Uses Node's built-in test runner and fetch — no extra dependencies.
 */
function withServer(fn) {
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

test('health endpoint responds with the success envelope', withServer(async (baseUrl) => {
  const res = await fetch(`${baseUrl}/api/v1/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.message, 'Asia Electronics API is healthy');
  assert.equal(typeof body.data, 'object');
  assert.ok(
    ['connected', 'connecting', 'disconnected', 'disconnecting', 'uninitialized'].includes(
      body.data.database
    ),
    'database state is a safe, known value'
  );
}));

test('unknown route responds with the error envelope', withServer(async (baseUrl) => {
  const res = await fetch(`${baseUrl}/api/v1/does-not-exist`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'NOT_FOUND');
}));
