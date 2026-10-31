'use strict';

const crypto = require('crypto');
const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');

/**
 * In-memory media service (test double, Phase 08).
 *
 * Implements the same interface as the Cloudinary adapter so payment services
 * and integration fixtures can run without network/credentials. Exposes a
 * `store` map and a `calls` log so tests can assert on upload/cleanup
 * behaviour. `failUploads` forces every upload to throw
 * `PAYMENT_PROOF_UPLOAD_FAILED` (exercises the distributed boundary: upload
 * success + DB failure cleanup, and upload failure paths).
 */

const FORMATS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function createMemoryMediaService({ failUploads = false } = {}) {
  const store = new Map();
  const calls = { uploads: [], deletes: [] };

  return {
    store,
    calls,

    async uploadFile({ buffer, mimeType, originalName }) {
      calls.uploads.push({ mimeType, originalName, size: buffer ? buffer.length : 0 });
      if (failUploads) {
        throw new ApiError(
          502,
          'Payment proof could not be uploaded',
          ERROR_CODES.PAYMENT_PROOF_UPLOAD_FAILED
        );
      }
      const publicId = `payments/${crypto.randomUUID()}`;
      store.set(publicId, Buffer.from(buffer));
      return {
        provider: 'mock',
        publicId,
        secureUrl: `https://mock.media/${publicId}`,
        resourceType: 'image',
        format: FORMATS[mimeType] || 'png',
      };
    },

    async deleteFile(media) {
      calls.deletes.push(media ? media.publicId : null);
      if (media && media.publicId && store.has(media.publicId)) {
        store.delete(media.publicId);
      }
    },
  };
}

module.exports = { createMemoryMediaService };
