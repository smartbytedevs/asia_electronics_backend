'use strict';

/**
 * Media integration boundary (Phase 08, ADR-0016).
 *
 * The payment service depends on the media INTERFACE only — never on a
 * specific provider. A conforming media service implements:
 *
 *   uploadFile({ buffer, mimeType, originalName }) → Promise<{
 *     provider: string, publicId: string, secureUrl: string,
 *     resourceType: string, format: string }>
 *
 *   deleteFile(media) → Promise<void>   (best-effort cleanup; safe no-op for
 *                                        unknown/foreign assets)
 *
 * Implementations: `./cloudinary/cloudinary.adapter.js` (production REST
 * client) and `./media.mock.js` (test double). Credentials never leave the
 * adapter — media objects hold only safe provider references.
 */

function assertMediaService(mediaService) {
  if (
    !mediaService ||
    typeof mediaService.uploadFile !== 'function' ||
    typeof mediaService.deleteFile !== 'function'
  ) {
    throw new Error(
      'A media service implementing the media interface (uploadFile/deleteFile) is required'
    );
  }
}

function isMediaObject(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof value.provider === 'string' &&
      typeof value.publicId === 'string' &&
      typeof value.secureUrl === 'string' &&
      typeof value.resourceType === 'string' &&
      typeof value.format === 'string'
  );
}

module.exports = { assertMediaService, isMediaObject };
