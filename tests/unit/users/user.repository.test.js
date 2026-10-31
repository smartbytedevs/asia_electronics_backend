'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createUserRepository } = require('../../../src/modules/users/user.repository');

function createStubModel() {
  const calls = [];
  const model = {
    findById: (...args) => (calls.push(['findById', args]), Promise.resolve('doc')),
    findOne: (...args) => (calls.push(['findOne', args]), Promise.resolve('doc')),
    find: (...args) => (calls.push(['find', args]), Promise.resolve([])),
    create: (...args) => (calls.push(['create', args]), Promise.resolve(['created'])),
    findByIdAndUpdate: (...args) =>
      (calls.push(['findByIdAndUpdate', args]), Promise.resolve('updated')),
    findByIdAndDelete: (...args) =>
      (calls.push(['findByIdAndDelete', args]), Promise.resolve('deleted')),
    countDocuments: (...args) =>
      (calls.push(['countDocuments', args]), Promise.resolve(0)),
    exists: (...args) => (calls.push(['exists', args]), Promise.resolve({ _id: 'x' })),
  };
  return { model, calls };
}

test('user repository exposes user-specific lookup operations', () => {
  const { model } = createStubModel();
  const repo = createUserRepository(model);
  for (const method of [
    'findById',
    'findByAuthProviderId',
    'findByEmail',
    'create',
    'updateById',
    'existsByAuthProviderId',
  ]) {
    assert.equal(typeof repo[method], 'function', `${method} should be a function`);
  }
});

test('findByAuthProviderId queries by the auth provider id only', async () => {
  const { model, calls } = createStubModel();
  const repo = createUserRepository(model);
  await repo.findByAuthProviderId('auth-1');
  const call = calls.find(([name]) => name === 'findOne');
  assert.ok(call, 'uses findOne');
  assert.deepEqual(call[1][0], { authProviderId: 'auth-1' });
});

test('findByEmail queries by the normalized email', async () => {
  const { model, calls } = createStubModel();
  const repo = createUserRepository(model);
  await repo.findByEmail('amina@example.com');
  const call = calls.find(([name]) => name === 'findOne');
  assert.deepEqual(call[1][0], { email: 'amina@example.com' });
});

test('existsByAuthProviderId returns a boolean via model.exists', async () => {
  const { model, calls } = createStubModel();
  const repo = createUserRepository(model);
  const found = await repo.existsByAuthProviderId('auth-1');
  assert.equal(found, true);
  const call = calls.find(([name]) => name === 'exists');
  assert.deepEqual(call[1][0], { authProviderId: 'auth-1' });
});

test('existsByAuthProviderId resolves false when no document matches', async () => {
  const { model } = createStubModel();
  model.exists = () => Promise.resolve(null);
  const repo = createUserRepository(model);
  assert.equal(await repo.existsByAuthProviderId('auth-missing'), false);
});

test('create delegates to the model without business logic', async () => {
  const { model, calls } = createStubModel();
  const repo = createUserRepository(model);
  const data = { authProviderId: 'auth-1', role: 'CUSTOMER' };
  const result = await repo.create(data);
  assert.equal(result, 'created');
  const call = calls.find(([name]) => name === 'create');
  assert.deepEqual(call[1][0], [data], 'wraps the doc in an array so options reach save()');
  assert.deepEqual(call[1][1], {}, 'passes empty options through');
});

test('findById delegates to the base repository', async () => {
  const { model, calls } = createStubModel();
  const repo = createUserRepository(model);
  const result = await repo.findById('abc');
  assert.equal(result, 'doc');
  const call = calls.find(([name]) => name === 'findById');
  assert.equal(call[1][0], 'abc');
});
