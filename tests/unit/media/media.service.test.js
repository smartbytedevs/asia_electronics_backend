'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { MediaService } = require('../../../src/modules/media/media.service');
const { ERROR_CODES } = require('../../../src/constants');

function fakeMediaService({ failOn = -1 } = {}) {
  const uploads = [];
  return {
    uploads,
    async uploadFile({ buffer, mimeType, originalName, folder }) {
      if (uploads.length === failOn) {
        throw new Error('boom');
      }
      uploads.push({ mimeType, originalName, folder, size: buffer ? buffer.length : 0 });
      return {
        provider: 'cloudinary',
        publicId: `catalog/${originalName}`,
        secureUrl: `https://res.cloudinary.com/x/upload/catalog/${originalName}`,
        resourceType: 'image',
        format: 'png',
      };
    },
  };
}

function file(overrides = {}) {
  return {
    fieldName: 'files',
    originalName: 'a.png',
    contentType: 'image/png',
    buffer: Buffer.from('x'),
    ...overrides,
  };
}

test('MediaService requires a mediaService implementing uploadFile', () => {
  assert.throws(() => new MediaService({}), /implementing uploadFile/);
  assert.throws(() => new MediaService({ mediaService: { deleteFile: async () => {} } }), /implementing uploadFile/);
});

test('uploadImages uploads every file sequentially and returns safe media objects', async () => {
  const upstream = fakeMediaService();
  const service = new MediaService({ mediaService: upstream });
  const uploads = await service.uploadImages([file({ originalName: 'a.png' }), file({ originalName: 'b.png' })]);
  assert.equal(uploads.length, 2);
  assert.equal(upstream.uploads.length, 2);
  assert.equal(upstream.uploads[0].folder, 'catalog');
  assert.equal(upstream.uploads[0].mimeType, 'image/png');
  assert.equal(uploads[0].provider, 'cloudinary');
  assert.equal(uploads[0].secureUrl, 'https://res.cloudinary.com/x/upload/catalog/a.png');
});

test('uploadImages surfaces upstream ApiErrors untouched', async () => {
  const ApiError = require('../../../src/utils/ApiError');
  const upstream = {
    async uploadFile() {
      throw new ApiError(502, 'Image could not be uploaded', ERROR_CODES.MEDIA_UPLOAD_FAILED);
    },
  };
  const service = new MediaService({ mediaService: upstream });
  await assert.rejects(
    () => service.uploadImages([file()]),
    (err) => err.statusCode === 502 && err.code === ERROR_CODES.MEDIA_UPLOAD_FAILED
  );
});

test('uploadImages maps unexpected failures to MEDIA_UPLOAD_FAILED (502)', async () => {
  const service = new MediaService({ mediaService: fakeMediaService({ failOn: 0 }) });
  await assert.rejects(
    () => service.uploadImages([file()]),
    (err) => err.statusCode === 502 && err.code === ERROR_CODES.MEDIA_UPLOAD_FAILED
  );
});
