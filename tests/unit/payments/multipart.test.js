'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseMultipartFormData, parseBoundary } = require('../../../src/utils/multipart');
const { ERROR_CODES } = require('../../../src/constants');

const BOUNDARY = '----taqwaBoundary1234';

function buildBody({ fields = {}, files = [], boundary = BOUNDARY } = {}) {
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      )
    );
  }
  for (const file of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.type}\r\n\r\n`
      )
    );
    parts.push(file.buffer);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(parts);
}

test('parses a multipart body into text fields and one file', () => {
  const body = buildBody({
    fields: {
      paymentMethodId: '507f1f77bcf86cd799439061',
      transactionReference: 'REF-1',
      submittedAmountMinorUnits: '248000',
    },
    files: [{ name: 'proof', filename: 'receipt.png', type: 'image/png', buffer: Buffer.from('PNGDATA') }],
  });
  const parsed = parseMultipartFormData(body, `multipart/form-data; boundary=${BOUNDARY}`);
  assert.equal(parsed.fields.paymentMethodId, '507f1f77bcf86cd799439061');
  assert.equal(parsed.fields.transactionReference, 'REF-1');
  assert.equal(parsed.fields.submittedAmountMinorUnits, '248000');
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0].fieldName, 'proof');
  assert.equal(parsed.files[0].originalName, 'receipt.png');
  assert.equal(parsed.files[0].contentType, 'image/png');
  assert.equal(parsed.files[0].buffer.toString(), 'PNGDATA');
});

test('parseBoundary extracts a quoted or unquoted boundary', () => {
  assert.equal(parseBoundary(`multipart/form-data; boundary=${BOUNDARY}`), BOUNDARY);
  assert.equal(parseBoundary(`multipart/form-data; boundary="${BOUNDARY}"`), BOUNDARY);
  assert.equal(parseBoundary('application/json'), null);
  assert.equal(parseBoundary('multipart/form-data'), null);
  assert.equal(parseBoundary(''), null);
});

test('rejects empty bodies and bodies without a boundary', () => {
  assert.throws(() => parseMultipartFormData(Buffer.alloc(0), `multipart/form-data; boundary=${BOUNDARY}`), (err) => err.code === ERROR_CODES.INVALID_PAYMENT);
  assert.throws(() => parseMultipartFormData(Buffer.from('hello'), 'text/plain'), (err) => err.code === ERROR_CODES.INVALID_PAYMENT);
});

test('rejects malformed / truncated bodies', () => {
  const good = buildBody({ fields: { a: 'b' } });
  assert.throws(
    () => parseMultipartFormData(good.subarray(0, good.length - 8), `multipart/form-data; boundary=${BOUNDARY}`),
    (err) => err.code === ERROR_CODES.INVALID_PAYMENT
  );
  assert.throws(
    () => parseMultipartFormData(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="a"\r\n\r\nb`), `multipart/form-data; boundary=${BOUNDARY}`),
    (err) => err.code === ERROR_CODES.INVALID_PAYMENT
  );
});

test('rejects duplicate text fields and oversized files', () => {
  const dup = Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n`),
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="a"\r\n\r\n2\r\n`),
    Buffer.from(`--${BOUNDARY}--\r\n`),
  ]);
  assert.throws(() => parseMultipartFormData(dup, `multipart/form-data; boundary=${BOUNDARY}`), (err) => err.code === ERROR_CODES.INVALID_PAYMENT);

  const big = buildBody({
    files: [{ name: 'proof', filename: 'big.png', type: 'image/png', buffer: Buffer.alloc(3000, 1) }],
  });
  assert.throws(
    () => parseMultipartFormData(big, `multipart/form-data; boundary=${BOUNDARY}`, { maxFileBytes: 100 }),
    (err) => err.code === ERROR_CODES.INVALID_PAYMENT
  );
});
