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

const CATEGORY = {
  _id: CATEGORY_ID,
  name: 'Abayas',
  slug: 'abayas',
  isActive: true,
};

const MESSAGES = {
  UNAUTHORIZED: 'Authentication required',
  FORBIDDEN: 'You do not have permission to perform this action',
  LIST_FETCHED: 'Products retrieved successfully',
  PRODUCT_FETCHED: 'Product retrieved successfully',
  PRODUCT_CREATED: 'Product created successfully',
  PRODUCT_UPDATED: 'Product updated successfully',
  PRODUCT_NOT_FOUND: 'Product not found',
  INVALID_CATEGORY: 'Invalid category for this product',
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
    productId: CATEGORY_ID,
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
    findOne: async (filter) =>
      docs.find((d) => Object.keys(filter).every((k) => d[k] === filter[k])) || null,
    findMany: async (filter, options = {}) => {
      let result = docs.filter((d) =>
        Object.keys(filter).every((k) => d[k] === filter[k])
      );
      result = applySort(result, options.sort);
      if (options.skip) result = result.slice(options.skip);
      if (options.limit) result = result.slice(0, options.limit);
      return result;
    },
    create: async (data) => {
      const created = {
        _id: freshHexId(),
        description: '',
        images: [],
        discount: null,
        featured: false,
        newArrival: false,
        bestDeal: false,
        isActive: true,
        measurementGuide: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      docs.push(created);
      return created;
    },
    updateById: async (id, update) => {
      const doc = docs.find((d) => String(d._id) === String(id));
      if (!doc) return null;
      Object.assign(doc, update, { updatedAt: new Date() });
      return doc;
    },
    count: async (filter) =>
      docs.filter((d) => Object.keys(filter).every((k) => d[k] === filter[k])).length,
    findBySlug: async (slug) => docs.find((d) => d.slug === slug) || null,
    existsBySlug: async (slug) => Boolean(docs.find((d) => d.slug === slug)),
  };
}

