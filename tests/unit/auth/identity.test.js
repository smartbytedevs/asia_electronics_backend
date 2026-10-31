'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  mapAuthClaims,
  createAuthIdentityMapper,
} = require('../../../src/integrations/auth/identity');
const {
  JwtVerificationError,
  REASONS,
} = require('../../../src/integrations/auth/jwtVerifier');

function throwsReason(reason) {
  return (err) => {
    assert.ok(err instanceof JwtVerificationError, 'throws JwtVerificationError');
    assert.equal(err.reason, reason);
    return true;
  };
}

test('mapAuthClaims builds an authentication identity from trusted claims', () => {
  const identity = mapAuthClaims({
    sub: 'auth-1',
    email: 'a@b.c',
    name: 'Amina',
  });
  assert.deepEqual(identity, {
    authProviderId: 'auth-1',
    email: 'a@b.c',
    displayName: 'Amina',
  });
});

test('mapAuthClaims never copies the role claim (role lives in the User record)', () => {
  const identity = mapAuthClaims({
    sub: 'auth-1',
    role: 'ADMIN',
    email: 'a@b.c',
  });
  assert.ok(!('role' in identity), 'role claim is not part of the auth identity');
  assert.deepEqual(identity, { authProviderId: 'auth-1', email: 'a@b.c' });
});

test('mapAuthClaims drops untrusted and standard claims', () => {
  const identity = mapAuthClaims({
    sub: 'auth-1',
    iat: 123,
    exp: 456,
    nbf: 789,
    jti: 'token-id',
    isAdmin: true,
    phone: '+8801',
  });
  assert.deepEqual(identity, { authProviderId: 'auth-1' });
});

test('mapAuthClaims omits email and displayName when absent or non-string', () => {
  assert.deepEqual(mapAuthClaims({ sub: 'auth-1' }), { authProviderId: 'auth-1' });
  assert.deepEqual(mapAuthClaims({ sub: 'auth-1', email: 42, name: '' }), {
    authProviderId: 'auth-1',
  });
});

test('mapAuthClaims rejects a payload without a user id', () => {
  assert.throws(() => mapAuthClaims({ email: 'a@b.c' }), throwsReason(REASONS.CLAIM_INVALID));
  assert.throws(() => mapAuthClaims({ sub: '' }), throwsReason(REASONS.CLAIM_INVALID));
});

test('mapAuthClaims rejects a non-object payload', () => {
  assert.throws(() => mapAuthClaims(null), throwsReason(REASONS.MALFORMED));
  assert.throws(() => mapAuthClaims('payload'), throwsReason(REASONS.MALFORMED));
});

test('createAuthIdentityMapper supports custom claim names', () => {
  const map = createAuthIdentityMapper({
    idClaim: 'userId',
    emailClaim: 'mail',
    nameClaim: 'fullName',
  });
  assert.deepEqual(map({ userId: 'auth-9', mail: 'x@y.z', fullName: 'Sara' }), {
    authProviderId: 'auth-9',
    email: 'x@y.z',
    displayName: 'Sara',
  });
});
