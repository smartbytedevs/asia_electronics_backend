'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const User = require('../../../src/modules/users/user.model');
const { ROLES, ACCOUNT_STATUSES } = require('../../../src/constants');

function validUserData() {
  return {
    authProviderId: 'auth-1',
    email: 'Amina@Example.COM',
    role: ROLES.CUSTOMER,
    status: ACCOUNT_STATUSES.ACTIVE,
    displayName: '  Amina Rahman  ',
    phone: '  +8801712345678 ',
  };
}

test('creates a valid user with normalized fields', async () => {
  const user = new User(validUserData());
  await user.validate();
  assert.equal(user.authProviderId, 'auth-1');
  assert.equal(user.email, 'amina@example.com', 'email is trimmed and lower-cased');
  assert.equal(user.displayName, 'Amina Rahman', 'displayName is trimmed');
  assert.equal(user.phone, '+8801712345678', 'phone is trimmed');
  assert.equal(user.role, ROLES.CUSTOMER);
  assert.equal(user.status, ACCOUNT_STATUSES.ACTIVE);
});

test('defaults role to CUSTOMER and status to ACTIVE', async () => {
  const user = new User({ authProviderId: 'auth-2' });
  await user.validate();
  assert.equal(user.role, ROLES.CUSTOMER);
  assert.equal(user.status, ACCOUNT_STATUSES.ACTIVE);
});

test('requires authProviderId', async () => {
  const user = new User({ email: 'a@b.c' });
  await assert.rejects(user.validate(), (err) => {
    assert.ok(err.errors && err.errors.authProviderId, 'authProviderId validation error');
    return true;
  });
});

test('rejects an unknown role', async () => {
  const user = new User({ ...validUserData(), role: 'SUPERUSER' });
  await assert.rejects(user.validate(), (err) => {
    assert.equal(err.errors.role.path, 'role');
    return true;
  });
});

test('rejects an unknown status', async () => {
  const user = new User({ ...validUserData(), status: 'BANNED' });
  await assert.rejects(user.validate(), (err) => {
    assert.equal(err.errors.status.path, 'status');
    return true;
  });
});

test('authProviderId is immutable', () => {
  const user = new User(validUserData());
  assert.equal(user.schema.path('authProviderId').options.immutable, true);
});

test('schema stores NO password, session, or token fields', () => {
  const paths = Object.keys(User.schema.paths);
  for (const forbidden of [
    'password',
    'passwordHash',
    'hash',
    'session',
    'sessions',
    'refreshToken',
    'refreshTokens',
    'authToken',
  ]) {
    assert.ok(!paths.includes(forbidden), `schema must not contain "${forbidden}"`);
  }
});

test('schema defines the required indexes', () => {
  const indexes = User.schema.indexes();
  const byName = {};
  for (const [fields, options] of indexes) {
    byName[Object.keys(fields)[0]] = options;
  }
  assert.equal(byName.authProviderId.unique, true, 'authProviderId is unique');
  assert.equal(byName.email.unique, true, 'email is unique when present');
  assert.equal(byName.email.sparse, true, 'email uniqueness is sparse');
});
