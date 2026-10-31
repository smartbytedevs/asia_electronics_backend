'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createVariantService,
  buildAttributeKey,
  buildSkuBase,
  validateVariantInput,
  collectVariantSizes,
  assertGuideMatchesVariantSizes,
} = require('../../../../src/modules/products/variants/productVariant.service');
const { PRODUCT_LIMITS } = require('../../../../src/modules/products/variants/productVariant.constants');
const { ERROR_CODES } = require('../../../../src/constants');

const PRODUCT_ID = '507f1f77bcf86cd799439011';
const VARIANT_ID = '507f1f77bcf86cd799439031';

function createStubVariantRepository(overrides = {}) {
  const calls = [];
  const docs = [];
  const repository = {
    create: async (data, options = {}) => {
      const created = {
        _id: VARIANT_ID,
        isActive: true,
        attributes: {},
        ...data,
      };
      docs.push(created);
      return created;
    },
    existsBySku: async () => false,
    findOneByProduct: async () => null,
    findByProductAndId: async (productId, variantId) =>
      docs.find(
        (d) => String(d.productId) === String(productId) && String(d._id) === String(variantId)
      ) || null,
    updateById: async (id, update) => {
      const doc = docs.find((d) => String(d._id) === String(id));
      if (!doc) return null;
      Object.assign(doc, update);
      return doc;
    },
    findMany: async () => docs,
    ...overrides,
  };
  for (const key of Object.keys(repository)) {
    if (typeof repository[key] === 'function' && key !== 'docs') {
      const fn = repository[key];
      repository[key] = (...args) => {
        calls.push([key, ...args]);
        return fn(...args);
      };
    }
  }
  repository.calls = calls;
  repository.docs = docs;
  return repository;
}

function createStubProductRepository(overrides = {}) {
  return {
    findById: async () => null,
    ...overrides,
  };
}

function makeService({ variantRepository, productRepository } = {}) {
  const service = createVariantService({
    repository: variantRepository || createStubVariantRepository(),
    productRepository: productRepository || createStubProductRepository(),
  });
  return service;
}

function duplicateKeyError(keyPattern) {
  const err = new Error('E11000 duplicate key');
  err.code = 11000;
  err.keyPattern = keyPattern;
  return err;
}

test('buildAttributeKey is order-independent', () => {
  const a = buildAttributeKey({ size: '52', color: 'Black' });
  const b = buildAttributeKey({ color: 'Black', size: '52' });
  assert.equal(a, b, 'same attributes in any key order produce the same key');
  assert.equal(a, JSON.stringify([['color', 'Black'], ['size', '52']]));
});

test('buildAttributeKey distinguishes different attribute values', () => {
  assert.notEqual(
    buildAttributeKey({ size: '52' }),
    buildAttributeKey({ size: '54' })
  );
});

test('validateVariantInput normalizes sku (trim + uppercase) and attributes', () => {
  const value = validateVariantInput({
    sku: '  abaya-52 ',
    attributes: { size: ' 52 ', color: ' Black ' },
  });
  assert.equal(value.sku, 'ABAYA-52');
  assert.deepEqual(value.attributes, { size: '52', color: 'Black' });
});

test('validateVariantInput rejects unknown keys and Mongo operators', () => {
  assert.throws(() => validateVariantInput({ sku: 'X', stock: 5 }), (err) => {
    assert.equal(err.code, ERROR_CODES.INVALID_VARIANT);
    return true;
  });
  assert.throws(() => validateVariantInput({ sku: 'X', $set: { role: 'ADMIN' } }));
  assert.throws(() => validateVariantInput({ sku: 'X', productId: 'hack' }), (err) => {
    assert.match(err.message, /unknown field/);
    return true;
  });
});

test('validateVariantInput treats sku as optional (auto-generation)', () => {
  const value = validateVariantInput({ attributes: { size: '52' } });
  assert.equal(value.sku, undefined, 'no sku → auto-generated at creation');
  assert.equal(value.attributes.size, '52');
  const partial = validateVariantInput({ sellingPriceOverride: 1000 }, { partial: true });
  assert.equal(partial.sellingPriceOverride, 1000);
  assert.equal(partial.sku, undefined);
});

