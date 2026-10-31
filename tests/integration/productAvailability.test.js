'use strict';

process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createProductRouter } = require('../../src/modules/products/product.routes');
const { ProductService } = require('../../src/modules/products/product.service');
const { createVariantService, buildAttributeKey } = require('../../src/modules/products/variants/productVariant.service');
const { UserService } = require('../../src/modules/users/user.service');
const { ROLES, ACCOUNT_STATUSES, ERROR_CODES } = require('../../src/constants');
const notFound = require('../../src/middlewares/notFound');
const errorHandler = require('../../src/middlewares/errorHandler');
const { createJwtVerifier } = require('../../src/integrations/auth/jwtVerifier');
const { createKeyPair, signToken } = require('../../tests/helpers/jwt-fixtures');

const ISSUER = 'taqwa-frontend';
const AUDIENCE = 'taqwa-backend';
const ALGORITHMS = ['RS256'];

const CATEGORY_ID = '507f1f77bcf86cd799439020';

const MESSAGES = {
  AVAILABILITY_FETCHED: 'Product availability retrieved successfully',
  PRODUCT_NOT_FOUND: 'Product not found',
};

let nextHex = 0;
function freshHexId() {
  nextHex += 1;
  return `507f1f77bcf86cd79943${String(9000 + nextHex)}`;
}

function userDoc(overrides = {}) {
  return {
    _id: `usr-${overrides.authProviderId || 'x'}`,
    authProviderId: 'auth-customer-1',
    email: 'amina@example.com',
    displayName: 'Amina Rahman',
    phone: '+8801712345678',
    role: ROLES.CUSTOMER,
    status: ACCOUNT_STATUSES.ACTIVE,
    ...overrides,
  };
}

