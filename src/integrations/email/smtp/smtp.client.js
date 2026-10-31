'use strict';

const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');
const { EmailProviderError, EMAIL_PROVIDER_ERROR_CODES } = require('../email.errors');

/**
 * Minimal RFC 5321 SMTP client (Phase 11, ADR-0019).
 *
 * Deliberately dependency-free (Node built-ins only, matching the repository's
 * zero-runtime-dependency philosophy). One instance is created PER message:
 * connect → EHLO → (STARTTLS + re-EHLO when the server advertises it) →
 * AUTH PLAIN (when a user is configured) → MAIL FROM → RCPT TO → DATA → QUIT.
 *
 * Error classification (mirrors the email provider taxonomy):
 *   - network/timeout/connection-loss → PROVIDER_UNAVAILABLE (retryable)
 *   - transient 4xx SMTP replies → PROVIDER_UNAVAILABLE (retryable)
 *   - permanent 5xx SMTP replies → PROVIDER_REJECTED (no point retrying a
 *     rejected recipient/from address — fix the configuration)
 *   - malformed replies → PROVIDER_REJECTED
 *
 * Message building:
 *   - multipart/alternative (text + html) with a random boundary
 *   - header-injection-safe (CR/LF stripped from the subject)
 *   - dot-stuffed (any line beginning with `.` is doubled per RFC 5321 §4.5.2)
 */

const TIMEOUT_MESSAGE = 'SMTP operation timed out';

function stripCrLf(value) {
  return String(value == null ? '' : value).replace(/[\r\n]+/g, ' ');
}

function isRetryableNetworkErrorCode(code) {
  return [
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'ECONNABORTED',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EPIPE',
    'EAI_AGAIN',
    'ENOTFOUND',
  ].includes(code);
}

function dotStuff(raw) {
  const lines = raw.split('\r\n');
  const stuffed = lines.map((line) => (line.startsWith('.') ? `.${line}` : line));
  return stuffed.join('\r\n');
}

function unwrapMessageId(replyText) {
  const match = String(replyText || '').match(/queued\s+as\s+([^\s]+)/i);
  if (match) {
    return match[1];
  }
  const angle = String(replyText || '').match(/<([^<>]+)>/);
  if (angle) {
    return angle[1];
  }
  return null;
}

class SmtpClient {
  constructor({
    host,
    port = 587,
    user = '',
    password = '',
    secure = false,
    timeoutMs = 15000,
    helo = 'localhost',
  }) {
    this.host = host;
    this.port = port;
    this.user = user;
    this.password = password;
    this.secure = Boolean(secure);
    this.timeoutMs = timeoutMs;
    this.helo = helo;
    this.socket = null;
    this.buffer = '';
    this.pending = [];
  }

