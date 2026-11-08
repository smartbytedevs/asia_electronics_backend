'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  computeEffectiveSellingPrice,
  serializePublicProduct,
  serializeAdminProduct,
  serializeProductCard,
} = require('../../../src/modules/products/product.serializer');

function productDoc(overrides = {}) {
  return {
    _id: '507f1f77bcf86cd799439011',
    name: 'Premium Abaya',
    slug: 'premium-abaya',
    description: 'A premium abaya',
    categoryId: '507f1f77bcf86cd799439020',
    images: [
      { url: 'https://cdn.example.com/a.jpg', alt: 'Front', sortOrder: 0 },
    ],
    sellingPrice: 150000,
    purchasePrice: 90000,
    discount: { type: 'percentage', value: 10 },
    featured: true,
    newArrival: false,
    bestDeal: false,
    isActive: true,
    measurementGuide: {
      unit: 'inch',
      fields: [{ key: 'abayaLength', label: 'Length', sortOrder: 0 }],
      sizes: [{ size: '52', measurements: { abayaLength: 50 } }],
      imageUrl: 'https://cdn.example.com/guide.jpg',
    },
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function variantDoc(overrides = {}) {
  return {
    _id: '507f1f77bcf86cd799439031',
    productId: '507f1f77bcf86cd799439011',
    sku: 'ABAYA-52',
    attributes: { size: '52' },
    sellingPriceOverride: null,
    purchasePriceOverride: 80000,
    isActive: true,
    ...overrides,
  };
}

const category = {
  _id: '507f1f77bcf86cd799439020',
  name: 'Abayas',
  slug: 'abayas',
  isActive: true,
};

test('computeEffectiveSellingPrice: percentage and fixed discounts', () => {
  assert.equal(computeEffectiveSellingPrice(150000, { type: 'percentage', value: 10 }), 135000);
  assert.equal(computeEffectiveSellingPrice(150000, { type: 'fixed', value: 5000 }), 145000);
  assert.equal(computeEffectiveSellingPrice(150000, null), 150000);
  assert.equal(computeEffectiveSellingPrice(150000, undefined), 150000);
});

test('public serialization never includes purchase price', () => {
  const safe = serializePublicProduct(productDoc(), [variantDoc()], category);
  assert.equal(safe.id, '507f1f77bcf86cd799439011');
  assert.equal(safe.sellingPrice, 150000);
  assert.equal(safe.effectiveSellingPrice, 135000);
  assert.ok(!('purchasePrice' in safe), 'purchasePrice absent for public');
  assert.ok(!('purchasePriceOverride' in safe.variants[0]), 'purchasePriceOverride absent');
  assert.equal(safe.variants[0].effectiveSellingPrice, 135000);
  const raw = JSON.stringify(safe);
  assert.ok(!raw.includes('purchase'), 'no purchase cost anywhere in the public payload');
});

test('variant without override uses the product default price', () => {
  const safe = serializePublicProduct(
    productDoc(),
    [variantDoc({ sellingPriceOverride: undefined, purchasePriceOverride: undefined })],
    category
  );
  assert.equal(safe.variants[0].sellingPrice, 150000);
  assert.equal(safe.variants[0].effectiveSellingPrice, 135000);
});

test('variant with an override prices itself independently of the product', () => {
  const safe = serializePublicProduct(
    productDoc(),
    [variantDoc({ sellingPriceOverride: 160000, purchasePriceOverride: 90000 })],
    category
  );
  assert.equal(safe.variants[0].sellingPrice, 160000);
  assert.equal(safe.variants[0].effectiveSellingPrice, 144000, 'discount applies to the override');
});

test('admin serialization includes purchase price and overrides', () => {
  const admin = serializeAdminProduct(productDoc(), [variantDoc()], category);
  assert.equal(admin.purchasePrice, 90000);
  assert.equal(admin.variants[0].purchasePriceOverride, 80000);
});

test('serialization emits safe IDs and ISO dates, never _id/__v', () => {
  const safe = serializePublicProduct(productDoc(), [variantDoc()], category);
  const raw = JSON.stringify(safe);
  assert.ok(!raw.includes('_id'), 'no _id in the payload');
  assert.ok(!raw.includes('__v'), 'no __v in the payload');
  assert.ok(!raw.includes('attributeKey'), 'attributeKey is internal');
  assert.equal(safe.createdAt, '2026-01-01T00:00:00.000Z');
  assert.equal(safe.variants[0].id, '507f1f77bcf86cd799439031');
  assert.equal(safe.category.id, '507f1f77bcf86cd799439020');
});

test('measurement guide is serialized as a clean object with imageUrl', () => {
  const safe = serializePublicProduct(productDoc(), [variantDoc()], category);
  assert.equal(safe.measurementGuide.unit, 'inch');
  assert.deepEqual(safe.measurementGuide.fields, [
    { key: 'abayaLength', label: 'Length', sortOrder: 0 },
  ]);
  assert.deepEqual(safe.measurementGuide.sizes, [
    { size: '52', measurements: { abayaLength: 50 } },
  ]);
  assert.equal(safe.measurementGuide.imageUrl, 'https://cdn.example.com/guide.jpg');
});

test('image-only measurement guide is serialized as just the image URL', () => {
  const safe = serializePublicProduct(
    productDoc({ measurementGuide: { imageUrl: 'https://cdn.example.com/guide.jpg' } }),
    [],
    category
  );
  assert.deepEqual(safe.measurementGuide, { imageUrl: 'https://cdn.example.com/guide.jpg' });
  assert.ok(!('unit' in safe.measurementGuide), 'no unit on an image-only guide');
});

test('a null or absent measurement guide serializes to null without crashing', () => {
  const none = serializePublicProduct(productDoc({ measurementGuide: null }), [], category);
  assert.equal(none.measurementGuide, null);

  const undefinedGuide = serializePublicProduct(
    { ...productDoc(), measurementGuide: undefined },
    [],
    category
  );
  assert.equal(undefinedGuide.measurementGuide, null);
});

test('product card carries prices, flags, category, and active variants but no guide', () => {
  const card = serializeProductCard(productDoc(), category);
  assert.equal(card.id, '507f1f77bcf86cd799439011');
  assert.equal(card.effectiveSellingPrice, 135000);
  assert.equal(card.category.id, '507f1f77bcf86cd799439020');
  assert.deepEqual(card.variants, [], 'no variants attached when none are provided');
  assert.ok(!('measurementGuide' in card), 'card has no measurement guide');
  assert.ok(!('purchasePrice' in card), 'card has no purchase price');
});

test('product card attaches active variants for the storefront size picker', () => {
  const variants = [
    {
      _id: '507f1f77bcf86cd799439030',
      sku: 'SPEAKER-BLACK',
      attributes: { color: 'Black' },
      isActive: true,
    },
    {
      _id: '507f1f77bcf86cd799439031',
      sku: 'SPEAKER-RETIRED',
      attributes: { color: 'Red' },
      isActive: false,
    },
  ];
  const card = serializeProductCard(productDoc(), category, variants);
  assert.equal(card.variants.length, 1);
  assert.equal(card.variants[0].id, '507f1f77bcf86cd799439030');
  assert.deepEqual(card.variants[0].attributes, { color: 'Black' });
  assert.ok(!('purchasePriceOverride' in card.variants[0]));
});

test('base product serializer includes electronics fields with defaults', () => {
  const product = {
    _id: '507f1f77bcf86cd799439011',
    name: 'Speaker',
    slug: 'speaker',
    categoryId: '507f1f77bcf86cd799439020',
    images: [{ url: 'https://cdn.example.com/s.jpg', alt: 'S', sortOrder: 0 }],
    sellingPrice: 50000,
    discount: null,
    featured: false,
    newArrival: true,
    bestDeal: false,
    isActive: true,
  };
  const out = serializePublicProduct(product, [], category);
  assert.equal(out.brand, '');
  assert.equal(out.modelNumber, '');
  assert.equal(out.warrantyPeriod, null);
  assert.deepEqual(out.specifications, {});
  assert.equal(out.stockKeepingUnit, null);
});

test('base product serializer exposes electronics fields when present', () => {
  const product = {
    _id: '507f1f77bcf86cd799439011',
    name: 'Trimmer',
    slug: 'trimmer',
    categoryId: '507f1f77bcf86cd799439020',
    images: [],
    sellingPrice: 15000,
    discount: null,
    featured: false,
    newArrival: false,
    bestDeal: false,
    isActive: true,
    brand: 'Philips',
    modelNumber: 'BT-123',
    warrantyPeriod: 12,
    specifications: { power: '5W', battery: '90min' },
    stockKeepingUnit: 'TRM-BT123',
  };
  const out = serializePublicProduct(product, [], null);
  assert.equal(out.brand, 'Philips');
  assert.equal(out.modelNumber, 'BT-123');
  assert.equal(out.warrantyPeriod, 12);
  assert.deepEqual(out.specifications, { power: '5W', battery: '90min' });
  assert.equal(out.stockKeepingUnit, 'TRM-BT123');
});

test('product card serializer includes electronics fields with defaults', () => {
  const product = productDoc();
  const card = serializeProductCard(product, null);
  assert.equal(card.brand, '');
  assert.equal(card.modelNumber, '');
  assert.equal(card.warrantyPeriod, null);
  assert.deepEqual(card.specifications, {});
  assert.equal(card.stockKeepingUnit, null);
});
