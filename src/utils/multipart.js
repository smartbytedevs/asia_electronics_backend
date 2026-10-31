'use strict';

const ApiError = require('./ApiError');
const { ERROR_CODES } = require('../constants');

/**
 * Minimal, strict multipart/form-data parser (Phase 08, ADR-0016).
 *
 * Deliberately NOT a general-purpose upload library: it parses a single
 * request body into text fields + file buffers with a hard size cap and strict
 * structure handling, so every malformed input surfaces as a clean 4xx
 * (`INVALID_PAYMENT` / `INVALID_PAYMENT_PROOF`) instead of an unhandled 5xx.
 *
 * Security properties:
 * - Requires a valid `boundary` derived from the Content-Type header.
 * - Rejects missing/invalid/malformed boundaries and unterminated parts.
 * - Caps the total body via the caller's `maxFileBytes` and the Express raw
 *   body limit; files larger than the cap are rejected.
 * - Does NOT interpret file content — MIME/extension/magic-byte validation is
 *   the caller's job (see payment validation).
 */

function invalidWithCode(message, code = ERROR_CODES.INVALID_PAYMENT) {
  return new ApiError(400, message, code);
}

function parseBoundary(contentType) {
  if (typeof contentType !== 'string') {
    return null;
  }
  const sections = contentType.split(';').map((s) => s.trim());
  if (!sections[0] || sections[0].toLowerCase() !== 'multipart/form-data') {
    return null;
  }
  for (const section of sections.slice(1)) {
    if (!/^boundary=/i.test(section)) {
      continue;
    }
    const value = section.slice('boundary='.length).replace(/^["']|["']$/g, '');
    if (value.length > 0 && value.length <= 200) {
      return value;
    }
    return null;
  }
  return null;
}

function parseDisposition(headerBlock) {
  const dispositionLine = headerBlock
    .split('\r\n')
    .find((line) => /^content-disposition:/i.test(line));
  if (!dispositionLine) {
    throw invalidWithCode('multipart part is missing a Content-Disposition header');
  }
  const params = {};
  const regex = /;\s*([a-zA-Z0-9_-]+)="([^"]*)"/g;
  let match;
  while ((match = regex.exec(dispositionLine)) !== null) {
    params[match[1]] = match[2];
  }
  return { name: params.name, filename: params.filename === undefined ? null : params.filename };
}

function parseContentTypeOfPart(headerBlock) {
  const line = headerBlock
    .split('\r\n')
    .find((entry) => /^content-type:/i.test(entry));
  if (!line) {
    return null;
  }
  return line.slice(line.indexOf(':') + 1).trim().toLowerCase();
}

/**
 * Parses a raw multipart/form-data body.
 *
 * @param {Buffer} rawBody - the raw request body
 * @param {string} contentType - the `Content-Type` header value
 * @param {{ maxFileBytes?: number, invalidCode?: string }} [options]
 * @returns {{ fields: Object<string, string>, files: Array<{
 *   fieldName: string, originalName: string|null, contentType: string|null,
 *   buffer: Buffer }> }}
 */
function parseMultipartFormData(
  rawBody,
  contentType,
  { maxFileBytes = 2 * 1024 * 1024, invalidCode = ERROR_CODES.INVALID_PAYMENT } = {}
) {
  const invalid = (message) => invalidWithCode(message, invalidCode);
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    throw invalid('multipart request body is empty');
  }
  const boundary = parseBoundary(contentType);
  if (!boundary) {
    throw invalid('multipart/form-data with a valid boundary is required');
  }

  const delimiter = Buffer.from(`--${boundary}`);
  const body = rawBody;

  if (body.indexOf(delimiter) !== 0) {
    throw invalid('multipart body does not start with the expected boundary');
  }

  const parts = [];
  let cursor = delimiter.length;

  while (cursor < body.length) {
    // Closing boundary "--boundary--" ends the stream.
    if (body.subarray(cursor, cursor + 2).toString() === '--') {
      break;
    }
    if (body[cursor] === 0x0d && body[cursor + 1] === 0x0a) {
      cursor += 2;
    } else if (body[cursor] === 0x0a) {
      cursor += 1;
    } else {
      throw invalid('malformed multipart part boundary');
    }

    const headerEnd = body.indexOf('\r\n\r\n', cursor);
    if (headerEnd === -1) {
      throw invalid('malformed multipart part (missing header terminator)');
    }
    const headerBlock = body.subarray(cursor, headerEnd).toString('utf8');
    const bodyStart = headerEnd + 4;

    const nextBoundary = body.indexOf(delimiter, bodyStart);
    if (nextBoundary === -1) {
      throw invalid('malformed multipart part (missing closing boundary)');
    }

    let content = body.subarray(bodyStart, nextBoundary);
    if (
      content.length >= 2 &&
      content[content.length - 2] === 0x0d &&
      content[content.length - 1] === 0x0a
    ) {
      content = content.subarray(0, content.length - 2);
    }

    parts.push({ headerBlock, content });
    cursor = nextBoundary + delimiter.length;
  }

  const fields = {};
  const files = [];

  for (const part of parts) {
    const { name, filename } = parseDisposition(part.headerBlock);
    if (!name || name.length === 0 || name.length > 100) {
      throw invalid('multipart part has an invalid field name');
    }
    if (filename !== null) {
      if (part.content.length === 0) {
        throw invalid('uploaded file part is empty');
      }
      if (part.content.length > maxFileBytes) {
        throw invalid(`uploaded file exceeds the ${maxFileBytes} byte limit`);
      }
      files.push({
        fieldName: name,
        originalName: filename,
        contentType: parseContentTypeOfPart(part.headerBlock),
        buffer: part.content,
      });
    } else {
      const value = part.content.toString('utf8');
      if (Object.prototype.hasOwnProperty.call(fields, name)) {
        throw invalid(`multipart field "${name}" was provided more than once`);
      }
      fields[name] = value;
    }
  }

  return { fields, files };
}

module.exports = { parseMultipartFormData, parseBoundary };
