'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateCategoryInput } = require('../../../src/modules/categories/category.validation');
const { ERROR_CODES } = require('../../../src/constants');

function invalidCode(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    assert.equal(err.statusCode, 400);
    assert.equal(err.code, ERROR_CODES.INVALID_CATEGORY);
    return err.message;
  }
}

test('accepts a valid create payload and normalizes fields', () => {
  const { value } = validateCategoryInput({
    name: '  Abayas  ',
    slug: '  Baby   Dresses  ',
    description: '  long  ',
    image: 'https://cdn.example.com/a.jpg',
    isActive: true,
    sortOrder: 1,
  });
  assert.deepEqual(value, {
    name: 'Abayas',
    slug: 'baby-dresses',
    description: 'long',
    image: 'https://cdn.example.com/a.jpg',
    isActive: true,
    sortOrder: 1,
  });
});

test('requires name on create', () => {
  assert.ok(invalidCode(() => validateCategoryInput({})));
  assert.ok(invalidCode(() => validateCategoryInput({ name: '' })));
  assert.ok(invalidCode(() => validateCategoryInput({ name: '   ' })));
  assert.ok(invalidCode(() => validateCategoryInput({ name: 42 })));
});

test('name is optional in partial (PATCH) mode', () => {
  const { value } = validateCategoryInput({ sortOrder: 3 }, { partial: true });
  assert.deepEqual(value, { sortOrder: 3 });
});

test('rejects a name above the length limit', () => {
  const message = invalidCode(() =>
    validateCategoryInput({ name: 'a'.repeat(101) })
  );
  assert.ok(message.includes('100'));
});

test('rejects slugs that normalize to nothing or exceed the length limit', () => {
  for (const bad of ['!!!', '___', '   ']) {
    assert.ok(invalidCode(() => validateCategoryInput({ name: 'X', slug: bad })), `slug "${bad}" must be rejected`);
  }
  const message = invalidCode(() =>
    validateCategoryInput({ name: 'X', slug: `a-${'b'.repeat(130)}` })
  );
  assert.ok(message.includes('120'));
});

test('normalizes client-supplied slugs into safe URL slugs', () => {
  const cases = [
    ['UPPER', 'upper'],
    ['no spaces allowed!', 'no-spaces-allowed'],
    ['a--b', 'a-b'],
    ['-leading', 'leading'],
    ['trailing-', 'trailing'],
    ['Baby Dresses', 'baby-dresses'],
    ['baby-dresses-2', 'baby-dresses-2'],
  ];
  for (const [input, expected] of cases) {
    const { value } = validateCategoryInput({ name: 'X', slug: input });
    assert.equal(value.slug, expected, `slug "${input}" normalizes to "${expected}"`);
  }
});

test('rejects a non-boolean isActive', () => {
  for (const bad of ['true', 1, 'yes']) {
    assert.ok(invalidCode(() => validateCategoryInput({ name: 'X', isActive: bad })));
  }
});

test('accepts a boolean isActive', () => {
  const { value } = validateCategoryInput({ name: 'X', isActive: false });
  assert.equal(value.isActive, false);
});

test('rejects invalid sortOrder values', () => {
  for (const bad of ['1', 1.5, -1, 10000, NaN, null]) {
    assert.ok(invalidCode(() => validateCategoryInput({ name: 'X', sortOrder: bad })), `sortOrder ${bad} rejected`);
  }
});

test('accepts sortOrder within range', () => {
  const { value } = validateCategoryInput({ name: 'X', sortOrder: 0 });
  assert.equal(value.sortOrder, 0);
  assert.equal(validateCategoryInput({ name: 'X', sortOrder: 9999 }).value.sortOrder, 9999);
});

test('rejects a non-URL image', () => {
  for (const bad of ['not-a-url', 'ftp://x', '/relative/path.jpg']) {
    assert.ok(invalidCode(() => validateCategoryInput({ name: 'X', image: bad })));
  }
});

test('accepts null for description and image', () => {
  const { value } = validateCategoryInput({ name: 'X', description: null, image: null });
  assert.equal(value.description, null);
  assert.equal(value.image, null);
});

test('rejects unknown fields, immutable fields, and Mongo operators', () => {
  for (const bad of [
    { name: 'X', role: 'ADMIN' },
    { name: 'X', $set: { isActive: false } },
    { name: 'X', _id: 'abc' },
    { name: 'X', createdAt: '2020-01-01' },
    { name: 'X', __v: 0 },
    { name: 'X', someFutureField: 1 },
  ]) {
    assert.ok(invalidCode(() => validateCategoryInput(bad)), `payload ${JSON.stringify(bad)} rejected`);
  }
});

test('rejects non-object bodies', () => {
  for (const bad of [null, undefined, [], 'string', 42]) {
    assert.ok(invalidCode(() => validateCategoryInput(bad)));
  }
});
