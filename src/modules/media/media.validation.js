'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const { MEDIA_LIMITS, IMAGE_MEDIA_RULES, MEDIA_MESSAGES } = require('./media.constants');

function invalid(message, code = ERROR_CODES.INVALID_MEDIA_UPLOAD) {
  return new ApiError(400, message, code);
}

function extensionOf(originalName) {
  if (typeof originalName !== 'string') {
    return null;
  }
  const base = originalName.trim().toLowerCase();
  const dot = base.lastIndexOf('.');
  if (dot === -1 || dot === base.length - 1) {
    return null;
  }
  return base.slice(dot + 1);
}

const MAGIC_BYTES = Object.freeze({
  'image/jpeg': Object.freeze([[0xff, 0xd8, 0xff]]),
  'image/png': Object.freeze([[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]]),
  'image/webp': Object.freeze([
    [0x52, 0x49, 0x46, 0x46], // "RIFF"
    // WEBP magic is verified structurally below (bytes 8-11 == "WEBP").
  ]),
});

function matchesMagic(buffer, patterns) {
  for (const pattern of patterns) {
    if (buffer.length < pattern.length) {
      continue;
    }
    const ok = pattern.every((byte, index) => buffer[index] === byte);
    if (ok) {
      return true;
    }
  }
  return false;
}

/**
 * Validates a single uploaded image: MIME allowlist, extension ↔ MIME
 * consistency, magic bytes, and size. Rejects SVG/HTML/JS/PDF/executables and
 * polyglot files that pass a MIME check but carry foreign content.
 */
function validateImageFile(file) {
  if (!file || !file.buffer || file.buffer.length === 0) {
    throw invalid(MEDIA_MESSAGES.FILE_REQUIRED, ERROR_CODES.MEDIA_UPLOAD_REQUIRED);
  }
  if (file.buffer.length > MEDIA_LIMITS.IMAGE_MAX_BYTES) {
    throw invalid(`image exceeds the ${MEDIA_LIMITS.IMAGE_MAX_BYTES} byte limit`);
  }

  const mimeType = typeof file.contentType === 'string' ? file.contentType.toLowerCase() : null;
  const allowedExtensions = IMAGE_MEDIA_RULES[mimeType];
  if (!allowedExtensions) {
    throw invalid(MEDIA_MESSAGES.INVALID_IMAGE);
  }

  const extension = extensionOf(file.originalName);
  if (!extension || !allowedExtensions.includes(extension)) {
    throw invalid(`image extension must be one of: ${allowedExtensions.join(', ')}`);
  }

  if (mimeType === 'image/webp') {
    const isRiff = matchesMagic(file.buffer, MAGIC_BYTES['image/webp']);
    const webpTag =
      file.buffer.length >= 12 &&
      file.buffer[8] === 0x57 && // W
      file.buffer[9] === 0x45 && // E
      file.buffer[10] === 0x42 && // B
      file.buffer[11] === 0x50; // P
    if (!isRiff || !webpTag) {
      throw invalid(MEDIA_MESSAGES.INVALID_IMAGE);
    }
  } else if (!matchesMagic(file.buffer, MAGIC_BYTES[mimeType])) {
    throw invalid(MEDIA_MESSAGES.INVALID_IMAGE);
  }

  return file;
}

/**
 * Validates a parsed multipart upload: no text fields, no foreign file
 * fields, at least one `files` part, at most MAX_FILES, each a valid image.
 */
function validateMediaUpload({ fields, files }) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw invalid('multipart text fields are not allowed');
  }
  const fieldNames = Object.keys(fields);
  if (fieldNames.length > 0) {
    throw invalid(`unexpected text field(s): ${fieldNames.join(', ')}`);
  }

  const uploadFiles = Array.isArray(files) ? files : [];
  if (uploadFiles.length === 0) {
    throw invalid(MEDIA_MESSAGES.FILE_REQUIRED, ERROR_CODES.MEDIA_UPLOAD_REQUIRED);
  }
  if (uploadFiles.length > MEDIA_LIMITS.MAX_FILES) {
    throw invalid(MEDIA_MESSAGES.TOO_MANY_FILES);
  }
  for (const file of uploadFiles) {
    if (file.fieldName !== 'files') {
      throw invalid(`unknown file field "${file.fieldName}"`);
    }
  }

  return { files: uploadFiles.map(validateImageFile) };
}

module.exports = { validateMediaUpload, validateImageFile };
