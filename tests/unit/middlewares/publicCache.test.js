'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const requestContext = require('../../../src/middlewares/requestContext');
const publicCache = require('../../../src/middlewares/publicCache');
const errorHandler = require('../../../src/middlewares/errorHandler');

function buildApp() {
  const app = express();
  app.use(requestContext);
  app.get(
    '/catalog',
    publicCache({ sMaxAge: 60, staleWhileRevalidate: 300 }),
    (req, res) => res.json({ ok: true })
  );
  app.post('/catalog', publicCache({ sMaxAge: 60 }), (req, res) =>
    res.json({ ok: true })
  );
  app.get(
    '/broken',
    publicCache({ sMaxAge: 60 }),
    (req, res, next) => next(new Error('boom'))
  );
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

test(
  'public cache overrides the default no-store on a public GET',
  withServer(buildApp(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/catalog`);
    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get('cache-control'),
      'public, max-age=0, s-maxage=60, stale-while-revalidate=300'
    );
  })
);

test(
  'public cache never applies to a non-GET request',
  withServer(buildApp(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/catalog`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  })
);

test(
  'a public-cache route that fails is still force-no-store',
  withServer(buildApp(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/broken`);
    assert.equal(res.status, 500);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  })
);
