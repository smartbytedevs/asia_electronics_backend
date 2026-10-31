'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ProductService } = require('../../../src/modules/products/product.service');
const {
  createVariantService,
  buildAttributeKey,
} = require('../../../src/modules/products/variants/productVariant.service');
const { ROLES, ERROR_CODES } = require('../../../src/constants');

const CATEGORY_ID = '507f1f77bcf86cd799439020';
const CATEGORY_ID_2 = '507f1f77bcf86cd799439021';

const CATEGORY = {
  _id: CATEGORY_ID,
  name: 'Abayas',
  slug: 'abayas',
  isActive: true,
};

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
  let nextId = 1;
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
      const created = { _id: `prod-${nextId++}`, ...data };
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
  let nextId = 1;
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
        _id: `var-${nextId++}`,
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

function productDoc(overrides = {}) {
  return {
    _id: '507f1f77bcf86cd799439011',
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
    _id: '507f1f77bcf86cd799439031',
    productId: '507f1f77bcf86cd799439011',
    sku: 'ABAYA-52',
    attributes: { size: '52' },
    sellingPriceOverride: null,
    purchasePriceOverride: null,
    isActive: true,
  };
  const doc = { ...base, ...overrides };
  doc.attributeKey = buildAttributeKey(doc.attributes);
  return doc;
}

function makeService({ products = [], variants = [], category = CATEGORY, runTransaction } = {}) {
  const productRepository = createMemoryProductRepository(products);
  const variantRepository = createMemoryVariantRepository(variants);
  const variantService = createVariantService({
    repository: variantRepository,
    productRepository,
  });
  const categoryRepository = {
    findById: async (id) =>
      category && String(category._id) === String(id) ? category : null,
  };
  const service = new ProductService({
    repository: productRepository,
    variantRepository,
    variantService,
    categoryRepository,
    runTransaction: runTransaction || (async (work) => work({ id: 'session-test' })),
  });
  return { service, productRepository, variantRepository };
}

const createPayload = (overrides = {}) => ({
  name: 'Premium Abaya',
  categoryId: CATEGORY_ID,
  sellingPrice: 150000,
  variants: [{ sku: 'ABAYA-52', attributes: { size: '52' } }],
  ...overrides,
});

test('createProduct writes product + variants through the transaction with the session', async () => {
  let work;
  const runTransaction = async (fn) => {
    work = fn;
    return fn({ id: 'session-test' });
  };
  const { service, productRepository, variantRepository } = makeService({ runTransaction });
  const result = await service.createProduct(createPayload(), { role: ROLES.ADMIN });

  assert.equal(result.name, 'Premium Abaya');
  assert.equal(result.slug, 'premium-abaya');
  assert.equal(productRepository.docs.length, 1, 'product persisted');
  assert.equal(variantRepository.docs.length, 1, 'variant persisted');
  assert.equal(variantRepository.docs[0].productId, 'prod-1');
  assert.equal(variantRepository.docs[0].sku, 'ABAYA-52');
  assert.ok(work, 'transaction work executed');
});

test('createProduct creates a product with no variants (variants omitted)', async () => {
  const { service, productRepository, variantRepository } = makeService();
  const result = await service.createProduct(
    { name: 'Plain Abaya', categoryId: CATEGORY_ID, sellingPrice: 100000 },
    { role: ROLES.ADMIN }
  );
  assert.equal(result.name, 'Plain Abaya');
  assert.equal(productRepository.docs.length, 1, 'product persisted');
  assert.equal(variantRepository.docs.length, 0, 'no variants created');
  assert.deepEqual(result.variants, [], 'response carries an empty variants list');
});

test('createProduct creates a product with an explicit empty variants array', async () => {
  const { service, variantRepository } = makeService();
  const result = await service.createProduct(
    createPayload({ variants: [] }),
    { role: ROLES.ADMIN }
  );
  assert.equal(result.slug, 'premium-abaya');
  assert.equal(variantRepository.docs.length, 0, 'no variants created');
  assert.deepEqual(result.variants, []);
});

