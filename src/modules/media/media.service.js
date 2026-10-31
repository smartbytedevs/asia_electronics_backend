'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const { MEDIA_LIMITS, MEDIA_MESSAGES } = require('./media.constants');

/**
 * Catalog media service. Delegates each validated file to the configured
 * media service (the Cloudinary adapter by default) and returns the safe
 * media objects. Uploads are sequential so ordering is deterministic and a
 * single failure surfaces a clean MEDIA_UPLOAD_FAILED without masking.
 */
class MediaService {
  constructor({ mediaService } = {}) {
    if (!mediaService || typeof mediaService.uploadFile !== 'function') {
      throw new Error('MediaService requires a mediaService implementing uploadFile');
    }
    this.mediaService = mediaService;
  }

  async uploadImages(files) {
    const uploads = [];
    for (const file of files) {
      try {
        const media = await this.mediaService.uploadFile({
          buffer: file.buffer,
          mimeType: file.contentType,
          originalName: file.originalName,
          folder: MEDIA_LIMITS.FOLDER,
        });
        uploads.push(media);
      } catch (err) {
        if (err instanceof ApiError) {
          throw err;
        }
        console.error(`[media] catalog upload failed: ${err && err.message}`);
        throw new ApiError(502, MEDIA_MESSAGES.UPLOAD_FAILED, ERROR_CODES.MEDIA_UPLOAD_FAILED);
      }
    }
    return uploads;
  }
}

module.exports = { MediaService };
