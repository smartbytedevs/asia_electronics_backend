'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateProductInput,
  assertDiscountWithinPrice,
} = require('../../../src/modules/products/product.validation');
const { ERROR_CODES } = require('../../../src/constants');

const CATEGORY_ID = '507f1f77bcf86cd799439011';

function validInput(overrides = {}) {
  return {
    name: 'Premium Abaya',
    categoryId: CATEGORY_ID,
    sellingPrice: 150000,
    variants: [{ sku: 'ABAYA-52', attributes: { size: '52' } }],
    ...overrides,
  };
}

function assertInvalid(fn, code = ERROR_CODES.INVALID_PRODUCT) {
  assert.throws(fn, (err) => {
    assert.equal(err.statusCode, 400);
    assert.equal(err.code, code);
    return true;
  });
}

test('validates a complete product payload', () => {
  const { value, variants } = validateProductInput(validInput());
  assert.equal(value.name, 'Premium Abaya');
  assert.equal(value.categoryId, CATEGORY_ID);
  assert.equal(value.sellingPrice, 150000);
  assert.equal(variants.length, 1);
});

test('rejects a non-object body', () => {
  assertInvalid(() => validateProductInput(null));
  assertInvalid(() => validateProductInput('nope'));
  assertInvalid(() => validateProductInput([1, 2]));
});

test('rejects Mongo operators and unknown keys', () => {
  assertInvalid(() => validateProductInput({ ...validInput(), $set: { role: 'ADMIN' } }));
  assertInvalid(() => validateProductInput({ ...validInput(), _id: 'hack' }));
  assertInvalid(() => validateProductInput({ ...validInput(), createdAt: '2020-01-01' }));
  assertInvalid(() => validateProductInput({ ...validInput(), stock: 5 }));
  assertInvalid(() => validateProductInput({ ...validInput(), price: 5 }));
});

test('create requires name, categoryId, and sellingPrice', () => {
  for (const partial of [
    { categoryId: CATEGORY_ID, sellingPrice: 1000, variants: [{ sku: 'X' }] },
    { name: 'X', sellingPrice: 1000, variants: [{ sku: 'X' }] },
    { name: 'X', categoryId: CATEGORY_ID, variants: [{ sku: 'X' }] },
  ]) {
    assertInvalid(() => validateProductInput(partial));
  }
  const { variants } = validateProductInput({ name: 'X', categoryId: CATEGORY_ID, sellingPrice: 1000 });
  assert.equal(variants, undefined, 'variants is optional');
});

test('variants are optional: omitted, null, or empty array all validate', () => {
  const omitted = validateProductInput({ name: 'X', categoryId: CATEGORY_ID, sellingPrice: 1000 });
  assert.equal(omitted.variants, undefined);

  const nullVariants = validateProductInput(
    validInput({ variants: null })
  );
  assert.equal(nullVariants.variants, undefined);

  const empty = validateProductInput(validInput({ variants: [] }));
  assert.deepEqual(empty.variants, [], 'empty array is allowed and preserved');
});

test('variants rejects a non-array value and more than the maximum', () => {
  assertInvalid(() => validateProductInput(validInput({ variants: 'nope' })));
  assertInvalid(() => validateProductInput(validInput({ variants: { sku: 'X' } })));
  const tooMany = validInput({
    variants: Array.from({ length: 51 }, (_, i) => ({ sku: `SKU-${i}` })),
  });
  assertInvalid(() => validateProductInput(tooMany));
});

test('normalizes slug through slugify and enforces its length', () => {
  const { value } = validateProductInput(validInput({ slug: '  Premium   Abayas ' }));
  assert.equal(value.slug, 'premium-abayas');
  assertInvalid(() => validateProductInput(validInput({ slug: '!!' })));
  assertInvalid(() => validateProductInput(validInput({ slug: 'a'.repeat(221) })));
});

test('prices must be integers within the minor-unit range', () => {
  assertInvalid(() => validateProductInput(validInput({ sellingPrice: 1500.5 })));
  assertInvalid(() => validateProductInput(validInput({ sellingPrice: 0 })));
  assertInvalid(() => validateProductInput(validInput({ sellingPrice: 100_000_001 })));
  assertInvalid(() => validateProductInput(validInput({ purchasePrice: '90000' })));
});