test('createProduct still rejects invalid variant payloads when variants are provided', async () => {
  const { service } = makeService();
  await assert.rejects(
    service.createProduct(createPayload({ variants: [{ attributes: { '1bad': 'x' } }] })),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, ERROR_CODES.INVALID_VARIANT);
      return true;
    }
  );
});

test('createProduct auto-generates a SKU when a variant omits it', async () => {
  const { service, variantRepository } = makeService();
  const result = await service.createProduct(
    createPayload({ variants: [{ attributes: { size: '52' } }] }),
    { role: ROLES.ADMIN }
  );
  assert.equal(result.variants.length, 1);
  assert.equal(variantRepository.docs[0].sku, 'PREMIUMABAYA-52');
  assert.equal(variantRepository.docs[0].attributeKey, buildAttributeKey({ size: '52' }));
});

test('createProduct rejects an inactive category', async () => {
  const { service } = makeService({ category: { ...CATEGORY, isActive: false } });
  await assert.rejects(
    service.createProduct(createPayload()),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, ERROR_CODES.INVALID_CATEGORY);
      return true;
    }
  );
});

test('createProduct rejects a missing category', async () => {
  const { service } = makeService({ category: null });
  await assert.rejects(service.createProduct(createPayload()), (err) => err.statusCode === 400);
});

test('createProduct accepts an image-only measurement guide without sized variants', async () => {
  const { service } = makeService();
  const result = await service.createProduct(
    createPayload({
      variants: [],
      measurementGuide: { imageUrl: 'https://cdn.example.com/guide.jpg' },
    }),
    { role: ROLES.ADMIN }
  );
  assert.equal(result.measurementGuide.imageUrl, 'https://cdn.example.com/guide.jpg');
  assert.deepEqual(result.variants, []);
});

test('createProduct rejects legacy structured measurement guides', async () => {
  const { service } = makeService();
  const payload = createPayload({
    variants: [{ sku: 'ABAYA-52', attributes: { size: '52' } }],
    measurementGuide: {
      unit: 'inch',
      fields: [{ key: 'abayaLength', label: 'Length', sortOrder: 0 }],
      sizes: [{ size: '52', measurements: { abayaLength: 50 } }],
    },
  });
  await assert.rejects(
    service.createProduct(payload),
    (err) => err.code === ERROR_CODES.INVALID_MEASUREMENT_GUIDE
  );
});

test('createProduct derives a unique slug with a numeric suffix on collision', async () => {
  const { service, productRepository } = makeService({
    products: [productDoc()],
  });
  await service.createProduct(createPayload(), { role: ROLES.ADMIN });
  assert.equal(productRepository.docs[1].slug, 'premium-abaya-2');
});

test('createProduct respects an explicit slug and rejects a collision', async () => {
  const { service } = makeService({ products: [productDoc()] });
  await assert.rejects(
    service.createProduct(createPayload({ slug: 'premium-abaya' })),
    (err) => err.code === ERROR_CODES.PRODUCT_SLUG_ALREADY_EXISTS
  );
});

test('createProduct rejects a duplicate SKU via the variant layer', async () => {
  const { service } = makeService({
    variants: [variantDoc({ _id: 'var-1', productId: 'prod-9', sku: 'ABAYA-52' })],
  });
  await assert.rejects(
    service.createProduct(createPayload()),
    (err) => err.code === ERROR_CODES.VARIANT_SKU_ALREADY_EXISTS
  );
});

test('createProduct aborts (propagates) when a variant write fails inside the transaction', async () => {
  const { service, variantRepository } = makeService();
  variantRepository.create = async () => {
    const err = new Error('boom');
    throw err;
  };
  await assert.rejects(service.createProduct(createPayload()), /boom/);
});

test('createProduct admin response includes purchase price; staff response hides it', async () => {
  const payload = createPayload({ purchasePrice: 90000 });

  const admin = await makeService().service.createProduct(payload, { role: ROLES.ADMIN });
  assert.equal(admin.purchasePrice, 90000);

  const staff = await makeService().service.createProduct(payload, { role: ROLES.STAFF });
  assert.equal(staff.purchasePrice, undefined, 'staff never sees purchase price');
  assert.equal(staff.sellingPrice, 150000);
});

