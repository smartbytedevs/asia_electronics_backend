'use strict';

const crypto = require('crypto');

/**
 * Minimal Cloudinary REST client (Phase 08, ADR-0016).
 *
 * Talks to the Cloudinary upload/destroy endpoints over `fetch` — the official
 * SDK is deliberately NOT installed (no new dependencies). Requests are signed
 * with an SHA-1 signature over the sorted parameters (the standard Cloudinary
 * signing scheme), so the API key/secret never travel in query strings.
 *
 * Credentials come from the centralized config (`config.cloudinary`) and are
 * never exposed to callers, logs, or responses.
 */

const CLOUDINARY_UPLOAD_URL = (cloudName) =>
  `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`;

const CLOUDINARY_DESTROY_URL = (cloudName) =>
  `https://api.cloudinary.com/v1_1/${cloudName}/image/destroy`;

/**
 * Computes the Cloudinary SHA-1 signature: lexicographically-sorted
 * `key=value` pairs joined with `&`, then the api_secret appended, SHA-1 hex.
 * `file` is intentionally excluded (Cloudinary excludes it from signing).
 */
function signCloudinaryParams(params, apiSecret) {
  const sorted = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
  return crypto.createHash('sha1').update(`${sorted}${apiSecret}`).digest('hex');
}

function createCloudinaryClient({ cloudName, apiKey, apiSecret, fetchImpl = fetch }) {
  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error('Cloudinary is not configured (missing cloudName/apiKey/apiSecret)');
  }

  async function uploadImage({ buffer, publicId, folder }) {
    const timestamp = Math.floor(Date.now() / 1000);
    const baseParams = {
      timestamp,
      folder,
      public_id: publicId,
    };
    const signature = signCloudinaryParams(baseParams, apiSecret);

    const form = new FormData();
    form.append('file', new Blob([buffer]), `${publicId}.png`);
    form.append('timestamp', String(timestamp));
    form.append('folder', folder);
    form.append('public_id', publicId);
    form.append('api_key', apiKey);
    form.append('signature', signature);

    const response = await fetchImpl(CLOUDINARY_UPLOAD_URL(cloudName), {
      method: 'POST',
      body: form,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.public_id) {
      throw new Error(
        `Cloudinary upload failed (${response.status}): ${payload.error && payload.error.message ? payload.error.message : 'unknown error'}`
      );
    }
    return payload;
  }

  async function destroyImage(publicId) {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signCloudinaryParams({ timestamp, public_id: publicId }, apiSecret);

    const form = new FormData();
    form.append('public_id', publicId);
    form.append('timestamp', String(timestamp));
    form.append('api_key', apiKey);
    form.append('signature', signature);

    const response = await fetchImpl(CLOUDINARY_DESTROY_URL(cloudName), {
      method: 'POST',
      body: form,
    });
    const payload = await response.json().catch(() => ({}));
    return payload.result === 'ok' || payload.result === 'not found';
  }

  return {
    uploadImage,
    destroyImage,
  };
}

module.exports = { createCloudinaryClient, signCloudinaryParams };
