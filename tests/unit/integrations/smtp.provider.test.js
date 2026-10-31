'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { createSmtpEmailProvider } = require('../../../src/integrations/email/smtp/smtp.provider');
const {
  EMAIL_PROVIDER_ERROR_CODES,
  isEmailProviderError,
} = require('../../../src/integrations/email/email.errors');

/**
 * A minimal fake SMTP server (RFC 5321) listening on 127.0.0.1:0. It drives a
 * real client socket through EHLO / AUTH PLAIN / MAIL FROM / RCPT TO / DATA /
 * QUIT so the provider's full send path is exercised without any external
 * network or credentials.
 */
function createFakeSmtpServer({ rejectAuth = false } = {}) {
  const receivedLines = [];
  const connections = [];
  let acceptedAuth = null;

  const server = net.createServer((socket) => {
    connections.push(socket);
    let buffer = '';
    let inData = false;

    const send = (line) => socket.write(`${line}\r\n`);

    send('220 fake ESMTP ready');

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        receivedLines.push(line);

        if (inData) {
          if (line === '.') {
            inData = false;
            send('250 2.0.0 Ok: queued as fake-message-id');
          }
          continue;
        }

        if (/^EHLO\s/i.test(line)) {
          send('250-fake ESMTP');
          send('250 AUTH PLAIN');
        } else if (/^AUTH PLAIN\s/i.test(line)) {
          const decoded = Buffer.from(line.slice('AUTH PLAIN '.length), 'base64').toString('utf8');
          const [authzid, user, password] = decoded.split('\0');
          acceptedAuth = { authzid, user, password };
          if (rejectAuth) {
            send('535 5.7.8 Authentication credentials invalid');
          } else {
            send('235 2.7.0 Authentication successful');
          }
        } else if (/^MAIL FROM:/i.test(line)) {
          send('250 2.1.0 Ok');
        } else if (/^RCPT TO:/i.test(line)) {
          send('250 2.1.5 Ok');
        } else if (/^DATA$/i.test(line)) {
          inData = true;
          send('354 End data with <CR><LF>.<CR><LF>');
        } else if (/^QUIT$/i.test(line)) {
          send('221 2.0.0 Bye');
          socket.end();
        }
      }
    });
  });

  return {
    server,
    receivedLines,
    get acceptedAuth() {
      return acceptedAuth;
    },
    listen() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    close() {
      return new Promise((resolve) => {
        for (const socket of connections) {
          socket.destroy();
        }
        server.close(() => resolve());
      });
    },
  };
}

async function withFakeServer(fn) {
  const fake = createFakeSmtpServer();
  const port = await fake.listen();
  try {
    await fn(fake, port);
  } finally {
    await fake.close();
  }
}

function smtpProvider(port, { user = 'sender@example.com', password = 'secret' } = {}) {
  return createSmtpEmailProvider({
    host: '127.0.0.1',
    port,
    user,
    password,
    from: 'sender@example.com',
    timeoutMs: 5000,
  });
}

test('provider exposes the smtp label and a sendEmail function', () => {
  const provider = createSmtpEmailProvider({ host: 'smtp.example.com', port: 587 });
  assert.equal(provider.provider, 'smtp');
  assert.equal(typeof provider.sendEmail, 'function');
});

test('sendEmail throws NOT_CONFIGURED when host is missing', async () => {
  const provider = createSmtpEmailProvider({ from: 'noreply@example.com' });
  await assert.rejects(
    provider.sendEmail({ to: 'a@example.com', subject: 'x', text: 'x' }),
    (err) => isEmailProviderError(err) && err.code === EMAIL_PROVIDER_ERROR_CODES.NOT_CONFIGURED
  );
});

test('sendEmail throws NOT_CONFIGURED when from is missing', async () => {
  const provider = createSmtpEmailProvider({ host: 'smtp.example.com' });
  await assert.rejects(
    provider.sendEmail({ to: 'a@example.com', subject: 'x', text: 'x' }),
    (err) => isEmailProviderError(err) && err.code === EMAIL_PROVIDER_ERROR_CODES.NOT_CONFIGURED
  );
});

test('sendEmail delivers a real message and returns the SMTP message id', async () => {
  await withFakeServer(async (fake, port) => {
    const result = await smtpProvider(port).sendEmail({
      to: 'customer@example.com',
      subject: 'Order Confirmation',
      html: '<p>Hello</p>',
      text: 'Hello\r\n.5 items left\r\nGoodbye',
    });

    assert.equal(result.provider, 'smtp');
    assert.equal(result.messageId, 'fake-message-id');
    assert.deepEqual(result.accepted, ['customer@example.com']);

    const transcript = fake.receivedLines.join('\n');
    assert.match(transcript, /^EHLO localhost$/m);
    assert.match(transcript, /^MAIL FROM:<sender@example.com>$/m);
    assert.match(transcript, /^RCPT TO:<customer@example.com>$/m);
    assert.match(transcript, /^DATA$/m);
    assert.match(transcript, /^QUIT$/m);
    assert.match(transcript, /^Subject: Order Confirmation$/m);
    assert.match(transcript, /^<p>Hello<\/p>$/m);
    assert.match(transcript, /^\.\.5 items left$/m, 'message lines are dot-stuffed per RFC 5321');

    assert.deepEqual(fake.acceptedAuth, {
      authzid: '',
      user: 'sender@example.com',
      password: 'secret',
    });
  });
});

test('sendEmail maps a 535 auth rejection to PROVIDER_REJECTED', async () => {
  const fake = createFakeSmtpServer({ rejectAuth: true });
  const port = await fake.listen();
  try {
    const provider = smtpProvider(port, { password: 'wrong' });
    await assert.rejects(
      provider.sendEmail({ to: 'customer@example.com', subject: 'x', text: 'x' }),
      (err) => isEmailProviderError(err) && err.code === EMAIL_PROVIDER_ERROR_CODES.PROVIDER_REJECTED
    );
  } finally {
    await fake.close();
  }
});

test('sendEmail failure logs never leak the password or the AUTH token', async () => {
  const fake = createFakeSmtpServer({ rejectAuth: true });
  const port = await fake.listen();
  const originalError = console.error;
  const logs = [];
  console.error = (msg, extra) => logs.push({ msg, extra });
  try {
    const provider = smtpProvider(port, { password: 'super-secret-password' });
    await assert.rejects(provider.sendEmail({ to: 'customer@example.com', subject: 'x', text: 'x' }));
  } finally {
    console.error = originalError;
    await fake.close();
  }
  const serialized = JSON.stringify(logs);
  assert.ok(!serialized.includes('super-secret-password'), 'the password never reaches the logs');
  assert.ok(!serialized.includes('AUTH PLAIN'), 'the AUTH token never reaches the logs');
  assert.ok(serialized.includes('c***r@example.com'), 'the failure log masks the recipient');
});

test('sendEmail maps a connection refusal to PROVIDER_UNAVAILABLE', async () => {
  const port = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  const provider = smtpProvider(port);
  await assert.rejects(
    provider.sendEmail({ to: 'customer@example.com', subject: 'x', text: 'x' }),
    (err) =>
      isEmailProviderError(err) && err.code === EMAIL_PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE
  );
});