test('createProduct rolls discount math into effectiveSellingPrice without storing it', async () => {
  const { service } = makeService();
  const admin = await service.createProduct(
    createPayload({ discount: { type: 'percentage', value: 10 } }),
    { role: ROLES.ADMIN }
  );
  assert.equal(admin.discount.value, 10);
  assert.equal(admin.effectiveSellingPrice, 135000);
  assert.equal(admin.sellingPrice, 150000, 'discounted price is not stored');
});

test('updateProduct applies a partial patch and preserves omitted fields', async () => {
  const existing = productDoc({ description: 'keep me' });
  const { service, productRepository } = makeService({
    products: [existing],
    variants: [variantDoc()],
  });
  const result = await service.updateProduct(String(existing._id), { name: 'New Name' }, { role: ROLES.ADMIN });
  assert.equal(result.name, 'New Name');
  assert.equal(result.description, 'keep me');
  assert.equal(result.slug, 'premium-abaya', 'slug preserved when not provided');
});

test('updateProduct rejects an SKU change on an existing variant (SKU is immutable)', async () => {
  const existing = productDoc();
  const { service } = makeService({
    products: [existing],
    variants: [variantDoc()],
  });
  await assert.rejects(
    service.updateProduct(
      String(existing._id),
      { variants: [{ id: '507f1f77bcf86cd799439031', sku: 'NEW-SKU' }] },
      { role: ROLES.ADMIN }
    ),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /SKU cannot be changed/);
      return true;
    }
  );
});

test('updateProduct replacement: adds a new variant and deactivates dropped ones', async () => {
  const existing = productDoc();
  const { service, variantRepository } = makeService({
    products: [existing],
    variants: [
      variantDoc(),
      variantDoc({
        _id: '507f1f77bcf86cd799439032',
        sku: 'ABAYA-54',
        attributes: { size: '54' },
      }),
    ],
  });

  await service.updateProduct(
    String(existing._id),
    {
      variants: [
        { id: '507f1f77bcf86cd799439031', sellingPriceOverride: 160000 },
        { sku: 'ABAYA-NEW' },
      ],
    },
    { role: ROLES.ADMIN }
  );

  const var1 = variantRepository.docs.find((v) => v._id === '507f1f77bcf86cd799439031');
  assert.equal(var1.sellingPriceOverride, 160000, 'existing variant updated');
  assert.equal(var1.isActive, true);

  const var2 = variantRepository.docs.find((v) => v._id === '507f1f77bcf86cd799439032');
  assert.equal(var2.isActive, false, 'dropped variant deactivated, never deleted');

  const created = variantRepository.docs.find((v) => v.sku === 'ABAYA-NEW');
  assert.ok(created, 'new variant created');
  assert.equal(created.isActive, true);
});

test('updateProduct rejects an unknown variant id', async () => {
  const existing = productDoc();
  const { service } = makeService({ products: [existing], variants: [variantDoc()] });
  await assert.rejects(
    service.updateProduct(
      String(existing._id),
      { variants: [{ id: '507f1f77bcf86cd799439099', sku: 'X' }] },
      { role: ROLES.ADMIN }
    ),
    (err) => {
      assert.equal(err.statusCode, 404);
      assert.equal(err.code, ERROR_CODES.VARIANT_NOT_FOUND);
      return true;
    }
  );
});

test('updateProduct rejects duplicate attribute sets across the replacement', async () => {
  const existing = productDoc();
  const { service } = makeService({
    products: [existing],
    variants: [variantDoc()],
  });
  await assert.rejects(
    service.updateProduct(
      String(existing._id),
      { variants: [{ sku: 'ABAYA-NEW', attributes: { size: '52' } }] },
      { role: ROLES.ADMIN }
    ),
    (err) => err.code === ERROR_CODES.VARIANT_DUPLICATE_ATTRIBUTES
  );
});