function productDoc(overrides = {}) {
  return {
    _id: freshHexId(),
    name: 'Premium Abaya',
    slug: 'premium-abaya',
    description: '',
    categoryId: CATEGORY_ID,
    images: [],
    sellingPrice: 150000,
    purchasePrice: null,
    discount: null,
    featured: false,
    newArrival: false,
    bestDeal: false,
    isActive: true,
    measurementGuide: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function variantDoc(overrides = {}) {
  const base = {
    _id: freshHexId(),
    productId: 'prod-x',
    sku: 'ABAYA-52',
    attributes: { size: '52' },
    sellingPriceOverride: null,
    purchasePriceOverride: null,
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
  const doc = { ...base, ...overrides };
  doc.attributeKey = buildAttributeKey(doc.attributes);
  return doc;
}

function inventoryDoc(overrides = {}) {
  return {
    _id: freshHexId(),
    productVariantId: 'var-x',
    outletId: null,
    onlineQuantity: 0,
    offlineQuantity: 0,
    reservedQuantity: 0,
    lowStockThreshold: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function applySort(docs, sort = {}) {
  return [...docs].sort((a, b) => {
    for (const [field, dir] of Object.entries(sort)) {
      const av = a[field] === undefined ? 0 : a[field];
      const bv = b[field] === undefined ? 0 : b[field];
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      if (cmp !== 0) return dir === -1 ? -cmp : cmp;
    }
    return 0;
  });
}

function createMemoryProductRepository(initial = []) {
  const docs = [...initial];
  return {
    docs,
    findById: async (id) => docs.find((d) => String(d._id) === String(id)) || null,
    findOne: async (filter) => docs.find((d) => Object.keys(filter).every((k) => d[k] === filter[k])) || null,
    findMany: async (filter, options = {}) => {
      let result = docs.filter((d) => Object.keys(filter).every((k) => d[k] === filter[k]));
      result = applySort(result, options.sort);
      if (options.skip) result = result.slice(options.skip);
      if (options.limit) result = result.slice(0, options.limit);
      return result;
    },
    create: async () => ({ _id: freshHexId() }),
    updateById: async () => null,
    count: async () => 0,
    findBySlug: async () => null,
    existsBySlug: async () => false,
  };
}

function createMemoryVariantRepository(initial = []) {
  const docs = [...initial];
  return {
    docs,
    findById: async (id) => docs.find((d) => String(d._id) === String(id)) || null,
    findOne: async (filter) => docs.find((d) => Object.keys(filter).every((k) => d[k] === filter[k])) || null,
    findMany: async (filter, options = {}) => {
      let result = docs.filter((d) => Object.keys(filter).every((k) => d[k] === filter[k]));
      return applySort(result, options.sort);
    },
    create: async () => ({ _id: freshHexId() }),
    updateById: async () => null,
    existsBySku: async () => false,
    findOneByProduct: async () => null,
    findByProductAndId: async () => null,
  };
}

function createMemoryInventoryRepository(initial = []) {
  const docs = [...initial];
  return {
    docs,
    findByProductVariantId: async (variantId) =>
      docs.find((d) => String(d.productVariantId) === String(variantId)) || null,
    findByProductId: async (productId) =>
      docs.find((d) => String(d.productId) === String(productId) && d.productVariantId == null) || null,
  };
}

function createStubUserRepository(users) {
  return {
    findByAuthProviderId: async (authProviderId) =>
      users.find((u) => u.authProviderId === authProviderId) || null,
    create: async (data) => {
      const created = { _id: `generated-${data.authProviderId}`, ...data };
      users.push(created);
      return created;
    },
  };
}

function buildApp({ products = [], variants = [], inventory = [], categories = [CATEGORY_ID], verifier: appVerifier }) {
  const effectiveVerifier = appVerifier || verifier;
  const userService = new UserService({ repository: createStubUserRepository([]) });
  const productRepository = createMemoryProductRepository(products);
  const variantRepository = createMemoryVariantRepository(variants);
  const variantService = createVariantService({ repository: variantRepository, productRepository });
  const productService = new ProductService({
    repository: productRepository,
    variantRepository,
    variantService,
    categoryRepository: { findById: async (id) => (categories.includes(String(id)) ? { _id: id, isActive: true } : null) },
    inventoryRepository: createMemoryInventoryRepository(inventory),
    runTransaction: async (work) => work({ id: 'session-test' }),
  });
  const app = express();
  app.use(express.json());
  app.use('/api/v1/products', createProductRouter({ productService, userService, verifier: effectiveVerifier }));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

function withServer(getApp, fn) {
  return async () => {
    const server = getApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    try {
      await fn(`http://127.0.0.1:${port}`);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

let verifier;
let tokenCustomer;
let tokenAdmin;

before(async () => {
  const { privateKey, publicJwk } = await createKeyPair();
  verifier = createJwtVerifier({ keys: [publicJwk], issuer: ISSUER, audience: AUDIENCE, algorithms: ALGORITHMS });
  tokenCustomer = await signToken({ privateKey, subject: 'auth-customer-1', claims: { email: 'a@e.com', name: 'A' } });
  tokenAdmin = await signToken({ privateKey, subject: 'auth-admin-1', claims: { email: 'admin@e.com', name: 'Adm' } });
});

test('GET /products/:id/availability is public and returns per-variant availability', () => {
  const productId = freshHexId();
  const varA = variantDoc({ productId, sku: 'ABAYA-52' });
  const varB = variantDoc({ _id: freshHexId(), productId, sku: 'ABAYA-54', attributes: { size: '54' } });
  return withServer(
    () =>
      buildApp({
        products: [productDoc({ _id: productId })],
        variants: [varA, varB],
        inventory: [
          inventoryDoc({ productVariantId: String(varA._id), onlineQuantity: 10 }),
          inventoryDoc({ productVariantId: String(varB._id), onlineQuantity: 2 }),
        ],
      }),
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/products/${productId}/availability`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.message, MESSAGES.AVAILABILITY_FETCHED);
      assert.equal(body.data.variants.length, 2);
      const byId = Object.fromEntries(body.data.variants.map((v) => [v.variantId, v]));
      assert.equal(byId[String(varA._id)].availableQuantity, 10);
      assert.equal(byId[String(varA._id)].isOutOfStock, false);
      assert.equal(byId[String(varB._id)].availableQuantity, 2);
      assert.equal(byId[String(varB._id)].isOutOfStock, false);
    }
  )();
});

test('availability excludes reserved stock (online 10, reserved 3 → 7)', () => {
  const productId = freshHexId();
  const variant = variantDoc({ productId, sku: 'ABAYA-52' });
  return withServer(
    () =>
      buildApp({
        products: [productDoc({ _id: productId })],
        variants: [variant],
        inventory: [inventoryDoc({ productVariantId: String(variant._id), onlineQuantity: 10, reservedQuantity: 3 })],
      }),
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/products/${productId}/availability`);
      const body = await res.json();
      assert.equal(body.data.variants[0].availableQuantity, 7);
      assert.equal(body.data.variants[0].isOutOfStock, false);
    }
  )();
});

test('availability uses ONLINE stock, not OFFLINE stock', () => {
  const productId = freshHexId();
  const variant = variantDoc({ productId, sku: 'ABAYA-52' });
  return withServer(
    () =>
      buildApp({
        products: [productDoc({ _id: productId })],
        variants: [variant],
        inventory: [inventoryDoc({ productVariantId: String(variant._id), onlineQuantity: 2, offlineQuantity: 100 })],
      }),
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/products/${productId}/availability`);
      const body = await res.json();
      assert.equal(body.data.variants[0].availableQuantity, 2, 'offline 100 is never counted');
    }
  )();
});

test('a variant with no inventory record is out of stock', () => {
  const productId = freshHexId();
  return withServer(
    () =>
      buildApp({
        products: [productDoc({ _id: productId })],
        variants: [variantDoc({ productId, sku: 'ABAYA-52' })],
        inventory: [],
      }),
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/products/${productId}/availability`);
      const body = await res.json();
      assert.equal(body.data.variants.length, 1);
      assert.equal(body.data.variants[0].availableQuantity, 0);
      assert.equal(body.data.variants[0].isOutOfStock, true);
    }
  )();
});

test('inactive product → 404', () => {
  const id = freshHexId();
  return withServer(
    () => buildApp({ products: [productDoc({ _id: id, isActive: false })] }),
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/products/${id}/availability`);
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.equal(body.error.code, ERROR_CODES.PRODUCT_NOT_FOUND);
    }
  )();
});

test('unknown product → 404', () => {
  const id = freshHexId();
  return withServer(
    () => buildApp({ products: [] }),
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/products/${id}/availability`);
      assert.equal(res.status, 404);
    }
  )();
});

test('inactive variants are never exposed as purchasable availability', () => {
  const productId = freshHexId();
  const active = variantDoc({ productId, sku: 'ABAYA-52' });
  return withServer(
    () =>
      buildApp({
        products: [productDoc({ _id: productId })],
        variants: [
          active,
          variantDoc({ _id: freshHexId(), productId, sku: 'ABAYA-OFF', isActive: false }),
        ],
        inventory: [inventoryDoc({ productVariantId: String(active._id), onlineQuantity: 5 })],
      }),
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/products/${productId}/availability`);
      const body = await res.json();
      assert.equal(body.data.variants.length, 1, 'inactive variant excluded');
      assert.equal(body.data.variants[0].availableQuantity, 5);
    }
  )();
});

test('authenticated ADMIN and CUSTOMER can both read the public endpoint', () => {
  const productId = freshHexId();
  const variant = variantDoc({ productId, sku: 'ABAYA-52' });
  return withServer(
    () =>
      buildApp({
        products: [productDoc({ _id: productId })],
        variants: [variant],
        inventory: [inventoryDoc({ productVariantId: String(variant._id), onlineQuantity: 6 })],
      }),
    async (baseUrl) => {
      const url = `${baseUrl}/api/v1/products/${productId}/availability`;
      const anonymous = await fetch(url);
      assert.equal(anonymous.status, 200);

      const customer = await fetch(url, { headers: { Authorization: `Bearer ${tokenCustomer}` } });
      assert.equal(customer.status, 200);

      const admin = await fetch(url, { headers: { Authorization: `Bearer ${tokenAdmin}` } });
      assert.equal(admin.status, 200);

      const body = await anonymous.json();
      assert.equal(body.data.variants[0].availableQuantity, 6);
    }
  )();
});

test('the public availability response leaks no admin-only inventory data', () => {
  const productId = freshHexId();
  const variant = variantDoc({ productId, sku: 'ABAYA-52' });
  return withServer(
    () =>
      buildApp({
        products: [productDoc({ _id: productId, purchasePrice: 90000 })],
        variants: [variant],
        inventory: [inventoryDoc({ productVariantId: String(variant._id), onlineQuantity: 5, offlineQuantity: 50, reservedQuantity: 1 })],
      }),
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/products/${productId}/availability`);
      const raw = await res.text();
      assert.ok(!raw.includes('offline'), 'offline quantity never exposed');
      assert.ok(!raw.includes('reservedQuantity'), 'reservation records never exposed');
      assert.ok(!raw.includes('onlineQuantity'), 'raw online quantity never exposed');
      assert.ok(!raw.includes('performedBy'), 'actor never exposed');
      assert.ok(!raw.includes('purchasePrice'), 'cost never exposed');
      assert.ok(!raw.includes('movement'), 'ledger never exposed');
      assert.ok(!raw.includes('outletId'), 'outlet metadata never exposed');
    }
  )();
});

test('product without variants returns the simple-product availability shape', () => {
  const productId = freshHexId();
  return withServer(
    () =>
      buildApp({
        products: [productDoc({ _id: productId, isActive: true, variants: [] })],
        variants: [],
        inventory: [],
      }),
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/products/${productId}/availability`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.ok(body.data.product, 'simple-product availability exposes product');
      assert.equal(body.data.product.productId, String(productId));
      assert.equal(body.data.product.availableQuantity, 0);
      assert.equal(body.data.product.isOutOfStock, true);
      assert.deepEqual(body.data.variants, [], 'no variants for a simple product');
    }
  )();
});

test('simple-product availability reflects product-level inventory stock', () => {
  const productId = freshHexId();
  return withServer(
    () =>
      buildApp({
        products: [productDoc({ _id: productId, isActive: true, variants: [] })],
        variants: [],
        inventory: [
          inventoryDoc({
            _id: freshHexId(),
            productId,
            productVariantId: null,
            onlineQuantity: 8,
            reservedQuantity: 3,
          }),
        ],
      }),
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/products/${productId}/availability`);
      const body = await res.json();
      assert.equal(body.data.product.availableQuantity, 5, 'online minus reserved');
      assert.equal(body.data.product.isOutOfStock, false);
      assert.deepEqual(body.data.variants, []);
    }
  )();
});

test('variant products return product null with per-variant availability', () => {
  const productId = freshHexId();
  const variant = variantDoc({ productId, sku: 'ABAYA-52' });
  return withServer(
    () =>
      buildApp({
        products: [productDoc({ _id: productId })],
        variants: [variant],
        inventory: [inventoryDoc({ productVariantId: String(variant._id), onlineQuantity: 4 })],
      }),
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/products/${productId}/availability`);
      const body = await res.json();
      assert.equal(body.data.product, null, 'variant products expose no product-level stock');
      assert.equal(body.data.variants.length, 1);
      assert.equal(body.data.variants[0].availableQuantity, 4);
    }
  )();
});

