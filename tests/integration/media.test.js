'use strict';

process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');

const express = require('express');
const { UserService } = require('../../src/modules/users/user.service');
const { MediaService } = require('../../src/modules/media/media.service');
const { createMediaRouter } = require('../../src/modules/media/media.routes');
const { createMemoryMediaService } = require('../../src/integrations/media/media.mock');
const { ERROR_CODES } = require('../../src/constants');
const {
  seedUsers,
  createStubUserRepository,
  withServer,
  setupAuth,
} = require('../helpers/order-integration-fixtures');
const notFound = require('../../src/middlewares/notFound');
const errorHandler = require('../../src/middlewares/errorHandler');

let auth;

before(async () => {
  auth = await setupAuth();
});

const BOUNDARY = '----taqwaMediaIntegrationBoundary';

function buildApp({ mediaService } = {}) {
  const users = seedUsers();
  const userService = new UserService({
    repository: createStubUserRepository(users),
    autoProvisionCustomers: true,
  });
  const effectiveMediaService =
    mediaService || new MediaService({ mediaService: createMemoryMediaService() });
  const app = express();
  app.use(
    '/api/v1/admin/media',
    createMediaRouter({ mediaService: effectiveMediaService, userService, verifier: auth.verifier })
  );
  app.use(notFound);
  app.use(errorHandler);
  return { app };
}

function pngBytes(size = 64) {
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const rest = Buffer.alloc(Math.max(0, size - magic.length), 0);
  return Buffer.concat([magic, rest]);
}

function multipartBody({ fileName = 'photo.png', type = 'image/png', buffer = pngBytes() } = {}) {
  const head = Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="files"; filename="${fileName}"\r\nContent-Type: ${type}\r\n\r\n`
  );
  return Buffer.concat([head, buffer, Buffer.from(`\r\n--${BOUNDARY}--\r\n`)]);
}

function uploadForm(url, token, body) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body,
  });
}

test('ADMIN can upload an image and receives a safe upload reference', withServer(
  () => buildApp(),
  async (baseUrl) => {
    const res = await uploadForm(`${baseUrl}/api/v1/admin/media/upload`, auth.tokenAdmin, multipartBody());
    assert.equal(res.status, 201);
    const payload = await res.json();
    assert.equal(payload.success, true);
    assert.equal(payload.data.uploads.length, 1);
    const upload = payload.data.uploads[0];
    assert.equal(upload.provider, 'mock');
    assert.match(upload.url, /^https:\/\/mock\.media\//);
    assert.ok(upload.publicId);
    assert.equal(upload.resourceType, 'image');
    assert.equal(upload.format, 'png');
  }
));

test('STAFF can upload an image (STAFF may create products with images)', withServer(
  () => buildApp(),
  async (baseUrl) => {
    const res = await uploadForm(`${baseUrl}/api/v1/admin/media/upload`, auth.tokenStaff, multipartBody());
    assert.equal(res.status, 201);
  }
));

test('CUSTOMER cannot upload an image (403)', withServer(
  () => buildApp(),
  async (baseUrl) => {
    const res = await uploadForm(`${baseUrl}/api/v1/admin/media/upload`, auth.tokenCustomer, multipartBody());
    assert.equal(res.status, 403);
  }
));

test('anonymous cannot upload an image (401)', withServer(
  () => buildApp(),
  async (baseUrl) => {
    const res = await uploadForm(`${baseUrl}/api/v1/admin/media/upload`, null, multipartBody());
    assert.equal(res.status, 401);
  }
));

test('non-image files are rejected with INVALID_MEDIA_UPLOAD', withServer(
  () => buildApp(),
  async (baseUrl) => {
    const res = await uploadForm(
      `${baseUrl}/api/v1/admin/media/upload`,
      auth.tokenAdmin,
      multipartBody({ fileName: 'script.js', type: 'text/javascript', buffer: Buffer.from('alert(1)') })
    );
    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.equal(payload.error.code, ERROR_CODES.INVALID_MEDIA_UPLOAD);
  }
));

test('non-multipart requests are rejected', withServer(
  () => buildApp(),
  async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/admin/media/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.tokenAdmin}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ image: 'x' }),
    });
    assert.equal(res.status, 400);
  }
));

test('a file larger than the per-file cap is rejected', withServer(
  () => buildApp(),
  async (baseUrl) => {
    const { MEDIA_LIMITS } = require('../../src/modules/media/media.constants');
    const big = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(MEDIA_LIMITS.IMAGE_MAX_BYTES),
    ]);
    const res = await uploadForm(
      `${baseUrl}/api/v1/admin/media/upload`,
      auth.tokenAdmin,
      multipartBody({ buffer: big })
    );
    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.equal(payload.error.code, ERROR_CODES.INVALID_MEDIA_UPLOAD);
  }
));
