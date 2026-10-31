'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Product = require('../../../src/modules/products/product.model');
const { PRODUCT_LIMITS, slugify } = require('../../../src/modules/products/product.constants');

function validProductData(overrides = {}) {
  return {
    name: 'Premium Abaya',
    slug: 'premium-abaya',
    description: 'A premium abaya',
    categoryId: '507f1f77bcf86cd799439011',
    sellingPrice: 150000,
    purchasePrice: 90000,
    discount: { type: 'percentage', value: 10 },
    featured: true,
    newArrival: false,
    bestDeal: false,
    isActive: true,
    ...overrides,
  };
}

test('creates a valid product', async () => {
  const product = new Product(validProductData());
  await product.validate();
  assert.equal(product.name, 'Premium Abaya');
  assert.equal(product.sellingPrice, 150000);
  assert.equal(product.purchasePrice, 90000);
  assert.equal(product.discount.type, 'percentage');
  assert.equal(product.discount.value, 10);
  assert.equal(product.isActive, true);
});

test('defaults flags, isActive, description, images, and measurementGuide', async () => {
  const product = new Product({
    name: 'Hijab',
    slug: 'hijab',
    categoryId: '507f1f77bcf86cd799439011',
    sellingPrice: 50000,
  });
  await product.validate();
  assert.equal(product.isActive, true);
  assert.equal(product.featured, false);
  assert.equal(product.newArrival, false);
  assert.equal(product.bestDeal, false);
  assert.equal(product.description, '');
  assert.deepEqual(product.images, []);
  assert.equal(product.measurementGuide, null);
  assert.equal(product.purchasePrice, undefined, 'purchase price is optional');
});

test('requires name, categoryId, and sellingPrice', async () => {
  const noName = new Product({
    slug: 'x',
    categoryId: '507f1f77bcf86cd799439011',
    sellingPrice: 1000,
  });
  await assert.rejects(noName.validate(), (err) => {
    assert.ok(err.errors.name, 'name validation error');
    return true;
  });

  const noCategory = new Product({ name: 'X', slug: 'x', sellingPrice: 1000 });
  await assert.rejects(noCategory.validate(), (err) => {
    assert.ok(err.errors.categoryId, 'categoryId validation error');
    return true;
  });

  const noPrice = new Product({ name: 'X', slug: 'x', categoryId: '507f1f77bcf86cd799439011' });
  await assert.rejects(noPrice.validate(), (err) => {
    assert.ok(err.errors.sellingPrice, 'sellingPrice validation error');
    return true;
  });
});

test('slug setter normalizes input through the centralized slugify', async () => {
  const product = new Product({
    name: 'Baby Dresses',
    slug: '  Baby   Dresses  ',
    categoryId: '507f1f77bcf86cd799439011',
    sellingPrice: 1000,
  });
  await product.validate();
  assert.equal(product.slug, 'baby-dresses');
  assert.equal(product.slug, slugify('Baby Dresses'));
});

test('name and description are trimmed', async () => {
  const product = new Product({
    name: '  Abaya  ',
    slug: 'abaya',
    categoryId: '507f1f77bcf86cd799439011',
    sellingPrice: 1000,
    description: '  long description  ',
  });
  await product.validate();
  assert.equal(product.name, 'Abaya');
  assert.equal(product.description, 'long description');
});

test('rejects prices outside the allowed range', async () => {
  const tooLow = new Product({
    name: 'X',
    slug: 'x',
    categoryId: '507f1f77bcf86cd799439011',
    sellingPrice: 0,
  });
  await assert.rejects(tooLow.validate(), (err) => {
    assert.ok(err.errors.sellingPrice, 'sellingPrice min error');
    return true;
  });

  const tooHigh = new Product({
    name: 'X',
    slug: 'x',
    categoryId: '507f1f77bcf86cd799439011',
    sellingPrice: PRODUCT_LIMITS.PRICE_MAX + 1,
  });
  await assert.rejects(tooHigh.validate(), (err) => {
    assert.ok(err.errors.sellingPrice, 'sellingPrice max error');
    return true;
  });
});

test('rejects a name above the length limit', async () => {
  const product = new Product({
    name: 'a'.repeat(PRODUCT_LIMITS.NAME_MAX + 1),
    slug: 'abaya',
    categoryId: '507f1f77bcf86cd799439011',
    sellingPrice: 1000,
  });
  await assert.rejects(product.validate(), (err) => {
    assert.ok(err.errors.name, 'name maxlength error');
    return true;
  });
});

