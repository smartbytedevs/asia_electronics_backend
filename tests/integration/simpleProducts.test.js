'use strict';

process.env.NODE_ENV = 'test';

/**
 * C1: Simple Products (no variants) end to end.
 *
 * Strategy A: a Simple Product owns ONE product-level Inventory record
 * (`productId`, `productVariantId: null`) and every cart/order/reservation line
 * carries `productVariantId: null`. A product-only line is NEVER silently
 * mapped to a variant: if the product has any ACTIVE variant the line is
 * rejected with `INVALID_CART_ITEM`.
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');

const { ERROR_CODES } = require('../../src/constants');
const {
  P1,
  P2,
  V1,
  product,
  variant,
  seedUsers,
  buildApp,
  withServer,
  request,
  checkoutBody,
  setupAuth,
  guestHeaders,
} = require('../helpers/order-integration-fixtures');

let tokens;

before(async () => {
  tokens = await setupAuth();
});

const BASE = '/api/v1/cart';
const ORDERS = '/api/v1/orders';

const P1_INVENTORY_ID = '507f1f77bcf86cd7994390a1';
const P2_INVENTORY_ID = '507f1f77bcf86cd7994390a3';

const CUSTOMER_ID = '507f1f77bcf86cd799439111';

/**
 * P1 keeps its ACTIVE variant V1. P2 is a Simple Product because no variant
 * belongs to it in this fixture set. Both stock subjects exist side by side:
 * a variant-keyed record for P1/V1 and a product-keyed record for P2.
 */
function simpleProductsApp() {
  return buildApp({
    users: seedUsers(),
    products: [product(P1), product(P2)],
    variants: [variant(V1)],
    inventory: [
      {
        _id: P1_INVENTORY_ID,
        productId: P1,
        productVariantId: V1,
        onlineQuantity: 20,
        offlineQuantity: 5,
        reservedQuantity: 0,
        lowStockThreshold: 2,
      },
      {
        _id: P2_INVENTORY_ID,
        productId: P2,
        productVariantId: null,
        onlineQuantity: 10,
        offlineQuantity: 0,
        reservedQuantity: 0,
        lowStockThreshold: 2,
      },
    ],
  });
}

function inventoryFor(repos, productId) {
  return repos.invRepo.docs.find((doc) => String(doc.productId) === String(productId));
}

function checkoutHeaders(key) {
  return { 'Idempotency-Key': key };
}

async function addToCart(baseUrl, token, item) {
  return request('POST', `${baseUrl}${BASE}/items`, token, item);
}

test('a simple product can be added to the cart and listed without a variant', withServer(
  () => simpleProductsApp(),
  async (baseUrl, repos) => {
    const added = await addToCart(baseUrl, tokens.tokenCustomer, {
      productId: P2,
      quantity: 2,
    });
    assert.equal(added.status, 200);
    const addedCart = (await added.json()).data.cart;
    assert.equal(addedCart.items.length, 1);

    const item = addedCart.items[0];
    assert.equal(item.productVariantId, null, 'simple lines carry no variant id');
    assert.equal(item.productId, P2);
    assert.equal(item.variant, null);
    assert.equal(item.product.name, 'Kurta');
    assert.equal(item.priceMinorUnits, 90000, '10% product discount applied server-side');
    assert.equal(item.availableOnlineQuantity, 10, 'product-level inventory is used');
    assert.equal(item.isAvailable, true);

    const listed = await request('GET', `${baseUrl}${BASE}`, tokens.tokenCustomer);
    assert.equal(listed.status, 200);
    const listedCart = (await listed.json()).data.cart;
    assert.equal(listedCart.items.length, 1);
    assert.equal(listedCart.itemCount, 2);
    assert.equal(listedCart.itemsSubtotalMinorUnits, 180000);

    assert.equal(repos.cartRepo.docs[0].items[0].productVariantId, null);
    assert.equal(repos.cartRepo.docs[0].items[0].productId, P2);
  }
));

