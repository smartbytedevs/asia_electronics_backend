'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCategoryRepository } = require('../../../src/modules/categories/category.repository');

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

test('category repository exposes base + category operations', () => {
  const { model } = createStubModel();
  const repo = createCategoryRepository(model);
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
  const repo = createCategoryRepository(model);
  await repo.findBySlug('abayas');
  const call = calls.find(([name]) => name === 'findOne');
  assert.ok(call, 'uses findOne');
  assert.deepEqual(call[1][0], { slug: 'abayas' });
});

test('existsBySlug returns a boolean via model.exists', async () => {
  const { model, calls } = createStubModel();
  const repo = createCategoryRepository(model);
  assert.equal(await repo.existsBySlug('abayas'), true);
  const call = calls.find(([name]) => name === 'exists');
  assert.deepEqual(call[1][0], { slug: 'abayas' });
});

test('existsBySlug resolves false when no document matches', async () => {
  const { model } = createStubModel();
  model.exists = () => Promise.resolve(null);
  const repo = createCategoryRepository(model);
  assert.equal(await repo.existsBySlug('missing'), false);
});

test('create delegates to the model without business logic', async () => {
  const { model, calls } = createStubModel();
  const repo = createCategoryRepository(model);
  const data = { name: 'Abayas', slug: 'abayas' };
  const result = await repo.create(data);
  assert.equal(result, 'created');
  const call = calls.find(([name]) => name === 'create');
  assert.deepEqual(call[1][0], [data], 'wraps the doc in an array so options reach save()');
  assert.deepEqual(call[1][1], {}, 'passes empty options through');
});

test('findMany passes filters and sort options through', async () => {
  const { model, calls } = createStubModel();
  const repo = createCategoryRepository(model);
  await repo.findMany({ isActive: true }, { sort: { sortOrder: 1 } });
  const call = calls.find(([name]) => name === 'find');
  assert.deepEqual(call[1][0], { isActive: true });
  assert.deepEqual(call[1][2], { sort: { sortOrder: 1 } });
});

test('updateById passes runValidators/new semantics via the base', async () => {
  const { model, calls } = createStubModel();
  const repo = createCategoryRepository(model);
  const result = await repo.updateById('507f1f77bcf86cd799439011', { name: 'X' });
  assert.equal(result, 'updated');
  const call = calls.find(([name]) => name === 'findByIdAndUpdate');
  assert.equal(call[1][1].name, 'X');
  assert.equal(call[1][2].new, true, 'returns the updated document');
  assert.equal(call[1][2].runValidators, true, 'validates the update');
});
