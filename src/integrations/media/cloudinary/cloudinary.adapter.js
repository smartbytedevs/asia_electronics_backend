'use strict';

const crypto = require('crypto');
const ApiError = require('../../../utils/ApiError');
const { ERROR_CODES } = require('../../../constants');
const { PAYMENT_MESSAGES } = require('../../../modules/payments/payment.constants');
const config = require('../../../config');
const { createCloudinaryClient } = require('./cloudinary.client');

/**
 * Production Cloudinary media adapter (Phase 08, ADR-0016).
 *
 * Implements the media interface (`media.interface.js`). Credentials are read
 * from the centralized config and are NEVER serialized or logged; the media
 * object it returns holds only safe provider references.
 *
 * Upload failure surfaces as a 502 (upstream errors) / 500 (not configured)
 * ApiError. The default is the payment-proof error (Phase 08); callers serving
 * other asset kinds (e.g. catalog images) pass their own `uploadMessage` and
 * `uploadErrorCode` via the factory options. Cleanup (`deleteFile`) is
 * best-effort and never throws — it logs only the safe `publicId`.
 */

const DEFAULT_FOLDER = 'payments';

function createCloudinaryMediaService({
  client,
  folder = DEFAULT_FOLDER,
  uploadMessage = PAYMENT_MESSAGES.PROOF_UPLOAD_FAILED,
  uploadErrorCode = ERROR_CODES.PAYMENT_PROOF_UPLOAD_FAILED,
} = {}) {
  function uploadFailed() {
    return new ApiError(502, uploadMessage, uploadErrorCode);
  }

  function notConfigured() {
    return new ApiError(500, uploadMessage, uploadErrorCode);
  }

  const isConfigured = Boolean(config.cloudinary.cloudName && config.cloudinary.apiKey && config.cloudinary.apiSecret);

  const effectiveClient =
    client ||
    (isConfigured
      ? createCloudinaryClient({
          cloudName: config.cloudinary.cloudName,
          apiKey: config.cloudinary.apiKey,
          apiSecret: config.cloudinary.apiSecret,
        })
      : null);

  return {
    isConfigured,

    async uploadFile({ buffer, mimeType, originalName, folder: folderOverride } = {}) {
      if (!effectiveClient) {
        throw notConfigured();
      }
      try {
        const publicId = crypto.randomUUID();
        const result = await effectiveClient.uploadImage({
          buffer,
          folder: folderOverride || folder,
          publicId,
        });
        return {
          provider: 'cloudinary',
          publicId: result.public_id,
          secureUrl: result.secure_url,
          resourceType: result.resource_type || 'image',
          format: result.format || null,
        };
      } catch (err) {
        if (err instanceof ApiError) {
          throw err;
        }
        // Log only the safe reference — never credentials.
        console.error(`[media] Cloudinary upload failed: ${err && err.message}`);
        throw uploadFailed();
      }
    },

    async deleteFile(media) {
      if (!effectiveClient || !media || !media.publicId) {
        return;
      }
      try {
        await effectiveClient.destroyImage(media.publicId);
      } catch (err) {
        console.error(`[media] Cloudinary cleanup failed for ${media.publicId}: ${err && err.message}`);
      }
    },
  };
}

module.exports = { createCloudinaryMediaService };