test('a product-only cart line is rejected when the product has active variants', withServer(
  () => simpleProductsApp(),
  async (baseUrl, repos) => {
    const res = await addToCart(baseUrl, tokens.tokenCustomer, {
      productId: P1,
      quantity: 1,
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, ERROR_CODES.INVALID_CART_ITEM);
    assert.match(body.message, /requires a variant selection/);
    assert.equal(repos.cartRepo.docs.length, 0, 'nothing was written to the cart');
  }
));

test('checkout rejects a seeded product-only line when the product has active variants', withServer(
  () => simpleProductsApp(),
  async (baseUrl, repos) => {
    // Bypass the cart API to prove checkout enforces the same rule defensively.
    await repos.cartRepo.create({
      customerId: CUSTOMER_ID,
      items: [{ productId: P1, productVariantId: null, quantity: 1 }],
      isCheckedOut: false,
    });

    const res = await request(
      'POST',
      `${baseUrl}${ORDERS}/checkout`,
      tokens.tokenCustomer,
      checkoutBody(),
      checkoutHeaders('simple-guard')
    );
    assert.equal(res.status, 404, 'checkout surfaces the unavailable-line error');
    assert.equal((await res.json()).error.code, ERROR_CODES.INVALID_CART_ITEM);
    assert.equal(repos.orderRepo.docs.length, 0, 'no order created');
    assert.equal(repos.resRepo.docs.length, 0, 'no reservation leaked');
    assert.equal(inventoryFor(repos, P1).reservedQuantity, 0);
  }
));

test('simple-product checkout reserves product-level stock and snapshots a null variant', withServer(
  () => simpleProductsApp(),
  async (baseUrl, repos) => {
    await addToCart(baseUrl, tokens.tokenCustomer, { productId: P2, quantity: 2 });

    const res = await request(
      'POST',
      `${baseUrl}${ORDERS}/checkout`,
      tokens.tokenCustomer,
      checkoutBody(),
      checkoutHeaders('simple-checkout')
    );
    assert.equal(res.status, 201);
    const order = (await res.json()).data.order;

    assert.equal(order.items.length, 1);
    assert.equal(order.items[0].productId, P2);
    assert.equal(order.items[0].productVariantId, null);
    assert.equal(order.items[0].productName, 'Kurta');
    assert.equal(order.items[0].sku, null, 'optional SKU stays null-safe');
    assert.equal(order.items[0].unitPriceMinorUnits, 90000);
    assert.equal(order.items[0].quantity, 2);

    assert.equal(order.totals.itemsSubtotalMinorUnits, 180000);
    assert.equal(order.totals.totalDiscountMinorUnits, 20000);
    assert.equal(order.totals.deliveryFeeMinorUnits, 8000);
    assert.equal(order.totals.grandTotalMinorUnits, 168000);

    assert.equal(repos.resRepo.docs.length, 1);
    assert.equal(repos.resRepo.docs[0].productId, P2);
    assert.equal(repos.resRepo.docs[0].productVariantId, null);
    assert.equal(repos.resRepo.docs[0].quantity, 2);
    assert.equal(repos.resRepo.docs[0].status, 'ACTIVE');

    assert.equal(inventoryFor(repos, P2).reservedQuantity, 2);
    assert.equal(inventoryFor(repos, P1).reservedQuantity, 0, 'variant stock untouched');

    assert.equal(repos.cartRepo.docs[0].isCheckedOut, true);
    assert.equal(repos.cartRepo.docs[0].items.length, 0);
  }
));

test('a mixed cart reserves simple and variant stock independently', withServer(
  () => simpleProductsApp(),
  async (baseUrl, repos) => {
    await addToCart(baseUrl, tokens.tokenCustomer, { productId: P2, quantity: 2 });
    await addToCart(baseUrl, tokens.tokenCustomer, { productVariantId: V1, quantity: 1 });

    const res = await request(
      'POST',
      `${baseUrl}${ORDERS}/checkout`,
      tokens.tokenCustomer,
      checkoutBody(),
      checkoutHeaders('mixed-checkout')
    );
    assert.equal(res.status, 201);
    const order = (await res.json()).data.order;

    assert.equal(order.items.length, 2);
    const simpleItem = order.items.find((item) => item.productId === P2);
    const variantItem = order.items.find((item) => item.productId === P1);
    assert.equal(simpleItem.productVariantId, null);
    assert.equal(variantItem.productVariantId, V1);

    assert.equal(order.totals.itemsSubtotalMinorUnits, 280000);
    assert.equal(order.totals.totalDiscountMinorUnits, 20000);
    assert.equal(order.totals.grandTotalMinorUnits, 268000);

    assert.equal(repos.resRepo.docs.length, 2, 'one reservation per line');
    const simpleReservation = repos.resRepo.docs.find((doc) => doc.productId === P2);
    const variantReservation = repos.resRepo.docs.find(
      (doc) => String(doc.productVariantId) === V1
    );
    assert.equal(simpleReservation.productVariantId, null);
    assert.equal(simpleReservation.quantity, 2);
    assert.equal(variantReservation.quantity, 1);

    assert.equal(inventoryFor(repos, P2).reservedQuantity, 2);
    assert.equal(inventoryFor(repos, P1).reservedQuantity, 1);
  }
));

test('cancelling a simple-product order releases product-level stock', withServer(
  () => simpleProductsApp(),
  async (baseUrl, repos) => {
    await addToCart(baseUrl, tokens.tokenCustomer, { productId: P2, quantity: 3 });
    const created = await request(
      'POST',
      `${baseUrl}${ORDERS}/checkout`,
      tokens.tokenCustomer,
      checkoutBody(),
      checkoutHeaders('simple-cancel')
    );
    assert.equal(created.status, 201);
    const { order } = (await created.json()).data;
    assert.equal(inventoryFor(repos, P2).reservedQuantity, 3);

    const cancelled = await request(
      'POST',
      `${baseUrl}${ORDERS}/${order.id}/cancel`,
      tokens.tokenCustomer,
      {}
    );
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).data.order.status, 'CANCELLED');
    assert.equal(repos.resRepo.docs[0].status, 'RELEASED');
    assert.equal(inventoryFor(repos, P2).reservedQuantity, 0);
    assert.equal(inventoryFor(repos, P2).onlineQuantity, 10, 'release never changes physical stock');
  }
));

