'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const requestContext = require('../../../src/middlewares/requestContext');

function buildApp() {
  const app = express();
  app.use(requestContext);
  app.get('/health', (req, res) => res.json({ requestId: req.id }));
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

test('request context always returns a request id and disables caching', withServer(
  buildApp(),
  async (baseUrl) => {
    const res = await fetch(`${baseUrl}/health`);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.match(res.headers.get('x-request-id'), /^[A-Za-z0-9._:-]{8,128}$/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(body.requestId, res.headers.get('x-request-id'));
  }
));

test('request context preserves a valid inbound request id', withServer(
  buildApp(),
  async (baseUrl) => {
    const requestId = 'frontend-request-1234';
    const res = await fetch(`${baseUrl}/health`, {
      headers: { 'X-Request-Id': requestId },
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-request-id'), requestId);
  }
));

test('request context replaces an unsafe inbound request id', withServer(
  buildApp(),
  async (baseUrl) => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { 'X-Request-Id': 'bad request id' },
    });

    assert.equal(res.status, 200);
    assert.notEqual(res.headers.get('x-request-id'), 'bad request id');
    assert.match(res.headers.get('x-request-id'), /^[A-Za-z0-9._:-]{8,128}$/);
  }
));
