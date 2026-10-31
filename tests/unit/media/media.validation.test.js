'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateMediaUpload, validateImageFile } = require('../../../src/modules/media/media.validation');
const { ERROR_CODES } = require('../../../src/constants');
const { MEDIA_LIMITS } = require('../../../src/modules/media/media.constants');

function pngBuffer() {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
}

function jpegBuffer() {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16)]);
}

function webpBuffer() {
  return Buffer.concat([
    Buffer.from([0x52, 0x49, 0x46, 0x46]),
    Buffer.alloc(4),
    Buffer.from([0x57, 0x45, 0x42, 0x50]),
    Buffer.alloc(8),
  ]);
}

function validUpload(overrides = {}) {
  return {
    fields: {},
    files: [
      {
        fieldName: 'files',
        originalName: 'photo.png',
        contentType: 'image/png',
        buffer: pngBuffer(),
      },
    ],
    ...(overrides.files ? { files: overrides.files } : {}),
  };
}

test('a valid single-image multipart upload validates', () => {
  const { files } = validateMediaUpload(validUpload());
  assert.equal(files.length, 1);
  assert.equal(files[0].originalName, 'photo.png');
});

test('multiple images under the files field are accepted up to the cap', () => {
  const files = [];
  for (let i = 0; i < MEDIA_LIMITS.MAX_FILES; i += 1) {
    files.push({
      fieldName: 'files',
      originalName: `photo-${i}.jpeg`,
      contentType: 'image/jpeg',
      buffer: jpegBuffer(),
    });
  }
  assert.equal(validateMediaUpload({ fields: {}, files }).files.length, MEDIA_LIMITS.MAX_FILES);
});

test('more than MAX_FILES images are rejected', () => {
  const files = [];
  for (let i = 0; i < MEDIA_LIMITS.MAX_FILES + 1; i += 1) {
    files.push({
      fieldName: 'files',
      originalName: `photo-${i}.png`,
      contentType: 'image/png',
      buffer: pngBuffer(),
    });
  }
  assert.throws(
    () => validateMediaUpload({ fields: {}, files }),
    (err) => err.statusCode === 400 && err.code === ERROR_CODES.INVALID_MEDIA_UPLOAD
  );
});

test('missing files are rejected with MEDIA_UPLOAD_REQUIRED', () => {
  assert.throws(
    () => validateMediaUpload({ fields: {}, files: [] }),
    (err) => err.code === ERROR_CODES.MEDIA_UPLOAD_REQUIRED
  );
  assert.throws(
    () => validateMediaUpload({ fields: {}, files: undefined }),
    (err) => err.code === ERROR_CODES.MEDIA_UPLOAD_REQUIRED
  );
});

test('text fields are not allowed', () => {
  assert.throws(
    () => validateMediaUpload({ fields: { purpose: 'product' }, files: [] }),
    (err) => err.code === ERROR_CODES.INVALID_MEDIA_UPLOAD
  );
  assert.throws(
    () => validateMediaUpload({ fields: { $set: 'x' }, files: [] }),
    (err) => err.code === ERROR_CODES.INVALID_MEDIA_UPLOAD
  );
});

test('files under an unknown field name are rejected', () => {
  assert.throws(
    () =>
      validateMediaUpload({
        fields: {},
        files: [{ fieldName: 'proof', originalName: 'a.png', contentType: 'image/png', buffer: pngBuffer() }],
      }),
    (err) => err.code === ERROR_CODES.INVALID_MEDIA_UPLOAD
  );
});

test('unsupported MIME types are rejected', () => {
  const base = validUpload().files[0];
  for (const contentType of ['application/pdf', 'text/html', 'image/svg+xml', 'application/octet-stream']) {
    assert.throws(
      () =>
        validateMediaUpload({
          fields: {},
          files: [{ ...base, contentType, originalName: 'photo.svg' }],
        }),
      (err) => err.message === 'File must be a JPEG, PNG, or WEBP image',
      `contentType "${contentType}" must be rejected`
    );
  }
});

test('extension must match the declared MIME type', () => {
  const base = validUpload().files[0];
  assert.throws(
    () => validateMediaUpload({ fields: {}, files: [{ ...base, originalName: 'photo.gif' }] }),
    (err) => err.message.includes('image extension must be one of')
  );
  assert.throws(
    () => validateMediaUpload({ fields: {}, files: [{ ...base, contentType: 'image/jpeg', originalName: 'photo.png' }] }),
    (err) => err.message.includes('image extension must be one of')
  );
});

test('files that fail magic-byte checks are rejected', () => {
  const base = validUpload().files[0];
  assert.throws(
    () => validateMediaUpload({ fields: {}, files: [{ ...base, buffer: Buffer.from('not an image') }] }),
    (err) => err.message === 'File must be a JPEG, PNG, or WEBP image'
  );
});

test('webp magic is verified structurally (RIFF + WEBP tag)', () => {
  const base = validUpload().files[0];
  const ok = validateImageFile({
    ...base,
    contentType: 'image/webp',
    originalName: 'photo.webp',
    buffer: webpBuffer(),
  });
  assert.equal(ok.originalName, 'photo.webp');

  assert.throws(
    () =>
      validateImageFile({
        ...base,
        contentType: 'image/webp',
        originalName: 'photo.webp',
        buffer: Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0, 0, 0, 0]),
      }),
    (err) => err.message === 'File must be a JPEG, PNG, or WEBP image'
  );
});

test('oversized files are rejected', () => {
  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(MEDIA_LIMITS.IMAGE_MAX_BYTES + 1)]);
  assert.throws(
    () => validateMediaUpload({ fields: {}, files: [{ fieldName: 'files', originalName: 'big.jpg', contentType: 'image/jpeg', buffer: big }] }),
    (err) => err.statusCode === 400 && err.message.includes('byte limit')
  );
});