test('categoryId must be a 24-character hex ObjectId', () => {
  assertInvalid(() => validateProductInput(validInput({ categoryId: 'not-an-id' })));
});

test('discount accepts percentage and fixed types with bounds', () => {
  const percentage = validateProductInput(
    validInput({ discount: { type: 'percentage', value: 10 } })
  );
  assert.deepEqual(percentage.value.discount, { type: 'percentage', value: 10 });

  const fixed = validateProductInput(validInput({ discount: { type: 'fixed', value: 5000 } }));
  assert.deepEqual(fixed.value.discount, { type: 'fixed', value: 5000 });

  assertInvalid(() => validateProductInput(validInput({ discount: { type: 'percentage', value: 0 } })));
  assertInvalid(() => validateProductInput(validInput({ discount: { type: 'percentage', value: 101 } })));
  assertInvalid(() => validateProductInput(validInput({ discount: { type: 'fixed', value: 0.5 } })));
  assertInvalid(() => validateProductInput(validInput({ discount: { type: 'free', value: 1 } })));
});

test('flags and isActive must be booleans', () => {
  assertInvalid(() => validateProductInput(validInput({ featured: 'yes' })));
  assertInvalid(() => validateProductInput(validInput({ bestDeal: 1 })));
  assertInvalid(() => validateProductInput(validInput({ isActive: 'false' })));
});

test('measurement guide with an image only validates and normalizes', () => {
  const { value } = validateProductInput(
    validInput({ measurementGuide: { imageUrl: 'https://cdn.example.com/guide.jpg' } })
  );
  assert.deepEqual(value.measurementGuide, { imageUrl: 'https://cdn.example.com/guide.jpg' });
});

test('measurement guide is optional; empty object or null means no guide', () => {
  const omitted = validateProductInput(validInput());
  assert.equal(omitted.value.measurementGuide, undefined, 'omitted guide is not set');

  const empty = validateProductInput(validInput({ measurementGuide: {} }));
  assert.equal(empty.value.measurementGuide, null, 'empty guide object means no guide');

  const nullGuide = validateProductInput(validInput({ measurementGuide: null }));
  assert.equal(nullGuide.value.measurementGuide, null);
});

test('measurement guide rejects non-object values and invalid image URLs', () => {
  assertInvalid(
    () => validateProductInput(validInput({ measurementGuide: 'nope' })),
    ERROR_CODES.INVALID_MEASUREMENT_GUIDE
  );
  assertInvalid(
    () => validateProductInput(validInput({ measurementGuide: [] })),
    ERROR_CODES.INVALID_MEASUREMENT_GUIDE
  );
  assertInvalid(
    () => validateProductInput(validInput({ measurementGuide: { imageUrl: 'not-a-url' } })),
    ERROR_CODES.INVALID_MEASUREMENT_GUIDE
  );
  assertInvalid(
    () =>
      validateProductInput(
        validInput({
          measurementGuide: { imageUrl: `https://example.com/${'a'.repeat(500)}` },
        })
      ),
    ERROR_CODES.INVALID_MEASUREMENT_GUIDE
  );
});

test('measurement guide rejects legacy structured fields (unit/fields/sizes)', () => {
  assertInvalid(
    () =>
      validateProductInput(
        validInput({
          measurementGuide: {
            unit: 'inch',
            fields: [{ key: 'abayaLength', label: 'Length', sortOrder: 0 }],
            sizes: [{ size: '52', measurements: { abayaLength: 50 } }],
          },
        })
      ),
    ERROR_CODES.INVALID_MEASUREMENT_GUIDE
  );
  assertInvalid(
    () => validateProductInput(validInput({ measurementGuide: { unit: 'inch' } })),
    ERROR_CODES.INVALID_MEASUREMENT_GUIDE
  );
  assertInvalid(
    () =>
      validateProductInput(
        validInput({ measurementGuide: { imageUrl: null, fields: [] } })
      ),
    ERROR_CODES.INVALID_MEASUREMENT_GUIDE
  );
});

