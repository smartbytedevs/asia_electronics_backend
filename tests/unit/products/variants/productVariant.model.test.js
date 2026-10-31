'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ProductVariant = require('../../../../src/modules/products/variants/productVariant.model');
const { PRODUCT_LIMITS } = require('../../../../src/modules/products/variants/productVariant.constants');

const PRODUCT_ID = '507f1f77bcf86cd799439011';

function validVariantData(overrides = {}) {
  return {
    productId: PRODUCT_ID,
    sku: 'ABAYA-52',
    attributes: { size: '52' },
    attributeKey: '[["size","52"]]',
    isActive: true,
    ...overrides,
  };
}

test('creates a valid variant', async () => {
  const variant = new ProductVariant(validVariantData());
  await variant.validate();
  assert.equal(variant.productId.toString(), PRODUCT_ID);
  assert.equal(variant.sku, 'ABAYA-52');
  assert.deepEqual(variant.attributes, { size: '52' });
  assert.equal(variant.isActive, true);
});

test('sku is trimmed and uppercased at the schema level', async () => {
  const variant = new ProductVariant(
    validVariantData({ sku: '  abaya-52  ' })
  );
  await variant.validate();
  assert.equal(variant.sku, 'ABAYA-52');
});

test('requires productId, sku, and attributeKey', async () => {
  for (const missing of ['productId', 'sku', 'attributeKey']) {
    const data = validVariantData();
    delete data[missing];
    const variant = new ProductVariant(data);
    await assert.rejects(variant.validate(), (err) => {
      assert.ok(err.errors[missing], `${missing} validation error`);
      return true;
    });
  }
});

test('rejects an empty sku', async () => {
  const variant = new ProductVariant(validVariantData({ sku: '   ' }));
  await assert.rejects(variant.validate(), (err) => {
    assert.ok(err.errors.sku, 'sku required error');
    return true;
  });
});

test('rejects a sku above the length limit', async () => {
  const variant = new ProductVariant(
    validVariantData({ sku: 'a'.repeat(PRODUCT_LIMITS.SKU_MAX + 1) })
  );
  await assert.rejects(variant.validate(), (err) => {
    assert.ok(err.errors.sku, 'sku maxlength error');
    return true;
  });
});

test('defaults attributes to {} and isActive to true', async () => {
  const variant = new ProductVariant({
    productId: PRODUCT_ID,
    sku: 'ABAYA-DEFAULT',
    attributeKey: '[]',
  });
  await variant.validate();
  assert.deepEqual(variant.attributes, {});
  assert.equal(variant.isActive, true);
});

test('rejects price overrides outside the allowed range', async () => {
  const variant = new ProductVariant(
    validVariantData({ sellingPriceOverride: 0 })
  );
  await assert.rejects(variant.validate(), (err) => {
    assert.ok(err.errors.sellingPriceOverride, 'sellingPriceOverride min error');
    return true;
  });
});

test('schema enables timestamps', () => {
  assert.equal(ProductVariant.schema.options.timestamps, true);
});

test('schema has the uniqueness indexes: sku and productId+attributeKey', () => {
  const indexes = ProductVariant.schema.indexes();
  const byFields = indexes.map(([fields]) => Object.keys(fields).join('+'));

  const skuIndex = indexes.find(([fields]) => Object.keys(fields).join('+') === 'sku');
  assert.ok(skuIndex, 'sku index exists');
  assert.equal(skuIndex[1].unique, true, 'SKU is globally unique');

  const dupIndex = indexes.find(
    ([fields]) => Object.keys(fields).join('+') === 'productId+attributeKey'
  );
  assert.ok(dupIndex, 'productId+attributeKey index exists');
  assert.equal(dupIndex[1].unique, true, 'no duplicate variant attributes per product');

  assert.ok(byFields.includes('productId+isActive'), 'variant listing index exists');
});

test('schema stores NO inventory or stock fields', () => {
  const paths = Object.keys(ProductVariant.schema.paths);
  for (const forbidden of [
    'stock',
    'availableStock',
    'reservedStock',
    'inventory',
    'quantity',
    'price',
  ]) {
    assert.ok(!paths.includes(forbidden), `variant schema must not contain "${forbidden}"`);
  }
});