test('buildSkuBase composes slug + sorted attribute values', () => {
  const product = { slug: 'premium-abaya' };
  assert.equal(buildSkuBase(product, { color: 'Black', size: '52' }), 'PREMIUMABAYA-BLACK-52');
  assert.ok(buildSkuBase(product, { size: '52' }).length <= PRODUCT_LIMITS.SKU_MAX);
});

test('buildSkuBase falls back to a generic prefix without a product slug', () => {
  assert.equal(buildSkuBase(null, { size: '52' }), 'PROD-52');
});

test('buildSkuBase caps the base so a collision suffix still fits SKU_MAX', () => {
  const base = buildSkuBase({ slug: 'x'.repeat(100) }, {});
  assert.ok(base.length <= PRODUCT_LIMITS.SKU_MAX - 4, 'leaves room for -100 suffix');
});

test('validateVariantInput rejects invalid attributes and price overrides', () => {
  assert.throws(() => validateVariantInput({ sku: 'X', attributes: 'nope' }));
  assert.throws(() => validateVariantInput({ sku: 'X', attributes: { '1bad': 'v' } }));
  assert.throws(() => validateVariantInput({ sku: 'X', attributes: { size: '' } }));
  assert.throws(() => validateVariantInput({ sku: 'X', attributes: { size: 'v'.repeat(61) } }));
  assert.throws(() => validateVariantInput({ sku: 'X', sellingPriceOverride: 1.5 }));
  assert.throws(() => validateVariantInput({ sku: 'X', isActive: 'yes' }));
});

test('createVariant pre-checks SKU uniqueness before writing', async () => {
  const repository = createStubVariantRepository({
    existsBySku: async (sku) => sku === 'TAKEN',
  });
  const service = makeService({ variantRepository: repository });
  await assert.rejects(
    service.createVariant({ productId: PRODUCT_ID, raw: { sku: 'TAKEN' } }),
    (err) => err.code === ERROR_CODES.VARIANT_SKU_ALREADY_EXISTS
  );
  assert.equal(repository.docs.length, 0, 'nothing was written');
});

test('createVariant pre-checks duplicate attributes for the product', async () => {
  const repository = createStubVariantRepository({
    findOneByProduct: async () => ({ _id: 'other' }),
  });
  const service = makeService({ variantRepository: repository });
  await assert.rejects(
    service.createVariant({
      productId: PRODUCT_ID,
      raw: { sku: 'ABAYA-52', attributes: { size: '52' } },
    }),
    (err) => err.code === ERROR_CODES.VARIANT_DUPLICATE_ATTRIBUTES
  );
});

test('createVariant writes with the session and stores the canonical attributeKey', async () => {
  const repository = createStubVariantRepository();
  const service = makeService({ variantRepository: repository });
  const session = { id: 'session-test' };
  const created = await service.createVariant({
    productId: PRODUCT_ID,
    raw: { sku: 'ABAYA-52', attributes: { size: '52' } },
    session,
  });
  assert.equal(created.sku, 'ABAYA-52');
  assert.equal(created.attributeKey, buildAttributeKey({ size: '52' }));
  const createCall = repository.calls.find(([name]) => name === 'create');
  assert.deepEqual(createCall[2], { session });
});

test('createVariant maps a duplicate-key race to the friendly errors', async () => {
  const skuRace = createStubVariantRepository({
    create: async () => {
      throw duplicateKeyError({ sku: 1 });
    },
  });
  await assert.rejects(
    makeService({ variantRepository: skuRace }).createVariant({
      productId: PRODUCT_ID,
      raw: { sku: 'ABAYA-52' },
    }),
    (err) => err.code === ERROR_CODES.VARIANT_SKU_ALREADY_EXISTS
  );

  const attrRace = createStubVariantRepository({
    create: async () => {
      throw duplicateKeyError({ productId: 1, attributeKey: 1 });
    },
  });
  await assert.rejects(
    makeService({ variantRepository: attrRace }).createVariant({
      productId: PRODUCT_ID,
      raw: { sku: 'ABAYA-52' },
    }),
    (err) => err.code === ERROR_CODES.VARIANT_DUPLICATE_ATTRIBUTES
  );
});

