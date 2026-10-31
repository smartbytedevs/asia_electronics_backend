'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SignJWT } = require('jose');

const {
  createJwtVerifier,
  JwtVerificationError,
  REASONS,
} = require('../../../src/integrations/auth/jwtVerifier');
const { createKeyPair, signToken } = require('../../../tests/helpers/jwt-fixtures');

const ISSUER = 'taqwa-frontend';
const AUDIENCE = 'taqwa-backend';
const ALGORITHMS = ['RS256'];

function isReason(reason) {
  return (err) => {
    assert.ok(err instanceof JwtVerificationError, 'throws JwtVerificationError');
    assert.equal(err.reason, reason);
    return true;
  };
}

test('verifier resolves a valid signed token to verified payload + header', async () => {
  const { privateKey, publicJwk } = await createKeyPair();
  const verify = createJwtVerifier({
    keys: [publicJwk],
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ALGORITHMS,
  });
  const token = await signToken({
    privateKey,
    claims: { role: 'CUSTOMER', email: 'a@b.c' },
  });

  const { payload, protectedHeader } = await verify(token);
  assert.equal(payload.sub, 'user-1');
  assert.equal(payload.role, 'CUSTOMER');
  assert.equal(payload.email, 'a@b.c');
  assert.equal(protectedHeader.alg, 'RS256');
});

test('verifier rejects a missing token', async () => {
  const { publicJwk } = await createKeyPair();
  const verify = createJwtVerifier({ keys: [publicJwk] });
  await assert.rejects(verify(undefined), isReason(REASONS.MALFORMED));
  await assert.rejects(verify(''), isReason(REASONS.MALFORMED));
});

test('verifier rejects a malformed token', async () => {
  const { publicJwk } = await createKeyPair();
  const verify = createJwtVerifier({ keys: [publicJwk] });
  await assert.rejects(verify('not.a.jwt'), isReason(REASONS.MALFORMED));
});

test('verifier rejects a token signed by a different key', async () => {
  const { publicJwk } = await createKeyPair();
  const { privateKey: otherPrivate } = await createKeyPair('other-key');
  const verify = createJwtVerifier({ keys: [publicJwk], algorithms: ALGORITHMS });
  const token = await signToken({ privateKey: otherPrivate });
  await assert.rejects(verify(token), isReason(REASONS.SIGNATURE_INVALID));
});

test('verifier rejects an expired token', async () => {
  const { privateKey, publicJwk } = await createKeyPair();
  const verify = createJwtVerifier({ keys: [publicJwk], algorithms: ALGORITHMS });
  const token = await signToken({
    privateKey,
    expiresIn: Math.floor(Date.now() / 1000) - 3600,
  });
  await assert.rejects(verify(token), isReason(REASONS.EXPIRED));
});

test('verifier rejects a token with the wrong issuer', async () => {
  const { privateKey, publicJwk } = await createKeyPair();
  const verify = createJwtVerifier({
    keys: [publicJwk],
    issuer: ISSUER,
    algorithms: ALGORITHMS,
  });
  const token = await signToken({ privateKey, issuer: 'evil-issuer' });
  await assert.rejects(verify(token), isReason(REASONS.CLAIM_INVALID));
});

test('verifier rejects a token with the wrong audience', async () => {
  const { privateKey, publicJwk } = await createKeyPair();
  const verify = createJwtVerifier({
    keys: [publicJwk],
    audience: AUDIENCE,
    algorithms: ALGORITHMS,
  });
  const token = await signToken({ privateKey, audience: 'other-app' });
  await assert.rejects(verify(token), isReason(REASONS.CLAIM_INVALID));
});

test('verifier rejects tokens using a disallowed algorithm', async () => {
  const { publicJwk } = await createKeyPair();
  const verify = createJwtVerifier({ keys: [publicJwk], algorithms: ALGORITHMS });
  const secret = new TextEncoder().encode('x'.repeat(32));
  const hsToken = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .sign(secret);
  await assert.rejects(verify(hsToken), isReason(REASONS.ALGORITHM_NOT_ALLOWED));
});

test('verifier rejects every token when no key set is configured', async () => {
  const verify = createJwtVerifier({});
  await assert.rejects(verify('anything.here.now'), isReason(REASONS.NOT_CONFIGURED));
});

test('verification failure messages never leak token material or claims', async () => {
  const { privateKey, publicJwk } = await createKeyPair();
  const verify = createJwtVerifier({
    keys: [publicJwk],
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ALGORITHMS,
  });
  const token = await signToken({ privateKey, issuer: 'evil-issuer' });

  let message = '';
  try {
    await verify(token);
  } catch (err) {
    message = err.message;
  }
  assert.doesNotMatch(message, /user-1|evil-issuer|taqwa-backend/);
});
