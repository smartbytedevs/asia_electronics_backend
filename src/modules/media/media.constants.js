'use strict';

/**
 * Catalog media upload constants (admin image uploads).
 *
 * Catalog images (product images, measurement-guide diagrams, category
 * images) are uploaded to the existing Cloudinary media service through a
 * single authenticated admin endpoint. The backend stores only the resulting
 * URLs in the product/category contracts — never binary data.
 */

const MEDIA_LIMITS = Object.freeze({
  // Per-file size cap. Deliberately above the payment-proof cap: product
  // photography from phones is larger than receipts. Hard cap from the
  // multipart parser + the express.raw body limit below.
  IMAGE_MAX_BYTES: 5 * 1024 * 1024,
  // Maximum number of image files accepted in a single upload request.
  MAX_FILES: 10,
  // express.raw body cap. Above the per-file cap so an oversized submission
  // surfaces as a clean 4xx from the media validator instead of a 413.
  MULTIPART_BODY_MAX_BYTES: 12 * 1024 * 1024,
  // Cloudinary folder for catalog assets.
  FOLDER: 'catalog',
});

/**
 * Accepted catalog image types. Matches the payment-proof allowlist (JPEG,
 * PNG, WEBP). SVG/HTML/JS/PDF/executables and polyglots are rejected.
 */
const IMAGE_MEDIA_RULES = Object.freeze({
  'image/jpeg': Object.freeze(['jpg', 'jpeg']),
  'image/png': Object.freeze(['png']),
  'image/webp': Object.freeze(['webp']),
});

const MEDIA_MESSAGES = Object.freeze({
  UPLOADED: 'Images uploaded successfully',
  FILE_REQUIRED: 'At least one image file is required',
  TOO_MANY_FILES: 'At most 10 image files may be uploaded at once',
  INVALID_IMAGE: 'File must be a JPEG, PNG, or WEBP image',
  MULTIPART_REQUIRED: 'multipart/form-data is required for image upload',
  UPLOAD_FAILED: 'Image could not be uploaded',
});

module.exports = { MEDIA_LIMITS, IMAGE_MEDIA_RULES, MEDIA_MESSAGES };