test('checkout with insufficient simple-product stock reserves nothing', withServer(
  () => simpleProductsApp(),
  async (baseUrl, repos) => {
    await addToCart(baseUrl, tokens.tokenCustomer, { productId: P2, quantity: 11 });

    const res = await request(
      'POST',
      `${baseUrl}${ORDERS}/checkout`,
      tokens.tokenCustomer,
      checkoutBody(),
      checkoutHeaders('simple-short-stock')
    );
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, ERROR_CODES.INSUFFICIENT_AVAILABLE_STOCK);

    assert.equal(repos.orderRepo.docs.length, 0);
    assert.equal(repos.resRepo.docs.length, 0);
    assert.equal(inventoryFor(repos, P2).reservedQuantity, 0);
    assert.equal(repos.cartRepo.docs[0].isCheckedOut, false, 'cart survives a failed checkout');
    assert.equal(repos.cartRepo.docs[0].items.length, 1);
  }
));

test('guest carts can hold simple products and stay isolated', withServer(
  () => simpleProductsApp(),
  async (baseUrl) => {
    const guestA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const guestB = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

    const added = await request(
      'POST',
      `${baseUrl}${BASE}/items`,
      null,
      { productId: P2, quantity: 1 },
      guestHeaders(guestA)
    );
    assert.equal(added.status, 200);
    const addedCart = (await added.json()).data.cart;
    assert.equal(addedCart.items[0].productVariantId, null);
    assert.equal(addedCart.items[0].availableOnlineQuantity, 10);

    const guestACart = await request(
      'GET',
      `${baseUrl}${BASE}`,
      null,
      undefined,
      guestHeaders(guestA)
    );
    assert.equal(guestACart.status, 200);
    assert.equal((await guestACart.json()).data.cart.itemCount, 1);

    const guestBCart = await request(
      'GET',
      `${baseUrl}${BASE}`,
      null,
      undefined,
      guestHeaders(guestB)
    );
    assert.equal(guestBCart.status, 200);
    assert.equal((await guestBCart.json()).data.cart.items.length, 0, 'no guest leakage');
  }
));
