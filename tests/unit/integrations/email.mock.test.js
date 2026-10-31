'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryEmailService } = require('../../../src/integrations/email/email.mock');
const {
  EmailProviderError,
  EMAIL_PROVIDER_ERROR_CODES,
  isEmailProviderError,
} = require('../../../src/integrations/email');

test('memory email service records delivered messages with provider metadata', async () => {
  const email = createMemoryEmailService();
  const result = await email.sendEmail({
    to: 'customer@taqwa.test',
    subject: 'Payment received',
    html: '<p>hi</p>',
    text: 'hi',
  });

  assert.equal(result.provider, 'mock');
  assert.ok(result.messageId && result.messageId.startsWith('<mock-'));
  assert.deepEqual(result.accepted, ['customer@taqwa.test']);

  assert.equal(email.calls.sends.length, 1);
  assert.equal(email.calls.sends[0].to, 'customer@taqwa.test');
  assert.equal(email.calls.sends[0].subject, 'Payment received');
  assert.equal(email.sent.length, 1);
});

test('failNextSendWith injects a provider failure exactly once', async () => {
  const email = createMemoryEmailService();
  email.failNextSendWith(
    new EmailProviderError(EMAIL_PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE, 'connection refused')
  );

  await assert.rejects(
    () => email.sendEmail({ to: 'a@b.c', subject: 's', html: 'h', text: 't' }),
    (err) =>
      err.code === EMAIL_PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE && isEmailProviderError(err)
  );

  // The injection is consumed — the next send succeeds.
  const ok = await email.sendEmail({ to: 'a@b.c', subject: 's', html: 'h', text: 't' });
  assert.equal(ok.provider, 'mock');
  assert.equal(email.calls.sends.length, 2);
});