test('updateProduct rejects purchase-price writes for non-admin callers', async () => {
  const existing = productDoc();
  const { service } = makeService({ products: [existing] });

  await assert.rejects(
    service.updateProduct(String(existing._id), { purchasePrice: 50000 }, { role: ROLES.STAFF }),
    (err) => {
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, ERROR_CODES.FORBIDDEN);
      return true;
    }
  );
  await assert.rejects(
    service.updateProduct(
      String(existing._id),
      { variants: [{ sku: 'X', purchasePriceOverride: 50000 }] },
      { role: ROLES.STAFF }
    ),
    (err) => err.statusCode === 403
  );
});

test('updateProduct keeps the guide consistent with the final variant sizes', async () => {
  const existing = productDoc();
  const { service } = makeService({
    products: [existing],
    variants: [variantDoc()],
  });

  await assert.rejects(
    service.updateProduct(
      String(existing._id),
      {
        measurementGuide: {
          unit: 'inch',
          fields: [{ key: 'abayaLength', label: 'Length', sortOrder: 0 }],
          sizes: [{ size: '56', measurements: { abayaLength: 50 } }],
        },
      },
      { role: ROLES.ADMIN }
    ),
    (err) => err.code === ERROR_CODES.INVALID_MEASUREMENT_GUIDE
  );

  const guided = productDoc({
    measurementGuide: {
      unit: 'inch',
      fields: [{ key: 'abayaLength', label: 'Length', sortOrder: 0 }],
      sizes: [{ size: '52', measurements: { abayaLength: 50 } }],
    },
  });
  const guidedService = makeService({
    products: [guided],
    variants: [variantDoc()],
  }).service;
  await assert.rejects(
    guidedService.updateProduct(
      String(guided._id),
      { variants: [{ id: '507f1f77bcf86cd799439031', attributes: { color: 'Black' } }] },
      { role: ROLES.ADMIN }
    ),
    (err) => err.code === ERROR_CODES.INVALID_MEASUREMENT_GUIDE
  );
});

test('updateProduct rejects an empty update', async () => {
  const existing = productDoc();
  const { service } = makeService({ products: [existing] });
  await assert.rejects(
    service.updateProduct(String(existing._id), {}, { role: ROLES.ADMIN }),
    (err) => err.code === ERROR_CODES.INVALID_PRODUCT
  );
});

test('updateProduct maps a slug collision with another product', async () => {
  const existing = productDoc();
  const other = productDoc({ _id: 'prod-other', slug: 'taken' });
  const { service } = makeService({ products: [existing, other] });
  await assert.rejects(
    service.updateProduct(String(existing._id), { slug: 'taken' }, { role: ROLES.ADMIN }),
    (err) => err.code === ERROR_CODES.PRODUCT_SLUG_ALREADY_EXISTS
  );
});

test('deactivateProduct soft-deactivates and hides from public reads', async () => {
  const existing = productDoc();
  const { service } = makeService({
    products: [existing],
    variants: [variantDoc()],
  });
  const deactivated = await service.deactivateProduct(String(existing._id), { role: ROLES.ADMIN });
  assert.equal(deactivated.isActive, false);

  await assert.rejects(
    service.getPublicProductById(String(existing._id)),
    (err) => err.code === ERROR_CODES.PRODUCT_NOT_FOUND
  );
});

test('getPublicProductById returns only active variants and hides purchase price', async () => {
  const existing = productDoc();
  const { service } = makeService({
    products: [existing],
    variants: [
      variantDoc({ isActive: true }),
      variantDoc({
        _id: '507f1f77bcf86cd799439032',
        productId: 'prod-0',
        sku: 'ABAYA-54',
        isActive: false,
      }),
    ],
  });
  const result = await service.getPublicProductById(String(existing._id));
  assert.equal(result.variants.length, 1, 'inactive variants excluded');
  assert.equal(result.variants[0].id, '507f1f77bcf86cd799439031');
  assert.ok(!('purchasePrice' in result), 'purchase price hidden publicly');
});

