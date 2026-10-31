'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createProductRepository } = require('../../../src/modules/products/product.repository');

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

test('product repository exposes base + product operations', () => {
  const { model } = createStubModel();
  const repo = createProductRepository(model);
  for (const method of [
    'findById',
    'findOne',
    'findMany',
    'create',
    'updateById',
    'count',
    'findBySlug',
    'existsBySlug',
  ]) {
    assert.equal(typeof repo[method], 'function', `${method} should be a function`);
  }
});

test('findBySlug queries by slug only', async () => {
  const { model, calls } = createStubModel();
  const repo = createProductRepository(model);
  await repo.findBySlug('premium-abaya');
  const call = calls.find(([name]) => name === 'findOne');
  assert.deepEqual(call[1][0], { slug: 'premium-abaya' });
});

test('existsBySlug returns a boolean via model.exists', async () => {
  const { model, calls } = createStubModel();
  const repo = createProductRepository(model);
  assert.equal(await repo.existsBySlug('premium-abaya'), true);
  const call = calls.find(([name]) => name === 'exists');
  assert.deepEqual(call[1][0], { slug: 'premium-abaya' });
});

test('existsBySlug resolves false when no document matches', async () => {
  const { model } = createStubModel();
  model.exists = () => Promise.resolve(null);
  const repo = createProductRepository(model);
  assert.equal(await repo.existsBySlug('missing'), false);
});

test('create passes session options through for transactions', async () => {
  const { model, calls } = createStubModel();
  const repo = createProductRepository(model);
  const session = { id: 'session-1' };
  const data = { name: 'Premium Abaya', slug: 'premium-abaya' };
  const result = await repo.create(data, { session });
  assert.equal(result, 'created');
  const call = calls.find(([name]) => name === 'create');
  assert.deepEqual(call[1][0], [data], 'wraps the doc in an array so the session reaches save()');
  assert.deepEqual(call[1][1], { session });
});

test('findOne and findById pass session options through', async () => {
  const { model, calls } = createStubModel();
  const repo = createProductRepository(model);
  await repo.findBySlug('premium-abaya', { session: { id: 's' } });
  const call = calls.find(([name]) => name === 'findOne');
  assert.deepEqual(call[1][2], { session: { id: 's' } });
});
