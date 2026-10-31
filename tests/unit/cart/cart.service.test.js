'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { CartService } = require('../../../src/modules/cart/cart.service');
const { ERROR_CODES } = require('../../../src/constants');
const { CART_LIMITS } = require('../../../src/modules/cart/cart.constants');
const {
  createMemoryVariantRepository,
  createMemoryInventoryRepository,
} = require('../../helpers/inventory-stubs');
const {
  createMemoryCartRepository,
  createMemoryProductRepository,
} = require('../../helpers/order-stubs');

const CUSTOMER_ID = '507f1f77bcf86cd799439011';

const P1 = '507f1f77bcf86cd799439031';
const V1 = '507f1f77bcf86cd799439041';
const V2 = '507f1f77bcf86cd799439042';

function product(id, overrides = {}) {
  return {
    _id: id,
    name: 'Abaya',
    slug: 'abaya',
    sellingPrice: 100000,
    discount: null,
    isActive: true,
    ...overrides,
  };
}

function variant(id, overrides = {}) {
  return {
    _id: id,
    productId: P1,
    sku: 'ABAYA-52',
    attributes: { size: '52' },
    isActive: true,
    ...overrides,
  };
}

function buildContext({ products, variants, inventory } = {}) {
  const cartRepo = createMemoryCartRepository();
  const productRepo = createMemoryProductRepository(products || [product(P1)]);
  const variantRepo = createMemoryVariantRepository(variants || [variant(V1)]);
  const invRepo = createMemoryInventoryRepository(
    inventory || [
      { _id: '507f1f77bcf86cd7994390a1', productVariantId: V1, onlineQuantity: 20, offlineQuantity: 0, reservedQuantity: 0, lowStockThreshold: 0 },
    ]
  );
  const service = new CartService({
    cartRepository: cartRepo,
    productRepository: productRepo,
    variantRepository: variantRepo,
    inventoryRepository: invRepo,
  });
  return { service, cartRepo, productRepo, variantRepo, invRepo };
}

test('getCart auto-creates an empty cart and serializes it', async () => {
  const ctx = buildContext();
  const cart = await ctx.service.getCart(CUSTOMER_ID);
  assert.equal(cart.items.length, 0);
  assert.equal(cart.itemCount, 0);
  assert.equal(cart.itemsSubtotalMinorUnits, 0);
  assert.equal(cart.customerId, CUSTOMER_ID);
  assert.equal(ctx.cartRepo.docs.length, 1, 'cart is created on demand');
});

test('addItem appends a new line and enriches it with live pricing', async () => {
  const ctx = buildContext();
  const cart = await ctx.service.addItem({
    customerId: CUSTOMER_ID,
    productVariantId: V1,
    quantity: 2,
  });
  assert.equal(cart.items.length, 1);
  assert.equal(cart.items[0].quantity, 2);
  assert.equal(cart.items[0].priceMinorUnits, 100000);
  assert.equal(cart.items[0].availableOnlineQuantity, 20);
  assert.equal(cart.items[0].isAvailable, true);
  assert.equal(cart.itemCount, 2);
  assert.equal(cart.itemsSubtotalMinorUnits, 200000);
});

test('addItem bumps quantity for an existing variant instead of duplicating', async () => {
  const ctx = buildContext();
  await ctx.service.addItem({ customerId: CUSTOMER_ID, productVariantId: V1, quantity: 1 });
  const cart = await ctx.service.addItem({ customerId: CUSTOMER_ID, productVariantId: V1, quantity: 3 });
  assert.equal(cart.items.length, 1);
  assert.equal(cart.items[0].quantity, 4);
});

test('addItem rejects inactive or unknown variants/products', async () => {
  const inactive = buildContext({ variants: [variant(V1, { isActive: false })] });
  await assert.rejects(
    inactive.service.addItem({ customerId: CUSTOMER_ID, productVariantId: V1, quantity: 1 }),
    (err) => err.statusCode === 404 && err.code === ERROR_CODES.INVALID_CART_ITEM
  );

  const unknown = buildContext();
  await assert.rejects(
    unknown.service.addItem({ customerId: CUSTOMER_ID, productVariantId: '507f1f77bcf86cd799439999', quantity: 1 }),
    (err) => err.statusCode === 404 && err.code === ERROR_CODES.INVALID_CART_ITEM
  );
});

test('addItem enforces the per-line quantity limit when bumping', async () => {
  const ctx = buildContext();
  await ctx.service.addItem({ customerId: CUSTOMER_ID, productVariantId: V1, quantity: CART_LIMITS.QUANTITY_MAX });
  await assert.rejects(
    ctx.service.addItem({ customerId: CUSTOMER_ID, productVariantId: V1, quantity: 1 }),
    (err) => err.statusCode === 400 && err.code === ERROR_CODES.INVALID_CART_ITEM,
    'bumping beyond the per-line max is rejected'
  );
});

test('updateItem changes the quantity and removeItem deletes the line', async () => {
  const ctx = buildContext();
  let cart = await ctx.service.addItem({ customerId: CUSTOMER_ID, productVariantId: V1, quantity: 2 });
  const itemId = cart.items[0].id;

  cart = await ctx.service.updateItem({ customerId: CUSTOMER_ID, itemId, quantity: 5 });
  assert.equal(cart.items[0].quantity, 5);

  cart = await ctx.service.removeItem({ customerId: CUSTOMER_ID, itemId });
  assert.equal(cart.items.length, 0);
});