  /**
   * Sends one message. Always leaves the connection closed: on success a QUIT
   * is attempted, on failure the socket is destroyed. Returns
   * `{ messageId, provider, accepted }`.
   */
  async send({ from, to, subject, html, text }) {
    if (!from || typeof from !== 'string' || !from.includes('@')) {
      throw new EmailProviderError(
        EMAIL_PROVIDER_ERROR_CODES.PROVIDER_REJECTED,
        'A valid SMTP from address is required'
      );
    }
    const recipients = (Array.isArray(to) ? to : [to])
      .filter((r) => r && typeof r === 'string' && r.includes('@'));
    if (recipients.length === 0) {
      throw new EmailProviderError(
        EMAIL_PROVIDER_ERROR_CODES.PROVIDER_REJECTED,
        'At least one valid SMTP recipient is required'
      );
    }

    let reply;
    try {
      await this.connect();

      reply = await this.readResponse();
      this.assertCode(reply, [220], 'greeting');

      await this.write(`EHLO ${stripCrLf(this.helo)}`);
      reply = await this.readResponse();
      this.assertCode(reply, [250], 'EHLO');

      // Opportunistic STARTTLS when the server advertises it and we are not
      // already on a TLS socket (port 465). After the handshake we re-EHLO.
      if (!this.secure && /\bSTARTTLS\b/i.test(reply.text)) {
        await this.write('STARTTLS');
        reply = await this.readResponse();
        this.assertCode(reply, [220], 'STARTTLS');
        await this.upgradeToTls();
        await this.write(`EHLO ${stripCrLf(this.helo)}`);
        reply = await this.readResponse();
        this.assertCode(reply, [250], 'EHLO');
      }

      if (this.user) {
        const token = Buffer.from(`\u0000${this.user}\u0000${this.password}`, 'utf8').toString(
          'base64'
        );
        await this.write(`AUTH PLAIN ${token}`);
        reply = await this.readResponse();
        this.assertCode(reply, [235], 'AUTH');
      }

      await this.write(`MAIL FROM:<${from}>`);
      reply = await this.readResponse();
      this.assertCode(reply, [250], 'MAIL FROM');

      for (const recipient of recipients) {
        await this.write(`RCPT TO:<${recipient}>`);
        reply = await this.readResponse();
        this.assertCode(reply, [250, 251], 'RCPT TO');
      }

      await this.write('DATA');
      reply = await this.readResponse();
      this.assertCode(reply, [354], 'DATA');

      await this.write(this.buildMessage({ from, to: recipients, subject, html, text }));
      await this.write('.');
      reply = await this.readResponse();
      this.assertCode(reply, [250], 'message');

      // QUIT is best-effort — the message is already accepted.
      try {
        await this.write('QUIT');
        await this.readResponse();
      } catch {
        // ignore — connection will be torn down below
      }

      return {
        messageId: unwrapMessageId(reply.text),
        provider: 'smtp',
        accepted: recipients,
      };
    } finally {
      this.destroy();
    }
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = this.secure
        ? tls.connect({ host: this.host, port: this.port, servername: this.host })
        : net.connect({ host: this.host, port: this.port });
      this.socket = socket;
      this.buffer = '';
      this.pending = [];

      const connectTimer = setTimeout(() => {
        const err = new EmailProviderError(
          EMAIL_PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE,
          TIMEOUT_MESSAGE
        );
        this.rejectAll(err);
        socket.destroy();
        reject(err);
      }, this.timeoutMs);

      this.dataHandler = (chunk) => {
        this.buffer += chunk.toString('utf8');
        this.drainResponses();
      };
      this.errorHandler = (err) => {
        this.rejectAll(this.mapError(err));
      };
      this.timeoutHandler = () => {
        const err = new EmailProviderError(
          EMAIL_PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE,
          TIMEOUT_MESSAGE
        );
        this.rejectAll(err);
        this.destroy();
      };
      this.closeHandler = () => {
        this.rejectAll(
          new EmailProviderError(
            EMAIL_PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE,
            'SMTP connection closed'
          )
        );
      };

      socket.on('data', this.dataHandler);
      socket.on('error', this.errorHandler);
      socket.on('timeout', this.timeoutHandler);
      socket.once('close', this.closeHandler);

      socket.once('connect', () => {
        clearTimeout(connectTimer);
        socket.setTimeout(this.timeoutMs);
        resolve();
      });
      socket.once('error', (err) => {
        clearTimeout(connectTimer);
        reject(this.mapError(err));
      });
    });
  }

  /**
   * Upgrades the plain socket to TLS (STARTTLS). The plain socket is paused
   * first and its listeners detached so decrypted bytes are only handled by the
   * TLS socket.
   */
  upgradeToTls() {
    return new Promise((resolve, reject) => {
      const plain = this.socket;
      plain.removeListener('data', this.dataHandler);
      plain.removeListener('error', this.errorHandler);
      plain.removeListener('timeout', this.timeoutHandler);
      plain.removeListener('close', this.closeHandler);
      plain.pause();

      const tlsSocket = tls.connect({ socket: plain, servername: this.host });
      this.socket = tlsSocket;
      this.buffer = '';
      this.pending = [];

      tlsSocket.on('data', this.dataHandler);
      tlsSocket.on('error', this.errorHandler);
      tlsSocket.on('timeout', this.timeoutHandler);
      tlsSocket.once('close', this.closeHandler);

      tlsSocket.setTimeout(this.timeoutMs);
      tlsSocket.setEncoding('utf8');

      tlsSocket.once('secureConnect', () => resolve());
      tlsSocket.once('error', (err) => reject(this.mapError(err)));
    });
  }

  write(line) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(
          new EmailProviderError(
            EMAIL_PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE,
            'SMTP connection closed'
          )
        );
        return;
      }
      this.socket.write(`${line}\r\n`, (err) => {
        if (err) {
          reject(this.mapError(err));
          return;
        }
        resolve();
      });
    });
  }

  /**
   * Resolves with the next complete SMTP reply `{ code, text }`. Replies are
   * consumed in order; a reply is complete when a line ends with a space
   * separator (`250 Ok`) rather than a dash (`250-Pipelining`).
   */
  readResponse() {
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.drainResponses();
    });
  }

  drainResponses() {
    while (this.pending.length > 0) {
      const response = this.parseCompleteResponse();
      if (!response) {
        return;
      }
      const next = this.pending.shift();
      next.resolve(response);
    }
  }

  parseCompleteResponse() {
    let start = 0;
    let code = null;
    const lines = [];
    while (start < this.buffer.length) {
      const newlineIndex = this.buffer.indexOf('\n', start);
      if (newlineIndex === -1) {
        return null; // incomplete line
      }
      let line = this.buffer.slice(start, newlineIndex);
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      const match = line.match(/^(\d{3})([ -])(.*)$/);
      if (!match) {
        throw new EmailProviderError(
          EMAIL_PROVIDER_ERROR_CODES.PROVIDER_REJECTED,
          `Malformed SMTP reply: ${line}`
        );
      }
      const lineCode = Number(match[1]);
      const isLastLine = match[2] === ' ';
      if (code === null) {
        code = lineCode;
      }
      lines.push(line);
      start = newlineIndex + 1;
      if (isLastLine) {
        this.buffer = this.buffer.slice(start);
        return { code, text: lines.join('\n') };
      }
    }
    return null;
  }

  assertCode(reply, expected, step) {
    if (!expected.includes(reply.code)) {
      const message = `SMTP ${step} failed (${reply.code}): ${reply.text}`;
      throw new EmailProviderError(
        reply.code >= 500
          ? EMAIL_PROVIDER_ERROR_CODES.PROVIDER_REJECTED
          : EMAIL_PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE,
        message
      );
    }
  }

  rejectAll(err) {
    while (this.pending.length > 0) {
      const { reject } = this.pending.shift();
      reject(err);
    }
  }

  mapError(err) {
    if (err instanceof EmailProviderError) {
      return err;
    }
    const code =
      err && isRetryableNetworkErrorCode(err.code)
        ? EMAIL_PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE
        : EMAIL_PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE;
    return new EmailProviderError(
      code,
      `SMTP connection error: ${err && err.message ? err.message : String(err)}`,
      { raw: err }
    );
  }

  destroy() {
    if (this.socket && !this.socket.destroyed) {
      this.socket.removeAllListeners();
      this.socket.destroy();
    }
    this.socket = null;
  }

  buildMessage({ from, to, subject, html, text }) {
    const boundary = `----taqwa-${crypto.randomUUID()}`;
    const messageId = `<${crypto.randomUUID()}@taqwa.local>`;
    const recipients = (Array.isArray(to) ? to : [to]).join(', ');
    const headers = [
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: ${messageId}`,
      `From: <${stripCrLf(from)}>`,
      `To: <${stripCrLf(recipients)}>`,
      `Subject: ${stripCrLf(subject)}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
    ];
    const parts = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      text || '',
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      html || '',
      `--${boundary}--`,
    ];
    return dotStuff([...headers, ...parts].join('\r\n'));
  }
}

module.exports = { SmtpClient };
