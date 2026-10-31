'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Category = require('../../../src/modules/categories/category.model');
const { slugify, CATEGORY_LIMITS } = require('../../../src/modules/categories/category.constants');

function validCategoryData() {
  return {
    name: 'Abayas',
    slug: 'abayas',
    description: 'Abayas and kimonos',
    image: 'https://cdn.example.com/abayas.jpg',
    isActive: true,
    sortOrder: 1,
  };
}

test('creates a valid category', async () => {
  const category = new Category(validCategoryData());
  await category.validate();
  assert.equal(category.name, 'Abayas');
  assert.equal(category.slug, 'abayas');
  assert.equal(category.isActive, true);
  assert.equal(category.sortOrder, 1);
});

test('defaults isActive to true and sortOrder to 0', async () => {
  const category = new Category({ name: 'Jewelry', slug: 'jewelry' });
  await category.validate();
  assert.equal(category.isActive, true);
  assert.equal(category.sortOrder, 0);
});

test('requires name', async () => {
  const category = new Category({ slug: 'jewelry' });
  await assert.rejects(category.validate(), (err) => {
    assert.ok(err.errors && err.errors.name, 'name validation error');
    return true;
  });
});

test('rejects empty name', async () => {
  const category = new Category({ name: '   ', slug: 'jewelry' });
  await assert.rejects(category.validate(), (err) => {
    assert.ok(err.errors && err.errors.name, 'name validation error');
    return true;
  });
});

test('requires slug', async () => {
  const category = new Category({ name: 'Jewelry' });
  await assert.rejects(category.validate(), (err) => {
    assert.ok(err.errors && err.errors.slug, 'slug validation error');
    return true;
  });
});

test('slug setter normalizes client input through the single slugify implementation', async () => {
  const category = new Category({ name: 'Baby Dresses', slug: '  Baby   Dresses  ' });
  await category.validate();
  assert.equal(category.slug, 'baby-dresses');
  assert.equal(category.slug, slugify('Baby Dresses'), 'uses the centralized slugify');
});

test('name and description are trimmed', async () => {
  const category = new Category({
    name: '  Abayas  ',
    slug: 'abayas',
    description: '  long description  ',
  });
  await category.validate();
  assert.equal(category.name, 'Abayas');
  assert.equal(category.description, 'long description');
});

test('rejects name above the length limit', async () => {
  const category = new Category({
    name: 'a'.repeat(CATEGORY_LIMITS.NAME_MAX + 1),
    slug: 'abayas',
  });
  await assert.rejects(category.validate(), (err) => {
    assert.equal(err.errors.name.kind, 'maxlength');
    return true;
  });
});

test('rejects sortOrder outside the allowed range', async () => {
  const category = new Category({ name: 'Jewelry', slug: 'jewelry', sortOrder: -5 });
  await assert.rejects(category.validate(), (err) => {
    assert.equal(err.errors.sortOrder.kind, 'min');
    return true;
  });
});

test('schema enables timestamps', () => {
  assert.equal(Category.schema.options.timestamps, true);
});

test('slug has a unique index (final consistency layer)', () => {
  const indexes = Category.schema.indexes();
  const byField = {};
  for (const [fields, options] of indexes) {
    byField[Object.keys(fields)[0]] = options;
  }
  assert.equal(byField.slug.unique, true, 'slug is unique');
  assert.equal(byField.name.unique, true, 'name is unique');
  assert.deepEqual(
    byField.isActive,
    {},
    'compound isActive/sortOrder/createdAt index exists for catalog ordering'
  );
});

test('schema stores NO product, variant, or stock fields', () => {
  const paths = Object.keys(Category.schema.paths);
  for (const forbidden of [
    'stock',
    'price',
    'size',
    'color',
    'material',
    'fabric',
    'discount',
    'variant',
    'variants',
    'inventory',
  ]) {
    assert.ok(!paths.includes(forbidden), `category schema must not contain "${forbidden}"`);
  }
});