test('update/remove of an item in another cart or unknown → 404', async () => {
  const ctx = buildContext();
  const cart = await ctx.service.addItem({ customerId: CUSTOMER_ID, productVariantId: V1, quantity: 1 });
  const itemId = cart.items[0].id;

  await assert.rejects(
    ctx.service.updateItem({ customerId: CUSTOMER_ID, itemId: '507f1f77bcf86cd799439999', quantity: 2 }),
    (err) => err.statusCode === 404 && err.code === ERROR_CODES.INVALID_CART_ITEM
  );
  await assert.rejects(
    ctx.service.removeItem({ customerId: CUSTOMER_ID, itemId: '507f1f77bcf86cd799439999' }),
    (err) => err.statusCode === 404 && err.code === ERROR_CODES.INVALID_CART_ITEM
  );
});

test('clearCart is idempotent and works on a missing cart', async () => {
  const ctx = buildContext();
  await ctx.service.addItem({ customerId: CUSTOMER_ID, productVariantId: V1, quantity: 1 });
  const cleared = await ctx.service.clearCart(CUSTOMER_ID);
  assert.equal(cleared.items.length, 0);

  const fresh = buildContext();
  const empty = await fresh.service.clearCart('507f1f77bcf86cd799439022');
  assert.equal(empty.items.length, 0);
});

test('customer scoping: operations are isolated per customer', async () => {
  const ctx = buildContext();
  const other = '507f1f77bcf86cd799439022';
  const cart = await ctx.service.addItem({ customerId: CUSTOMER_ID, productVariantId: V1, quantity: 2 });

  const otherCart = await ctx.service.getCart(other);
  assert.equal(otherCart.items.length, 0, 'another customer never sees these items');

  await assert.rejects(
    ctx.service.updateItem({ customerId: other, itemId: cart.items[0].id, quantity: 9 }),
    (err) => err.statusCode === 404 && err.code === ERROR_CODES.INVALID_CART_ITEM,
    'another customer cannot mutate an item that is not in their cart'
  );
});

test('a multi-size variant REQUIRES a selectedSize', async () => {
  const ctx = buildContext({ variants: [variant(V1, { attributes: { size: 'S, M, L' } })] });
  await assert.rejects(
    ctx.service.addItem({ customerId: CUSTOMER_ID, productVariantId: V1, quantity: 1 }),
    (err) => err.statusCode === 400 && err.code === ERROR_CODES.INVALID_CART_ITEM,
    'adding a multi-size variant without a size is rejected'
  );
});

test('addItem persists and serializes the selectedSize on the line', async () => {
  const ctx = buildContext({ variants: [variant(V1, { attributes: { size: 'S, M, L' } })] });
  const cart = await ctx.service.addItem({
    customerId: CUSTOMER_ID,
    productVariantId: V1,
    quantity: 2,
    selectedSize: 'S',
  });
  assert.equal(cart.items.length, 1);
  assert.equal(cart.items[0].selectedSize, 'S');
  assert.equal(cart.items[0].quantity, 2);
});

test('same variant with DIFFERENT selectedSize creates separate lines', async () => {
  const ctx = buildContext({ variants: [variant(V1, { attributes: { size: 'S, M, L' } })] });
  let cart = await ctx.service.addItem({ customerId: CUSTOMER_ID, productVariantId: V1, quantity: 1, selectedSize: 'S' });
  cart = await ctx.service.addItem({ customerId: CUSTOMER_ID, productVariantId: V1, quantity: 1, selectedSize: 'M' });
  assert.equal(cart.items.length, 2, 'S and M must not merge');
  assert.deepEqual(cart.items.map((i) => i.selectedSize), ['S', 'M']);

  cart = await ctx.service.addItem({ customerId: CUSTOMER_ID, productVariantId: V1, quantity: 2, selectedSize: 'S' });
  assert.equal(cart.items.length, 2, 're-adding the same size bumps, not duplicates');
  assert.equal(cart.items[0].quantity, 3);
});

test('selectedSize must be one of the variant size tokens', async () => {
  const ctx = buildContext({ variants: [variant(V1, { attributes: { size: 'S, M' } })] });
  await assert.rejects(
    ctx.service.addItem({ customerId: CUSTOMER_ID, productVariantId: V1, quantity: 1, selectedSize: 'XL' }),
    (err) => err.statusCode === 400 && err.code === ERROR_CODES.INVALID_CART_ITEM
  );
});

test('a variant with no size attribute rejects a selectedSize', async () => {
  const ctx = buildContext({ variants: [variant(V1, { attributes: { color: 'Charcoal' } })] });
  await assert.rejects(
    ctx.service.addItem({ customerId: CUSTOMER_ID, productVariantId: V1, quantity: 1, selectedSize: 'S' }),
    (err) => err.statusCode === 400 && err.code === ERROR_CODES.INVALID_CART_ITEM
  );
});

test('single-size and no-size variants still add WITHOUT a selectedSize', async () => {
  const single = buildContext({ variants: [variant(V1, { attributes: { size: '52' } })] });
  let cart = await single.service.addItem({ customerId: CUSTOMER_ID, productVariantId: V1, quantity: 1 });
  assert.equal(cart.items.length, 1);
  assert.equal(cart.items[0].selectedSize, null, 'no size chosen when the variant has a single size');

  const none = buildContext({ variants: [variant(V1, { attributes: { color: 'Charcoal' } })] });
  cart = await none.service.addItem({ customerId: CUSTOMER_ID, productVariantId: V1, quantity: 1 });
  assert.equal(cart.items.length, 1);
});