test('getPublicProductById throws 404 for missing or inactive products', async () => {
  const { service } = makeService({ products: [productDoc({ isActive: false })] });
  await assert.rejects(
    service.getPublicProductById('507f1f77bcf86cd799439011'),
    (err) => err.statusCode === 404
  );
  await assert.rejects(
    service.getPublicProductById('507f1f77bcf86cd799439099'),
    (err) => err.statusCode === 404
  );
});

test('getPublicProductBySlug normalizes the slug', async () => {
  const { service } = makeService({ products: [productDoc()] });
  const result = await service.getPublicProductBySlug('  PREMIUM ABAYA ');
  assert.equal(result.slug, 'premium-abaya');
});

test('listProducts filters ACTIVE products and paginates', async () => {
  const { service } = makeService({
    products: [
      productDoc({ _id: 'p1', featured: true, sellingPrice: 1000 }),
      productDoc({ _id: 'p2', featured: false, sellingPrice: 2000 }),
      productDoc({ _id: 'p3', isActive: false }),
    ],
  });
  const result = await service.listProducts({ page: 1, limit: 2, filters: { featured: 'true' } });
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].id, 'p1');
  assert.equal(result.pagination.total, 1);
});

test('listProducts supports priceAsc / priceDesc / newest sorting', async () => {
  const { service } = makeService({
    products: [
      productDoc({ _id: 'p1', sellingPrice: 3000 }),
      productDoc({ _id: 'p2', sellingPrice: 1000 }),
      productDoc({ _id: 'p3', sellingPrice: 2000 }),
    ],
  });
  const asc = await service.listProducts({ sort: 'priceAsc' });
  assert.deepEqual(asc.products.map((p) => p.id), ['p2', 'p3', 'p1']);
  const desc = await service.listProducts({ sort: 'priceDesc' });
  assert.deepEqual(desc.products.map((p) => p.id), ['p1', 'p3', 'p2']);
});

test('listProducts rejects unknown filters and sorts', async () => {
  const { service } = makeService();
  await assert.rejects(service.listProducts({ filters: { stock: 5 } }), (err) => err.statusCode === 400);
  await assert.rejects(service.listProducts({ sort: 'random' }), (err) => err.statusCode === 400);
  await assert.rejects(service.listProducts({ page: 0 }), (err) => err.statusCode === 400);
  await assert.rejects(service.listProducts({ filters: { categoryId: 'nope' } }), (err) => err.statusCode === 400);
});

test('listProducts caps the page size at the maximum', async () => {
  const { service } = makeService();
  const normalized = service.normalizeListQuery({ limit: 999 });
  assert.equal(normalized.limit, 100);
});

test('listProducts cards never leak purchase price', async () => {
  const { service } = makeService({
    products: [productDoc({ purchasePrice: 90000 })],
  });
  const result = await service.listProducts();
  const raw = JSON.stringify(result);
  assert.ok(!raw.includes('purchase'), 'no purchase cost in list payloads');
});

test('ProductService requires its dependencies', () => {
  assert.throws(() => new ProductService(), /repository/);
  assert.throws(() => new ProductService({ repository: {} }), /repository/);
  assert.throws(
    () => new ProductService({ repository: { create: () => {} } }),
    /variantService/
  );
});

test('createProduct maps a duplicate stockKeepingUnit with product-specific error', async () => {
  const { service, productRepository } = makeService();
  const originalCreate = productRepository.create.bind(productRepository);
  productRepository.create = async () => {
    const err = new Error('E11000 duplicate key error');
    err.code = 11000;
    err.keyPattern = { stockKeepingUnit: 1 };
    throw err;
  };

  await assert.rejects(
    service.createProduct(createPayload({ variants: [], stockKeepingUnit: 'ABC123' }), { role: ROLES.ADMIN }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, ERROR_CODES.PRODUCT_SKU_ALREADY_EXISTS);
      assert.equal(err.message, 'A product with this SKU already exists');
      return true;
    }
  );

  productRepository.create = originalCreate;
});
