'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createBaseRepository } = require('../src/modules/base/base.repository.js');

function createStubModel() {
  const calls = [];
  const model = {
    findById: (...args) => (calls.push(['findById', args]), Promise.resolve('doc')),
    findOne: (...args) => (calls.push(['findOne', args]), Promise.resolve('doc')),
    find: (...args) => (calls.push(['find', args]), Promise.resolve([])),
    create: (...args) => (calls.push(['create', args]), Promise.resolve('created')),
    findByIdAndUpdate: (...args) =>
      (calls.push(['findByIdAndUpdate', args]), Promise.resolve('updated')),
    findByIdAndDelete: (...args) =>
      (calls.push(['findByIdAndDelete', args]), Promise.resolve('deleted')),
    countDocuments: (...args) =>
      (calls.push(['countDocuments', args]), Promise.resolve(0)),
  };
  return { model, calls };
}

test('base repository exposes the standard persistence methods', () => {
  const { model } = createStubModel();
  const repo = createBaseRepository(model);
  for (const method of [
    'findById',
    'findOne',
    'findMany',
    'create',
    'updateById',
    'deleteById',
    'count',
  ]) {
    assert.equal(typeof repo[method], 'function', `${method} should be a function`);
  }
});

test('base repository delegates to the model without business logic', async () => {
  const { model, calls } = createStubModel();
  const repo = createBaseRepository(model);

  await repo.findById('a');
  await repo.findOne({ x: 1 });
  await repo.findMany({ x: 1 }, { lean: true });
  await repo.create({ name: 'x' });
  await repo.updateById('a', { $set: { name: 'y' } });
  await repo.deleteById('a');
  await repo.count({ x: 1 });

  assert.deepEqual(calls.map(([name]) => name), [
    'findById',
    'findOne',
    'find',
    'create',
    'findByIdAndUpdate',
    'findByIdAndDelete',
    'countDocuments',
  ]);

  const findManyCall = calls.find(([name]) => name === 'find');
  assert.equal(findManyCall[1][0].x, 1);
  assert.equal(findManyCall[1][2].lean, true);

  const updateCall = calls.find(([name]) => name === 'findByIdAndUpdate');
  assert.equal(updateCall[1][2].runValidators, true);
  assert.equal(updateCall[1][2].new, true);
});
