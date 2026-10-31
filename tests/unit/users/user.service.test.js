'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { UserService } = require('../../../src/modules/users/user.service');
const { USER_MESSAGES } = require('../../../src/modules/users/user.constants');
const { ROLES, ACCOUNT_STATUSES } = require('../../../src/constants');

function userDoc(overrides = {}) {
  return {
    _id: '507f1f77bcf86cd799439011',
    authProviderId: 'auth-1',
    email: 'amina@example.com',
    displayName: 'Amina Rahman',
    phone: '+8801712345678',
    role: ROLES.CUSTOMER,
    status: ACCOUNT_STATUSES.ACTIVE,
    ...overrides,
  };
}

function createStubRepository({ user = null, created = null, onFindByAuthProviderId, onCreate } = {}) {
  const calls = [];
  return {
    calls,
    findById: async () => user,
    findByAuthProviderId: async (authProviderId) => {
      calls.push(['findByAuthProviderId', authProviderId]);
      return onFindByAuthProviderId ? onFindByAuthProviderId(authProviderId) : user;
    },
    create: async (data) => {
      calls.push(['create', data]);
      if (onCreate) return onCreate(data);
      return created;
    },
  };
}

test('resolveAuthenticatedUser returns the application identity for an existing user', async () => {
  const repository = createStubRepository({ user: userDoc() });
  const service = new UserService({ repository });
  const identity = await service.resolveAuthenticatedUser({
    authProviderId: 'auth-1',
    email: 'amina@example.com',
  });

  assert.equal(repository.calls[0][0], 'findByAuthProviderId');
  assert.equal(repository.calls[0][1], 'auth-1');
  assert.equal(identity.id, '507f1f77bcf86cd799439011');
  assert.equal(identity.role, ROLES.CUSTOMER);
  assert.equal(identity.status, ACCOUNT_STATUSES.ACTIVE);
});

test('existing user role comes from the application record, not the JWT', async () => {
  const repository = createStubRepository({
    user: userDoc({ role: ROLES.STAFF }),
  });
  const service = new UserService({ repository });
  const identity = await service.resolveAuthenticatedUser({
    authProviderId: 'auth-1',
    role: 'ADMIN',
  });
  assert.equal(identity.role, ROLES.STAFF);
});

test('resolveAuthenticatedUser provisions a CUSTOMER when the user is missing and auto-provisioning is on', async () => {
  const repository = createStubRepository({
    user: null,
    created: userDoc({ _id: 'new', role: ROLES.CUSTOMER, status: ACCOUNT_STATUSES.ACTIVE }),
  });
  const service = new UserService({ repository, autoProvisionCustomers: true });
  const identity = await service.resolveAuthenticatedUser({
    authProviderId: 'auth-new',
    email: 'new@example.com',
    displayName: 'New User',
  });

  const createCall = repository.calls.find(([name]) => name === 'create');
  assert.ok(createCall, 'provisions a new user');
  assert.deepEqual(createCall[1], {
    authProviderId: 'auth-new',
    role: ROLES.CUSTOMER,
    status: ACCOUNT_STATUSES.ACTIVE,
    email: 'new@example.com',
    displayName: 'New User',
  });
  assert.equal(identity.role, ROLES.CUSTOMER);
});

test('provisioning never assigns the role claimed in the JWT', async () => {
  const repository = createStubRepository({
    user: null,
    created: userDoc({ _id: 'new' }),
  });
  const service = new UserService({ repository });
  await service.resolveAuthenticatedUser({
    authProviderId: 'auth-new',
    role: 'ADMIN',
  });
  const createCall = repository.calls.find(([name]) => name === 'create');
  assert.equal(createCall[1].role, ROLES.CUSTOMER);
});

test('resolveAuthenticatedUser rejects with a controlled error when missing and auto-provisioning is off', async () => {
  const repository = createStubRepository({ user: null });
  const service = new UserService({ repository, autoProvisionCustomers: false });
  await assert.rejects(
    service.resolveAuthenticatedUser({ authProviderId: 'auth-missing' }),
    (err) => {
      assert.equal(err.statusCode, 403);
      assert.equal(err.message, USER_MESSAGES.ACCOUNT_NOT_FOUND);
      return true;
    }
  );
  const created = repository.calls.some(([name]) => name === 'create');
  assert.equal(created, false, 'no user is created when provisioning is disabled');
});

test('provisionCustomer ignores unsupported claims', async () => {
  const repository = createStubRepository({
    created: userDoc({ _id: 'new' }),
  });
  const service = new UserService({ repository });
  const created = await service.provisionCustomer({
    authProviderId: 'auth-new',
    phone: 'whatever',
    iat: 123,
  });
  const createCall = repository.calls.find(([name]) => name === 'create');
  assert.equal(createCall[1].phone, undefined);
  assert.equal(createCall[1].iat, undefined);
  assert.equal(created._id, 'new');
});

test('findById maps an existing user to the application identity and returns null otherwise', async () => {
  const repository = createStubRepository({ user: userDoc() });
  const service = new UserService({ repository });
  const identity = await service.findById('507f1f77bcf86cd799439011');
  assert.equal(identity.id, '507f1f77bcf86cd799439011');
  assert.equal(identity.role, ROLES.CUSTOMER);

  const emptyRepository = createStubRepository({ user: null });
  const emptyService = new UserService({ repository: emptyRepository });
  assert.equal(await emptyService.findById('missing'), null);
});

test('toSafeUser strips internal authProviderId and standard claims', () => {
  const service = new UserService({ repository: createStubRepository() });
  const identity = service.toApplicationIdentity(
    userDoc({ role: ROLES.ADMIN, status: ACCOUNT_STATUSES.ACTIVE })
  );
  const safe = service.toSafeUser(identity);
  assert.deepEqual(safe, {
    id: '507f1f77bcf86cd799439011',
    email: 'amina@example.com',
    displayName: 'Amina Rahman',
    phone: '+8801712345678',
    role: ROLES.ADMIN,
    status: ACCOUNT_STATUSES.ACTIVE,
  });
  assert.ok(!('authProviderId' in safe), 'authProviderId never appears in the safe representation');
});
