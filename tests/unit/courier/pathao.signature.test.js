'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { verifyWebhookSignature } = require('../../../src/modules/courier/pathao/pathao.signature');

test('verifyWebhookSignature accepts an exact match', () => {
  assert.equal(verifyWebhookSignature({ signature: 'secret-123', secret: 'secret-123' }), true);
});

test('verifyWebhookSignature rejects mismatches', () => {
  assert.equal(verifyWebhookSignature({ signature: 'a', secret: 'b' }), false);
  assert.equal(verifyWebhookSignature({ signature: 'secret', secret: 'other' }), false);
});

test('verifyWebhookSignature fails closed on missing inputs', () => {
  assert.equal(verifyWebhookSignature({ signature: null, secret: 's' }), false);
  assert.equal(verifyWebhookSignature({ signature: 's', secret: null }), false);
  assert.equal(verifyWebhookSignature({ signature: 's', secret: '' }), false);
});