test('partial mode makes every product field optional but still rejects unknowns', () => {
  const { value, variants } = validateProductInput({ sellingPrice: 1000 }, { partial: true });
  assert.equal(value.sellingPrice, 1000);
  assert.equal(variants, undefined);
  assertInvalid(() => validateProductInput({ stock: 1 }, { partial: true }));
});

test('assertDiscountWithinPrice rejects a fixed discount above the selling price', () => {
  assertInvalid(() => assertDiscountWithinPrice({ type: 'fixed', value: 2000 }, 1500));
  assert.doesNotThrow(() => assertDiscountWithinPrice({ type: 'fixed', value: 1500 }, 1500));
  assert.doesNotThrow(() => assertDiscountWithinPrice({ type: 'percentage', value: 90 }, 1500));
  assert.doesNotThrow(() => assertDiscountWithinPrice(null, 1500));
});

test('electronics fields: brand and modelNumber are accepted and normalized', () => {
  const { value } = validateProductInput(
    validInput({ brand: '  Sony  ', modelNumber: '  XYZ-123  ' })
  );
  assert.equal(value.brand, 'Sony');
  assert.equal(value.modelNumber, 'XYZ-123');
});

test('electronics fields: brand/modelNumber optional and empty strings become empty', () => {
  const omitted = validateProductInput(validInput());
  assert.equal(omitted.value.brand, undefined);
  assert.equal(omitted.value.modelNumber, undefined);

  const empty = validateProductInput(validInput({ brand: '', modelNumber: null }));
  assert.equal(empty.value.brand, '');
  assert.equal(empty.value.modelNumber, '');
});

test('warrantyPeriod accepts 0 and 120, rejects invalid values', () => {
  const zero = validateProductInput(validInput({ warrantyPeriod: 0 }));
  assert.equal(zero.value.warrantyPeriod, 0);

  const max = validateProductInput(validInput({ warrantyPeriod: 120 }));
  assert.equal(max.value.warrantyPeriod, 120);

  assertInvalid(() => validateProductInput(validInput({ warrantyPeriod: -1 })));
  assertInvalid(() => validateProductInput(validInput({ warrantyPeriod: 121 })));
  assertInvalid(() => validateProductInput(validInput({ warrantyPeriod: 12.5 })));
  assertInvalid(() => validateProductInput(validInput({ warrantyPeriod: '12' })));
});

test('specifications accepts plain objects, rejects arrays and invalid values', () => {
  const obj = validateProductInput(validInput({ specifications: { wattage: 50, color: 'black' } }));
  assert.deepEqual(obj.value.specifications, { wattage: 50, color: 'black' });

  const empty = validateProductInput(validInput({ specifications: {} }));
  assert.deepEqual(empty.value.specifications, {});

  assertInvalid(() => validateProductInput(validInput({ specifications: [] })));
  assertInvalid(() => validateProductInput(validInput({ specifications: 'nope' })));
  assertInvalid(() => validateProductInput(validInput({ specifications: 123 })));
});

test('stockKeepingUnit normalizes to uppercase and validates', () => {
  const { value } = validateProductInput(validInput({ stockKeepingUnit: '  ab12-cd_34  ' }));
  assert.equal(value.stockKeepingUnit, 'AB12-CD_34');

  const omitted = validateProductInput(validInput());
  assert.equal(omitted.value.stockKeepingUnit, undefined);

  const empty = validateProductInput(validInput({ stockKeepingUnit: '' }));
  assert.equal(empty.value.stockKeepingUnit, undefined);

  assertInvalid(() => validateProductInput(validInput({ stockKeepingUnit: 'bad sku!' })));
  assertInvalid(() => validateProductInput(validInput({ stockKeepingUnit: '-bad' })));
  assertInvalid(() => validateProductInput(validInput({ stockKeepingUnit: 'a'.repeat(65) })));
});

test('electronics fields work in partial update mode', () => {
  const { value } = validateProductInput({ brand: 'Samsung', warrantyPeriod: 12 }, { partial: true });
  assert.equal(value.brand, 'Samsung');
  assert.equal(value.warrantyPeriod, 12);
});
