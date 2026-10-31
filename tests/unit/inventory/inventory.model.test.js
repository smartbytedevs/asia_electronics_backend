'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Inventory = require('../../../src/modules/inventory/inventory.model');

const PRODUCT_ID = '507f1f77bcf86cd799439010';
const VARIANT_ID = '507f1f77bcf86cd799439031';

function validInventoryData(overrides = {}) {
  return {
    productId: PRODUCT_ID,
    productVariantId: VARIANT_ID,
    onlineQuantity: 20,
    offlineQuantity: 5,
    reservedQuantity: 3,
    lowStockThreshold: 2,
    ...overrides,
  };
}

test('creates a valid variant inventory record', async () => {
  const inventory = new Inventory(validInventoryData());
  await inventory.validate();
  assert.equal(String(inventory.productId), PRODUCT_ID);
  assert.equal(String(inventory.productVariantId), VARIANT_ID);
  assert.equal(inventory.onlineQuantity, 20);
  assert.equal(inventory.offlineQuantity, 5);
  assert.equal(inventory.reservedQuantity, 3);
  assert.equal(inventory.lowStockThreshold, 2);
});

test('creates a valid Simple Product record (productVariantId null)', async () => {
  const inventory = new Inventory(validInventoryData({ productVariantId: null }));
  await inventory.validate();
  assert.equal(String(inventory.productId), PRODUCT_ID);
  assert.equal(inventory.productVariantId, null);
});

test('defaults all quantities to zero', async () => {
  const inventory = new Inventory({ productId: PRODUCT_ID });
  await inventory.validate();
  assert.equal(inventory.onlineQuantity, 0);
  assert.equal(inventory.offlineQuantity, 0);
  assert.equal(inventory.reservedQuantity, 0);
  assert.equal(inventory.lowStockThreshold, 0);
});

test('requires productId (productVariantId is optional)', async () => {
  const inventory = new Inventory({});
  await assert.rejects(inventory.validate(), (err) => {
    assert.ok(err.errors.productId, 'productId validation error');
    assert.equal(err.errors.productVariantId, undefined, 'productVariantId is nullable/optional');
    return true;
  });
});

test('rejects negative quantities', async () => {
  for (const field of ['onlineQuantity', 'offlineQuantity', 'reservedQuantity', 'lowStockThreshold']) {
    const inventory = new Inventory(validInventoryData({ [field]: -1 }));
    await assert.rejects(inventory.validate(), (err) => {
      assert.ok(err.errors[field], `${field} min validation error`);
      return true;
    });
  }
});

test('rejects non-integer quantities', async () => {
  const inventory = new Inventory(validInventoryData({ onlineQuantity: 5.5 }));
  await assert.rejects(inventory.validate(), (err) => {
    assert.ok(err.errors.onlineQuantity, 'onlineQuantity integer validation error');
    return true;
  });
});

test('zero quantities are valid (out-of-stock is representable)', async () => {
  const inventory = new Inventory(
    validInventoryData({ onlineQuantity: 0, offlineQuantity: 0, reservedQuantity: 0 })
  );
  await inventory.validate();
  assert.equal(inventory.onlineQuantity, 0);
});

test('declares the compound unique subject index and a low-stock index', () => {
  const indexes = Inventory.schema.indexes();
  const unique = indexes.find(
    ([key]) =>
      key.productId === 1 && key.productVariantId === 1 && key.outletId === 1
  );
  assert.ok(unique, 'compound { productId, productVariantId, outletId } index exists');
  assert.equal(unique[1].unique, true, 'subject index is unique');
  const lowStock = indexes.find(([key]) => key.onlineQuantity === 1);
  assert.ok(lowStock, 'onlineQuantity/lowStockThreshold index exists');
});
