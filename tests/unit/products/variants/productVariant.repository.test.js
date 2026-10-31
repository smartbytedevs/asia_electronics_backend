'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createVariantRepository } = require('../../../../src/modules/products/variants/productVariant.repository');

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
    exists: (...args) => (calls.push(['exists', args]), Promise.resolve({ _id: 'x' })),
  };
  return { model, calls };
}

const PRODUCT_ID = '507f1f77bcf86cd799439011';
const VARIANT_ID = '507f1f77bcf86cd799439031';

test('variant repository exposes base + variant operations', () => {
  const { model } = createStubModel();
  const repo = createVariantRepository(model);
  for (const method of [
    'findById',
    'findOne',
    'findMany',
    'create',
    'updateById',
    'count',
    'findBySku',
    'existsBySku',
    'findByProduct',
    'findOneByProduct',
    'findByProductAndId',
  ]) {
    assert.equal(typeof repo[method], 'function', `${method} should be a function`);
  }
});

test('existsBySku queries by sku and returns a boolean', async () => {
  const { model, calls } = createStubModel();
  const repo = createVariantRepository(model);
  assert.equal(await repo.existsBySku('ABAYA-52'), true);
  const call = calls.find(([name]) => name === 'exists');
  assert.deepEqual(call[1][0], { sku: 'ABAYA-52' });
});

test('existsBySku resolves false when no document matches', async () => {
  const { model } = createStubModel();
  model.exists = () => Promise.resolve(null);
  const repo = createVariantRepository(model);
  assert.equal(await repo.existsBySku('MISSING'), false);
});

test('findBySku queries by sku only', async () => {
  const { model, calls } = createStubModel();
  const repo = createVariantRepository(model);
  await repo.findBySku('ABAYA-52');
  const call = calls.find(([name]) => name === 'findOne');
  assert.deepEqual(call[1][0], { sku: 'ABAYA-52' });
});

test('findByProduct filters by productId only', async () => {
  const { model, calls } = createStubModel();
  const repo = createVariantRepository(model);
  await repo.findByProduct(PRODUCT_ID);
  const call = calls.find(([name]) => name === 'find');
  assert.deepEqual(call[1][0], { productId: PRODUCT_ID });
});

test('findOneByProduct merges productId with the extra filter', async () => {
  const { model, calls } = createStubModel();
  const repo = createVariantRepository(model);
  await repo.findOneByProduct(PRODUCT_ID, { attributeKey: 'x' });
  const call = calls.find(([name]) => name === 'findOne');
  assert.deepEqual(call[1][0], { productId: PRODUCT_ID, attributeKey: 'x' });
});

test('findByProductAndId scopes by both product and variant ids', async () => {
  const { model, calls } = createStubModel();
  const repo = createVariantRepository(model);
  await repo.findByProductAndId(PRODUCT_ID, VARIANT_ID);
  const call = calls.find(([name]) => name === 'findOne');
  assert.deepEqual(call[1][0], { productId: PRODUCT_ID, _id: VARIANT_ID });
});

test('create and updateById pass session options through for transactions', async () => {
  const { model, calls } = createStubModel();
  const repo = createVariantRepository(model);
  const session = { id: 'session-1' };
  await repo.create({ sku: 'X' }, { session });
  await repo.updateById(VARIANT_ID, { isActive: false }, { session });

  const createCall = calls.find(([name]) => name === 'create');
  assert.deepEqual(createCall[1][1], { session });

  const updateCall = calls.find(([name]) => name === 'findByIdAndUpdate');
  assert.equal(updateCall[1][2].new, true);
  assert.equal(updateCall[1][2].runValidators, true);
  assert.deepEqual(updateCall[1][2].session, session);
});
