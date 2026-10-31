'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateDispatchInput } = require('../../../src/modules/courier/courier.validation');
const { ERROR_CODES } = require('../../../src/constants');

test('validateDispatchInput accepts an empty body', () => {
  assert.deepEqual(validateDispatchInput({}), { value: { note: null } });
  assert.deepEqual(validateDispatchInput(undefined), { value: { note: null } });
});

test('validateDispatchInput trims the optional note', () => {
  const { value } = validateDispatchInput({ note: '  urgent  ' });
  assert.equal(value.note, 'urgent');
});

test('validateDispatchInput rejects non-string notes', () => {
  assert.throws(() => validateDispatchInput({ note: 5 }), (err) => err.code === ERROR_CODES.INVALID_COURIER_REQUEST);
});

test('validateDispatchInput rejects unknown and operator keys', () => {
  assert.throws(() => validateDispatchInput({ orderId: 'x' }), (err) => err.code === ERROR_CODES.INVALID_COURIER_REQUEST);
  assert.throws(() => validateDispatchInput({ $set: {} }), (err) => err.code === ERROR_CODES.INVALID_COURIER_REQUEST);
  assert.throws(() => validateDispatchInput('not-an-object'), (err) => err.code === ERROR_CODES.INVALID_COURIER_REQUEST);
});