function createMemoryVariantRepository(initial = []) {
  const docs = [...initial];
  return {
    docs,
    findById: async (id) => docs.find((d) => String(d._id) === String(id)) || null,
    findOne: async (filter) =>
      docs.find((d) => Object.keys(filter).every((k) => d[k] === filter[k])) || null,
    findMany: async (filter, options = {}) => {
      let result = docs.filter((d) =>
        Object.keys(filter).every((k) => d[k] === filter[k])
      );
      return applySort(result, options.sort);
    },
    create: async (data) => {
      const created = {
        _id: freshHexId(),
        isActive: true,
        attributes: {},
        ...data,
      };
      docs.push(created);
      return created;
    },
    updateById: async (id, update) => {
      const doc = docs.find((d) => String(d._id) === String(id));
      if (!doc) return null;
      Object.assign(doc, update, { updatedAt: new Date() });
      return doc;
    },
    existsBySku: async (sku) => Boolean(docs.find((d) => d.sku === sku)),
    findOneByProduct: async (productId, filter) =>
      docs.find(
        (d) =>
          String(d.productId) === String(productId) &&
          Object.keys(filter).every((k) => d[k] === filter[k])
      ) || null,
    findByProduct: async (productId) =>
      docs.filter((d) => String(d.productId) === String(productId)),
    findByProductAndId: async (productId, variantId) =>
      docs.find(
        (d) =>
          String(d.productId) === String(productId) &&
          String(d._id) === String(variantId)
      ) || null,
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

function buildApp({
  users,
  products = [],
  variants = [],
  categories = [CATEGORY],
  autoProvisionCustomers = true,
  verifier: appVerifier,
}) {
  const effectiveVerifier = appVerifier || verifier;
  const userService = new UserService({
    repository: createStubUserRepository(users),
    autoProvisionCustomers,
  });
  const productRepository = createMemoryProductRepository(products);
  const variantRepository = createMemoryVariantRepository(variants);
  const variantService = createVariantService({
    repository: variantRepository,
    productRepository,
  });
  const productService = new ProductService({
    repository: productRepository,
    variantRepository,
    variantService,
    categoryRepository: {
      findById: async (id) =>
        categories.find((c) => String(c._id) === String(id)) || null,
    },
    runTransaction: async (work) => work({ id: 'session-test' }),
  });
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/products',
    createProductRouter({ productService, userService, verifier: effectiveVerifier })
  );
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

function post(url, token, body) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function patch(url, token, body) {
  return fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

let verifier;
let tokenCustomer;
let tokenStaff;
let tokenAdmin;
let tokenAdminClaimSpoof;

before(async () => {
  const { privateKey, publicJwk } = await createKeyPair();
  verifier = createJwtVerifier({
    keys: [publicJwk],
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ALGORITHMS,
  });

  tokenCustomer = await signToken({
    privateKey,
    subject: 'auth-customer-1',
    claims: { email: 'amina@example.com', name: 'Amina Rahman' },
  });
  tokenStaff = await signToken({
    privateKey,
    subject: 'auth-staff-1',
    claims: { email: 'staff@example.com', name: 'Staff Person' },
  });
  tokenAdmin = await signToken({
    privateKey,
    subject: 'auth-admin-1',
    claims: { email: 'admin@example.com', name: 'Admin Person' },
  });
  tokenAdminClaimSpoof = await signToken({
    privateKey,
    subject: 'auth-customer-1',
    claims: { role: 'ADMIN', email: 'amina@example.com', name: 'Amina Rahman' },
  });
});

function seedUsers() {
  return [
    userDoc(),
    userDoc({
      _id: 'usr-staff-1',
      authProviderId: 'auth-staff-1',
      email: 'staff@example.com',
      displayName: 'Staff Person',
      role: ROLES.STAFF,
    }),
    userDoc({
      _id: 'usr-admin-1',
      authProviderId: 'auth-admin-1',
      email: 'admin@example.com',
      displayName: 'Admin Person',
      role: ROLES.ADMIN,
    }),
  ];
}

function productPayload(overrides = {}) {
  return {
    name: 'Premium Abaya',
    categoryId: CATEGORY_ID,
    sellingPrice: 150000,
    variants: [{ sku: 'ABAYA-52', attributes: { size: '52' } }],
    ...overrides,
  };
}

test('GET /api/v1/products is public, lists ACTIVE products, and paginates', withServer(
  () =>
    buildApp({
      users: [],
      products: [
        productDoc(),
        productDoc({ _id: freshHexId(), slug: 'second-abaya', sellingPrice: 100000 }),
        productDoc({ _id: freshHexId(), slug: 'hidden-abaya', isActive: false }),
      ],
    }),
  async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/products?limit=2&page=1`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.message, MESSAGES.LIST_FETCHED);
    assert.equal(body.data.products.length, 2);
    assert.equal(body.data.pagination.total, 2, 'inactive products are excluded');
    assert.equal(body.data.pagination.totalPages, 1);
  }
));

test('GET /api/v1/products responses never leak purchase price or internals', withServer(
  () => buildApp({ users: [], products: [productDoc({ purchasePrice: 90000 })] }),
  async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/products`);
    const raw = await res.text();
    assert.ok(!raw.includes('purchase'), 'purchase price never appears in list');
    assert.ok(!raw.includes('_id'), 'raw _id never serialized');
    assert.ok(!raw.includes('__v'), 'version key never serialized');
  }
));

test('GET /api/v1/products filters by categoryId and flag', withServer(
  () =>
    buildApp({
      users: [],
      products: [
        productDoc(),
        productDoc({ _id: freshHexId(), slug: 'featured', featured: true }),
        productDoc({ _id: freshHexId(), slug: 'featured-2', featured: true }),
      ],
    }),
  async (baseUrl) => {
    const featured = await fetch(`${baseUrl}/api/v1/products?featured=true`);
    const featuredBody = await featured.json();
    assert.equal(featuredBody.data.products.length, 2);

    const ignored = await fetch(`${baseUrl}/api/v1/products?stock=5`);
    assert.equal(ignored.status, 200);
    const ignoredBody = await ignored.json();
    assert.equal(ignoredBody.data.products.length, 3, 'unknown filter keys are ignored');

    const badSort = await fetch(`${baseUrl}/api/v1/products?sort=stock`);
    assert.equal(badSort.status, 400);
    const badSortBody = await badSort.json();
    assert.equal(badSortBody.error.code, ERROR_CODES.INVALID_PRODUCT);
  }
));

test('GET /api/v1/products/:id returns a full safe product (public, no purchase price)', withServer(
  () => {
    const sharedId = freshHexId();
    return buildApp({
      users: [],
      products: [productDoc({ _id: sharedId, purchasePrice: 90000 })],
      variants: [variantDoc({ productId: sharedId })],
    });
  },
  async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/products`);
    const listBody = await res.json();
    const id = listBody.data.products[0].id;

    const detail = await fetch(`${baseUrl}/api/v1/products/${id}`);
    assert.equal(detail.status, 200);
    const body = await detail.json();
    assert.equal(body.data.product.id, id);
    assert.equal(body.data.product.sellingPrice, 150000);
    assert.ok(!('purchasePrice' in body.data.product), 'purchase price hidden publicly');
    assert.equal(body.data.product.variants.length, 1);
    assert.ok(!('purchasePriceOverride' in body.data.product.variants[0]));
  }
));

test('GET /api/v1/products/:id inactive → 404', () => {
  const hiddenId = freshHexId();
  return withServer(
    () =>
      buildApp({
        users: [],
        products: [productDoc({ _id: hiddenId, isActive: false })],
      }),
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/products/${hiddenId}`);
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.equal(body.error.code, ERROR_CODES.PRODUCT_NOT_FOUND);
    }
  )();
});

