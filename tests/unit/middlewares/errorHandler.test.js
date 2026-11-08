'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const requestContext = require('../../../src/middlewares/requestContext');
const errorHandler = require('../../../src/middlewares/errorHandler');

function buildApp(errorFactory) {
  const app = express();
  app.use(requestContext);
  app.get('/fail', (req, res, next) => next(errorFactory()));
  app.use(errorHandler);
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

test('database availability errors become retryable 503 responses', withServer(
  buildApp(() => Object.assign(new Error('connect ECONNREFUSED secret'), {
    name: 'MongooseServerSelectionError',
  })),
  async (baseUrl) => {
    const res = await fetch(`${baseUrl}/fail`);
    const body = await res.json();

    assert.equal(res.status, 503);
    assert.equal(body.error.code, 'DATABASE_UNAVAILABLE');
    assert.equal(res.headers.get('retry-after'), '5');
    assert.match(res.headers.get('x-request-id'), /^[A-Za-z0-9._:-]{8,128}$/);
    assert.equal(body.requestId, res.headers.get('x-request-id'));
    assert.doesNotMatch(body.message, /ECONNREFUSED|secret/);
  }
));

test('database timeout errors become retryable 504 responses', withServer(
  buildApp(() => Object.assign(new Error('socket timed out'), {
    name: 'MongoNetworkTimeoutError',
  })),
  async (baseUrl) => {
    const res = await fetch(`${baseUrl}/fail`);
    const body = await res.json();

    assert.equal(res.status, 504);
    assert.equal(body.error.code, 'DATABASE_TIMEOUT');
    assert.equal(res.headers.get('retry-after'), '5');
    assert.doesNotMatch(body.message, /socket/i);
  }
));

test('unexpected errors stay a safe 500 without leaking details', withServer(
  buildApp(() => new Error('private implementation detail')),
  async (baseUrl) => {
    const res = await fetch(`${baseUrl}/fail`);
    const body = await res.json();

    assert.equal(res.status, 500);
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.equal(body.message, 'Internal server error');
    assert.doesNotMatch(body.message, /private implementation/i);
  }
));