test('createVariant auto-generates a SKU from the product slug + attributes', async () => {
  const repository = createStubVariantRepository();
  const productRepository = createStubProductRepository({
    findById: async () => ({ _id: PRODUCT_ID, slug: 'premium-abaya' }),
  });
  const service = makeService({ variantRepository: repository, productRepository });
  const created = await service.createVariant({
    productId: PRODUCT_ID,
    raw: { attributes: { size: '52' } },
  });
  assert.equal(created.sku, 'PREMIUMABAYA-52');
  assert.equal(created.attributeKey, buildAttributeKey({ size: '52' }));
});

test('createVariant keeps an explicitly provided SKU (legacy) without generating', async () => {
  let findByIdCalls = 0;
  const productRepository = createStubProductRepository({
    findById: async () => {
      findByIdCalls += 1;
      return { _id: PRODUCT_ID, slug: 'premium-abaya' };
    },
  });
  const service = makeService({ productRepository });
  const created = await service.createVariant({
    productId: PRODUCT_ID,
    raw: { sku: 'LEGACY-9', attributes: { size: '52' } },
  });
  assert.equal(created.sku, 'LEGACY-9');
  assert.equal(findByIdCalls, 0, 'no slug lookup when sku is explicit');
});

test('createVariant appends a collision suffix when the base SKU is taken', async () => {
  const repository = createStubVariantRepository({
    existsBySku: async (sku) => sku === 'PREMIUMABAYA-52',
  });
  const productRepository = createStubProductRepository({
    findById: async () => ({ _id: PRODUCT_ID, slug: 'premium-abaya' }),
  });
  const service = makeService({ variantRepository: repository, productRepository });
  const created = await service.createVariant({
    productId: PRODUCT_ID,
    raw: { attributes: { size: '52' } },
  });
  assert.equal(created.sku, 'PREMIUMABAYA-52-2');
});

test('createVariant retries with the next candidate on a SKU duplicate-key race', async () => {
  const repository = createStubVariantRepository();
  let createCalls = 0;
  repository.create = async (data, options = {}) => {
    createCalls += 1;
    if (createCalls === 1) {
      throw duplicateKeyError({ sku: 1 });
    }
    const created = { _id: VARIANT_ID, isActive: true, ...data };
    repository.docs.push(created);
    return created;
  };
  const productRepository = createStubProductRepository({
    findById: async () => ({ _id: PRODUCT_ID, slug: 'premium-abaya' }),
  });
  const service = makeService({ variantRepository: repository, productRepository });
  const created = await service.createVariant({
    productId: PRODUCT_ID,
    raw: { attributes: { size: '52' } },
  });
  assert.equal(createCalls, 2, 'retried exactly once');
  assert.equal(created.sku, 'PREMIUMABAYA-52-2', 'suffix advanced on retry');
});

test('updateVariant throws 404 for an unknown variant', async () => {
  const service = makeService();
  await assert.rejects(
    service.updateVariant(PRODUCT_ID, VARIANT_ID, { isActive: false }),
    (err) => err.code === ERROR_CODES.VARIANT_NOT_FOUND
  );
});

test('updateVariant rejects SKU changes (SKU is immutable)', async () => {
  const repository = createStubVariantRepository();
  await repository.create({ productId: PRODUCT_ID, sku: 'ABAYA-52', attributeKey: '[]' });
  const service = makeService({ variantRepository: repository });
  await assert.rejects(
    service.updateVariant(PRODUCT_ID, VARIANT_ID, { sku: 'NEW-SKU' }),
    (err) => {
      assert.match(err.message, /SKU cannot be changed/);
      return true;
    }
  );
});

test('updateVariant applies a partial update to existing variants', async () => {
  const repository = createStubVariantRepository();
  await repository.create({
    productId: PRODUCT_ID,
    sku: 'ABAYA-52',
    attributes: { size: '52' },
    attributeKey: 'x',
  });
  const service = makeService({ variantRepository: repository });
  const updated = await service.updateVariant(PRODUCT_ID, VARIANT_ID, { isActive: false });
  assert.equal(updated.isActive, false);
  assert.equal(updated.sku, 'ABAYA-52', 'sku preserved when not provided');
});