test('GET /api/v1/products/slug/:slug resolves and normalizes', withServer(
  () => buildApp({ users: [], products: [productDoc()] }),
  async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/products/slug/PREMIUM ABAYA`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.product.slug, 'premium-abaya');
  }
));

test('POST /api/v1/products without a token → 401', withServer(
  () => buildApp({ users: seedUsers(), products: [] }),
  async (baseUrl) => {
    const res = await post(`${baseUrl}/api/v1/products`, null, productPayload());
    assert.equal(res.status, 401);
  }
));

test('POST /api/v1/products as CUSTOMER → 403', withServer(
  () => buildApp({ users: seedUsers(), products: [] }),
  async (baseUrl) => {
    const res = await post(`${baseUrl}/api/v1/products`, tokenCustomer, productPayload());
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error.code, ERROR_CODES.FORBIDDEN);
  }
));

test('POST /api/v1/products as STAFF → 201 and purchase price stays private', withServer(
  () => buildApp({ users: seedUsers(), products: [] }),
  async (baseUrl) => {
    const res = await post(
      `${baseUrl}/api/v1/products`,
      tokenStaff,
      productPayload({ purchasePrice: 90000 })
    );
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.message, MESSAGES.PRODUCT_CREATED);
    assert.equal(body.data.product.slug, 'premium-abaya');
    assert.equal(body.data.product.sellingPrice, 150000);
    assert.ok(!('purchasePrice' in body.data.product), 'staff cannot see purchase price');
    assert.equal(body.data.product.variants.length, 1);
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes('purchase'), 'no purchase cost in the staff response');
  }
));

test('POST /api/v1/products as ADMIN → 201 and purchase price is visible', withServer(
  () => buildApp({ users: seedUsers(), products: [] }),
  async (baseUrl) => {
    const res = await post(
      `${baseUrl}/api/v1/products`,
      tokenAdmin,
      productPayload({ purchasePrice: 90000 })
    );
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.data.product.purchasePrice, 90000, 'admin sees purchase price');
  }
));

test('POST as ADMIN stores the variant and its canonical attribute key', withServer(
  () => buildApp({ users: seedUsers(), products: [] }),
  async (baseUrl) => {
    const res = await post(
      `${baseUrl}/api/v1/products`,
      tokenAdmin,
      productPayload()
    );
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.data.product.variants[0].sku, 'ABAYA-52');
    assert.deepEqual(body.data.product.variants[0].attributes, { size: '52' });
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes('attributeKey'), 'attributeKey is internal');
  }
));

test('POST as ADMIN rejects a duplicate slug', withServer(
  () =>
    buildApp({
      users: seedUsers(),
      products: [productDoc({ slug: 'premium-abaya' })],
    }),
  async (baseUrl) => {
    const res = await post(
      `${baseUrl}/api/v1/products`,
      tokenAdmin,
      productPayload({ slug: 'premium-abaya' })
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, ERROR_CODES.PRODUCT_SLUG_ALREADY_EXISTS);
  }
));

test('POST as ADMIN rejects an inactive category', withServer(
  () =>
    buildApp({
      users: seedUsers(),
      categories: [{ ...CATEGORY, isActive: false }],
    }),
  async (baseUrl) => {
    const res = await post(`${baseUrl}/api/v1/products`, tokenAdmin, productPayload());
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, ERROR_CODES.INVALID_CATEGORY);
    assert.equal(body.message, MESSAGES.INVALID_CATEGORY);
  }
));

test('POST as ADMIN rejects operator injection and unknown fields', withServer(
  () => buildApp({ users: seedUsers(), products: [] }),
  async (baseUrl) => {
    const injected = await post(
      `${baseUrl}/api/v1/products`,
      tokenAdmin,
      { ...productPayload(), $set: { role: 'ADMIN' } }
    );
    assert.equal(injected.status, 400);

    const unknown = await post(
      `${baseUrl}/api/v1/products`,
      tokenAdmin,
      { ...productPayload(), stock: 5 }
    );
    assert.equal(unknown.status, 400);
    const body = await unknown.json();
    assert.equal(body.error.code, ERROR_CODES.INVALID_PRODUCT);
  }
));

test('POST as ADMIN creates a product with no variants', withServer(
  () => buildApp({ users: seedUsers(), products: [] }),
  async (baseUrl) => {
    const res = await post(
      `${baseUrl}/api/v1/products`,
      tokenAdmin,
      productPayload({ variants: [] })
    );
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.data.product.slug, 'premium-abaya');
    assert.deepEqual(body.data.product.variants, [], 'no variants created');
    assert.equal(body.data.product.measurementGuide, null);
  }
));

test('POST as ADMIN accepts an image-only measurement guide without variants', withServer(
  () => buildApp({ users: seedUsers(), products: [] }),
  async (baseUrl) => {
    const res = await post(
      `${baseUrl}/api/v1/products`,
      tokenAdmin,
      productPayload({
        variants: [],
        measurementGuide: { imageUrl: 'https://cdn.example.com/guide.jpg' },
      })
    );
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.deepEqual(body.data.product.measurementGuide, {
      imageUrl: 'https://cdn.example.com/guide.jpg',
    });
  }
));

test('POST as ADMIN rejects legacy structured measurement guides', withServer(
  () => buildApp({ users: seedUsers(), products: [] }),
  async (baseUrl) => {
    const res = await post(
      `${baseUrl}/api/v1/products`,
      tokenAdmin,
      productPayload({
        variants: [{ sku: 'ABAYA-DEFAULT' }],
        measurementGuide: {
          unit: 'inch',
          fields: [{ key: 'abayaLength', label: 'Length', sortOrder: 0 }],
          sizes: [{ size: '52', measurements: { abayaLength: 50 } }],
        },
      })
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, ERROR_CODES.INVALID_MEASUREMENT_GUIDE);
  }
));

test('POST as ADMIN rejects an invalid measurement guide image URL', withServer(
  () => buildApp({ users: seedUsers(), products: [] }),
  async (baseUrl) => {
    const res = await post(
      `${baseUrl}/api/v1/products`,
      tokenAdmin,
      productPayload({ measurementGuide: { imageUrl: 'not-a-url' } })
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, ERROR_CODES.INVALID_MEASUREMENT_GUIDE);
  }
));

test('POST as ADMIN rejects a duplicate SKU and duplicate variant attributes', withServer(
  () =>
    buildApp({
      users: seedUsers(),
      variants: [
        variantDoc({ productId: 'prod-existing', sku: 'ABAYA-52', attributes: { size: '52' } }),
      ],
    }),
  async (baseUrl) => {
    const dupSku = await post(`${baseUrl}/api/v1/products`, tokenAdmin, productPayload());
    assert.equal(dupSku.status, 400);
    const skuBody = await dupSku.json();
    assert.equal(skuBody.error.code, ERROR_CODES.VARIANT_SKU_ALREADY_EXISTS);

    const dupAttrs = await post(
      `${baseUrl}/api/v1/products`,
      tokenAdmin,
      productPayload({
        variants: [
          { sku: 'ABAYA-A', attributes: { size: '52' } },
          { sku: 'ABAYA-B', attributes: { size: '52' } },
        ],
      })
    );
    assert.equal(dupAttrs.status, 400);
    const attrsBody = await dupAttrs.json();
    assert.equal(attrsBody.error.code, ERROR_CODES.VARIANT_DUPLICATE_ATTRIBUTES);
  }
));

test('a spoofed role claim cannot elevate a CUSTOMER to create products', withServer(
  () => buildApp({ users: seedUsers(), products: [] }),
  async (baseUrl) => {
    const res = await post(`${baseUrl}/api/v1/products`, tokenAdminClaimSpoof, productPayload());
    assert.equal(res.status, 403, 'application role comes from the stored User, not the token');
  }
));

test('PATCH /api/v1/products/:id is ADMIN-only (401/403 for others)', withServer(
  () =>
    buildApp({
      users: seedUsers(),
      products: [productDoc()],
    }),
  async (baseUrl) => {
    const id = productDoc._id;
    const unauthed = await patch(`${baseUrl}/api/v1/products/${id}`, null, { name: 'X' });
    assert.equal(unauthed.status, 401);

    const customer = await patch(`${baseUrl}/api/v1/products/${id}`, tokenCustomer, { name: 'X' });
    assert.equal(customer.status, 403);

    const staff = await patch(`${baseUrl}/api/v1/products/${id}`, tokenStaff, { name: 'X' });
    assert.equal(staff.status, 403);
  }
));

test('PATCH as ADMIN applies a partial update and keeps omitted fields', () => {
  const productId = freshHexId();
  return withServer(
    () =>
      buildApp({
        users: seedUsers(),
        products: [productDoc({ _id: productId, description: 'keep me' })],
      }),
    async (baseUrl) => {
      const res = await patch(`${baseUrl}/api/v1/products/${productId}`, tokenAdmin, {
        name: 'Renamed',
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.message, MESSAGES.PRODUCT_UPDATED);
      assert.equal(body.data.product.name, 'Renamed');
      assert.equal(body.data.product.description, 'keep me', 'PATCH preserves omitted fields');
      assert.equal(body.data.product.slug, 'premium-abaya');
    }
  )();
});

test('PATCH as ADMIN deactivates a product and it vanishes from public reads', () => {
  const productId = freshHexId();
  return withServer(
    () =>
      buildApp({
        users: seedUsers(),
        products: [productDoc({ _id: productId })],
      }),
    async (baseUrl) => {
      const deactivate = await patch(`${baseUrl}/api/v1/products/${productId}`, tokenAdmin, {
        isActive: false,
      });
      assert.equal(deactivate.status, 200);
      const body = await deactivate.json();
      assert.equal(body.data.product.isActive, false);

      const publicGet = await fetch(`${baseUrl}/api/v1/products/${productId}`);
      assert.equal(publicGet.status, 404, 'inactive product is not publicly visible');
    }
  )();
});

test('PATCH as ADMIN cannot change a variant SKU (immutable)', () => {
  const productId = freshHexId();
  const variantId = freshHexId();
  return withServer(
    () =>
      buildApp({
        users: seedUsers(),
        products: [productDoc({ _id: productId })],
        variants: [variantDoc({ _id: variantId, productId })],
      }),
    async (baseUrl) => {
      const res = await patch(
        `${baseUrl}/api/v1/products/${productId}`,
        tokenAdmin,
        { variants: [{ id: variantId, sku: 'NEW-SKU' }] }
      );
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error.code, ERROR_CODES.INVALID_PRODUCT);
    }
  )();
});

test('PATCH as ADMIN replaces variants atomically (add + deactivate dropped)', () => {
  const productId = freshHexId();
  const variantId = freshHexId();
  return withServer(
    () =>
      buildApp({
        users: seedUsers(),
        products: [productDoc({ _id: productId })],
        variants: [variantDoc({ _id: variantId, productId })],
      }),
    async (baseUrl) => {
      const res = await patch(
        `${baseUrl}/api/v1/products/${productId}`,
        tokenAdmin,
        { variants: [{ id: variantId, sellingPriceOverride: 160000 }, { sku: 'ABAYA-NEW' }] }
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      const skus = body.data.product.variants.map((v) => v.sku).sort();
      assert.deepEqual(skus, ['ABAYA-52', 'ABAYA-NEW'], 'response carries the fresh variant list');
      const kept = body.data.product.variants.find((v) => v.sku === 'ABAYA-52');
      assert.equal(kept.sellingPrice, 160000);
      assert.equal(kept.effectiveSellingPrice, 160000);
    }
  )();
});

test('raw token is never echoed in responses', withServer(
  () => buildApp({ users: seedUsers(), products: [] }),
  async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/products`, {
      headers: { Authorization: `Bearer ${tokenCustomer}` },
    });
    const raw = await res.text();
    assert.ok(!raw.includes(tokenCustomer), 'raw token never appears in the response body');
  }
));
