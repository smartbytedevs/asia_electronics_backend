'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const { parseMultipartFormData } = require('../../utils/multipart');
const { validateMediaUpload } = require('./media.validation');
const { MEDIA_LIMITS, MEDIA_MESSAGES } = require('./media.constants');

/**
 * Thin catalog media controller: parse the multipart body, validate, delegate
 * to the media service, serialize the envelope. The response carries only safe
 * provider references (provider/publicId/url/resourceType/format) — never
 * credentials.
 */
function createMediaController({ mediaService } = {}) {
  if (!mediaService || typeof mediaService.uploadImages !== 'function') {
    throw new Error('createMediaController requires a mediaService');
  }

  return {
    // POST /api/v1/admin/media/upload — ADMIN/STAFF, multipart/form-data.
    uploadImages: async (req, res) => {
      const contentType = req.get('Content-Type') || '';
      if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
        throw new ApiError(
          400,
          MEDIA_MESSAGES.MULTIPART_REQUIRED,
          ERROR_CODES.INVALID_MEDIA_UPLOAD
        );
      }
      const parsed = parseMultipartFormData(req.body, contentType, {
        maxFileBytes: MEDIA_LIMITS.IMAGE_MAX_BYTES,
        invalidCode: ERROR_CODES.INVALID_MEDIA_UPLOAD,
      });
      const { files } = validateMediaUpload(parsed);
      const uploads = await mediaService.uploadImages(files);
      res.status(201).json({
        success: true,
        message: MEDIA_MESSAGES.UPLOADED,
        data: {
          uploads: uploads.map((media) => ({
            provider: media.provider,
            publicId: media.publicId,
            url: media.secureUrl,
            resourceType: media.resourceType,
            format: media.format,
          })),
        },
      });
    },
  };
}

module.exports = { createMediaController };