test('rejects an invalid discount type', async () => {
  const product = new Product(validProductData({ discount: { type: 'free', value: 10 } }));
  await assert.rejects(product.validate(), (err) => {
    assert.ok(err.errors['discount.type'], 'discount.type validation error');
    return true;
  });
});

test('measurement guide unit is normalized to lower case and enum-controlled', async () => {
  const product = new Product(
    validProductData({
      measurementGuide: {
        unit: 'INCH',
        fields: [{ key: 'abayaLength', label: 'Length', sortOrder: 0 }],
        sizes: [{ size: '52', measurements: { abayaLength: 50 } }],
      },
    })
  );
  await product.validate();
  assert.equal(product.measurementGuide.unit, 'inch');

  const badUnit = new Product(
    validProductData({
      measurementGuide: {
        unit: 'metres',
        fields: [{ key: 'abayaLength', label: 'Length', sortOrder: 0 }],
        sizes: [{ size: '52', measurements: { abayaLength: 50 } }],
      },
    })
  );
  await assert.rejects(badUnit.validate(), (err) => {
    assert.ok(err.errors['measurementGuide.unit'], 'unit enum error');
    return true;
  });
});

test('measurement guide with only an image validates; empty legacy fields/sizes are tolerated', async () => {
  const imageOnly = new Product(
    validProductData({
      measurementGuide: { imageUrl: 'https://cdn.example.com/guide.jpg' },
    })
  );
  await imageOnly.validate();
  assert.equal(imageOnly.measurementGuide.imageUrl, 'https://cdn.example.com/guide.jpg');
  assert.equal(imageOnly.measurementGuide.unit, undefined, 'no unit on an image-only guide');

  const legacyEmpty = new Product(
    validProductData({
      measurementGuide: { unit: 'inch', fields: [], sizes: [] },
    })
  );
  await legacyEmpty.validate();
  assert.equal(legacyEmpty.measurementGuide.unit, 'inch');
});

test('legacy structured measurement guides still validate (backward compatibility)', async () => {
  const product = new Product(
    validProductData({
      measurementGuide: {
        unit: 'inch',
        fields: [{ key: 'abayaLength', label: 'Length', sortOrder: 0 }],
        sizes: [{ size: '52', measurements: { abayaLength: 50 } }],
      },
    })
  );
  await product.validate();
  assert.equal(product.measurementGuide.unit, 'inch');
  assert.equal(product.measurementGuide.sizes[0].size, '52');
});

test('images enforce url, alt, and sortOrder bounds', async () => {
  const product = new Product(
    validProductData({
      images: [
        { url: 'https://cdn.example.com/abaya-1.jpg', alt: 'Front', sortOrder: 0 },
      ],
    })
  );
  await product.validate();
  assert.equal(product.images[0].url, 'https://cdn.example.com/abaya-1.jpg');

  const missingUrl = new Product(
    validProductData({ images: [{ alt: 'Front', sortOrder: 0 }] })
  );
  await assert.rejects(missingUrl.validate(), (err) => {
    assert.ok(err.errors['images.0.url'], 'image url required error');
    return true;
  });

  const badSort = new Product(
    validProductData({
      images: [{ url: 'https://cdn.example.com/abaya-1.jpg', alt: 'Front', sortOrder: 1000 }],
    })
  );
  await assert.rejects(badSort.validate(), (err) => {
    assert.ok(err.errors['images.0.sortOrder'], 'sortOrder max error');
    return true;
  });
});

test('schema enables timestamps', () => {
  assert.equal(Product.schema.options.timestamps, true);
});

test('slug is uniquely indexed', () => {
  const indexes = Product.schema.indexes();
  const byFields = indexes.map(([fields]) => Object.keys(fields).join('+'));
  const slugIndex = indexes.find(([fields]) => Object.keys(fields).join('+') === 'slug');
  assert.ok(slugIndex, 'slug index exists');
  assert.equal(slugIndex[1].unique, true, 'slug is unique');

  assert.ok(byFields.includes('isActive+createdAt'), 'catalog ordering index exists');
  assert.ok(byFields.includes('isActive+categoryId+createdAt'), 'category browse index exists');
  assert.ok(byFields.includes('isActive+sellingPrice'), 'price ordering index exists');
});

test('schema stores NO inventory or stock fields', () => {
  const paths = Object.keys(Product.schema.paths);
  for (const forbidden of [
    'stock',
    'availableStock',
    'reservedStock',
    'inventory',
    'quantity',
    'variants',
  ]) {
    assert.ok(!paths.includes(forbidden), `product schema must not contain "${forbidden}"`);
  }
});