test('updateVariant rejects a size change that orphans measurement-guide rows', async () => {
  const repository = createStubVariantRepository();
  await repository.create({
    productId: PRODUCT_ID,
    sku: 'ABAYA-52',
    attributes: { size: '52' },
    attributeKey: buildAttributeKey({ size: '52' }),
  });
  const productRepository = createStubProductRepository({
    findById: async () => ({
      _id: PRODUCT_ID,
      measurementGuide: {
        unit: 'inch',
        fields: [{ key: 'abayaLength', label: 'Length', sortOrder: 0 }],
        sizes: [{ size: '52', measurements: { abayaLength: 50 } }],
      },
    }),
  });
  const service = makeService({ variantRepository: repository, productRepository });
  await assert.rejects(
    service.updateVariant(PRODUCT_ID, VARIANT_ID, { attributes: { color: 'Black' } }),
    (err) => err.code === ERROR_CODES.INVALID_MEASUREMENT_GUIDE
  );
});

test('listVariantsForProduct filters inactive variants by default', async () => {
  const repository = createStubVariantRepository({
    findMany: async (filter) =>
      (filter.isActive ? [{ _id: 'active' }] : [{ _id: 'active' }, { _id: 'inactive' }]),
  });
  const service = makeService({ variantRepository: repository });
  const activeOnly = await service.listVariantsForProduct(PRODUCT_ID);
  assert.equal(activeOnly.length, 1);
  const all = await service.listVariantsForProduct(PRODUCT_ID, { includeInactive: true });
  assert.equal(all.length, 2);
});

test('toSafeVariant hides purchasePriceOverride unless requested', () => {
  const service = makeService();
  const variant = {
    _id: VARIANT_ID,
    sku: 'ABAYA-52',
    attributes: { size: '52' },
    sellingPriceOverride: null,
    purchasePriceOverride: 80000,
    isActive: true,
    attributeKey: 'secret',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
  const publicSafe = service.toSafeVariant(variant);
  assert.ok(!('purchasePriceOverride' in publicSafe), 'purchase override hidden');
  const raw = JSON.stringify(publicSafe);
  assert.ok(!raw.includes('attributeKey'), 'attributeKey is internal');
  assert.ok(!raw.includes('_id'), '_id never serialized');

  const adminSafe = service.toSafeVariant(variant, { includePurchasePrice: true });
  assert.equal(adminSafe.purchasePriceOverride, 80000);
});

test('collectVariantSizes gathers distinct size attributes', () => {
  assert.deepEqual(
    collectVariantSizes([
      { attributes: { size: '52' } },
      { attributes: { size: '54' } },
      { attributes: { size: '52' } },
      { attributes: { color: 'Black' } },
      {},
    ]),
    ['52', '54']
  );
});

test('assertGuideMatchesVariantSizes requires sized variants and offered sizes', () => {
  assert.throws(
    () => assertGuideMatchesVariantSizes({ sizes: [{ size: '52' }] }, [{ attributes: {} }]),
    (err) => err.code === ERROR_CODES.INVALID_MEASUREMENT_GUIDE
  );
  assert.throws(
    () =>
      assertGuideMatchesVariantSizes(
        { sizes: [{ size: '56' }] },
        [{ attributes: { size: '52' } }]
      ),
    (err) => err.code === ERROR_CODES.INVALID_MEASUREMENT_GUIDE
  );
  assert.doesNotThrow(() =>
    assertGuideMatchesVariantSizes({ sizes: [{ size: '52' }] }, [{ attributes: { size: '52' } }])
  );
  assert.doesNotThrow(() => assertGuideMatchesVariantSizes(null, []));
});

test('assertGuideMatchesVariantSizes ignores image-only guides (no size rows)', () => {
  assert.doesNotThrow(() =>
    assertGuideMatchesVariantSizes({ imageUrl: 'https://cdn.example.com/guide.jpg' }, [])
  );
  assert.doesNotThrow(() =>
    assertGuideMatchesVariantSizes(
      { imageUrl: 'https://cdn.example.com/guide.jpg' },
      [{ attributes: { color: 'Black' } }]
    )
  );
});

test('createVariantService requires its dependencies', () => {
  assert.throws(() => createVariantService(), /repository/);
  assert.throws(
    () => createVariantService({ repository: { create: () => {} } }),
    /productRepository/
  );
});
