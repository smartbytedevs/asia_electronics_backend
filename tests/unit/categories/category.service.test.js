'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { CategoryService } = require('../../../src/modules/categories/category.service');
const { ERROR_CODES } = require('../../../src/constants');

const ID_A = '507f1f77bcf86cd799439011';
const ID_B = '507f1f77bcf86cd799439012';

function categoryDoc(overrides = {}) {
  return {
    _id: ID_A,
    name: 'Abayas',
    slug: 'abayas',
    description: null,
    image: null,
    isActive: true,
    sortOrder: 1,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function createStubRepository(overrides = {}) {
  const calls = [];
  const state = {
    findOne: async () => null,
    findById: async () => null,
    findMany: async () => [],
    create: async (data) => categoryDoc(data),
    updateById: async (id, update) => categoryDoc({ _id: id, ...update }),
    findBySlug: async () => null,
    existsBySlug: async () => false,
    ...overrides,
  };
  const repository = {};
  for (const [key, fn] of Object.entries(state)) {
    repository[key] = (...args) => {
      calls.push([key, ...args]);
      return fn(...args);
    };
  }
  repository.calls = calls;
  return repository;
}

function duplicateKeyError(keyPattern) {
  const err = new Error('E11000 duplicate key');
  err.code = 11000;
  err.keyPattern = keyPattern;
  return err;
}

function makeService(repo) {
  return new CategoryService({ repository: repo });
}

test('createCategory with no slug derives a unique slug from the name', async () => {
  const repository = createStubRepository();
  const service = makeService(repository);
  const result = await service.createCategory({ name: 'Baby Dresses' });

  const createCall = repository.calls.find(([name]) => name === 'create');
  assert.ok(createCall, 'creates via the repository');
  assert.equal(createCall[1].slug, 'baby-dresses', 'slug derived deterministically');
  assert.equal(createCall[1].isActive, undefined, 'isActive left to the Mongoose default');
  assert.equal(createCall[1].sortOrder, undefined, 'sortOrder left to the Mongoose default');
  assert.equal(result.id, ID_A);
});

test('createCategory respects an explicit client slug', async () => {
  const repository = createStubRepository();
  const service = makeService(repository);
  await service.createCategory({ name: 'Abayas', slug: 'our-abayas' });
  const createCall = repository.calls.find(([name]) => name === 'create');
  assert.equal(createCall[1].slug, 'our-abayas');
});

test('createCategory rejects an explicit slug that collides', async () => {
  const repository = createStubRepository({ existsBySlug: async () => true });
  const service = makeService(repository);
  await assert.rejects(
    service.createCategory({ name: 'Jewelry', slug: 'abayas' }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, ERROR_CODES.CATEGORY_SLUG_ALREADY_EXISTS);
      return true;
    }
  );
});

test('createCategory makes a name-derived slug unique with a numeric suffix', async () => {
  const taken = new Set(['abayas']);
  const repository = createStubRepository({
    existsBySlug: async (slug) => taken.has(slug),
  });
  const service = makeService(repository);
  await service.createCategory({ name: 'Abayas' });
  const createCall = repository.calls.find(([name]) => name === 'create');
  assert.equal(createCall[1].slug, 'abayas-2', 'collision handled with a deterministic suffix');
});

test('createCategory rejects a duplicate name (friendly pre-check)', async () => {
  const repository = createStubRepository({
    findOne: async (filter) => (filter.name === 'Abayas' ? categoryDoc() : null),
  });
  const service = makeService(repository);
  await assert.rejects(
    service.createCategory({ name: 'Abayas' }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, ERROR_CODES.CATEGORY_ALREADY_EXISTS);
      return true;
    }
  );
});

test('createCategory maps a duplicate-key race to the right error', async () => {
  const repository = createStubRepository({
    create: async () => {
      throw duplicateKeyError({ slug: 1 });
    },
  });
  const service = makeService(repository);
  await assert.rejects(
    service.createCategory({ name: 'Jewelry' }),
    (err) => err.code === ERROR_CODES.CATEGORY_SLUG_ALREADY_EXISTS
  );

  const nameRepo = createStubRepository({
    create: async () => {
      throw duplicateKeyError({ name: 1 });
    },
  });
  const nameService = makeService(nameRepo);
  await assert.rejects(
    nameService.createCategory({ name: 'Jewelry' }),
    (err) => err.code === ERROR_CODES.CATEGORY_ALREADY_EXISTS
  );
});

test('createCategory rejects unknown or operator fields before touching the repository', async () => {
  const repository = createStubRepository();
  const service = makeService(repository);
  for (const bad of [
    { name: 'X', $set: { role: 'ADMIN' } },
    { name: 'X', role: 'ADMIN' },
    { name: 'X', _id: 'hack' },
    { name: 'X', createdAt: '2020-01-01' },
  ]) {
    await assert.rejects(service.createCategory(bad), (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, ERROR_CODES.INVALID_CATEGORY);
      return true;
    });
  }
  const createCalls = repository.calls.filter(([name]) => name === 'create');
  assert.equal(createCalls.length, 0, 'no create reaches the repository');
});

test('getCategoryById returns a safe category for an active category', async () => {
  const repository = createStubRepository({
    findById: async (id) => (String(id) === ID_A ? categoryDoc() : null),
  });
  const service = makeService(repository);
  const result = await service.getCategoryById(ID_A);
  assert.equal(result.id, ID_A);
  assert.equal(result.name, 'Abayas');
});

test('getCategoryById throws CATEGORY_NOT_FOUND for missing or inactive categories', async () => {
  const inactiveRepo = createStubRepository({
    findById: async () => categoryDoc({ isActive: false }),
  });
  const inactiveService = makeService(inactiveRepo);
  await assert.rejects(
    inactiveService.getCategoryById(ID_A),
    (err) => {
      assert.equal(err.statusCode, 404);
      assert.equal(err.code, ERROR_CODES.CATEGORY_NOT_FOUND);
      return true;
    }
  );

  const missingService = makeService(createStubRepository());
  await assert.rejects(
    missingService.getCategoryById(ID_A),
    (err) => err.code === ERROR_CODES.CATEGORY_NOT_FOUND
  );
});

test('getCategoryById rejects a malformed object id with 400', async () => {
  const repository = createStubRepository();
  const service = makeService(repository);
  await assert.rejects(service.getCategoryById('not-an-id'), (err) => {
    assert.equal(err.statusCode, 400);
    assert.equal(err.code, ERROR_CODES.INVALID_CATEGORY);
    return true;
  });
});

test('getCategoryBySlug normalizes the slug and returns an active category', async () => {
  const repository = createStubRepository({
    findBySlug: async (slug) => (slug === 'baby-dresses' ? categoryDoc({ slug: 'baby-dresses' }) : null),
  });
  const service = makeService(repository);
  const result = await service.getCategoryBySlug('  Baby Dresses ');
  assert.equal(result.slug, 'baby-dresses');
});

test('getCategoryBySlug throws 404 for inactive or unknown slugs', async () => {
  const inactiveService = makeService(
    createStubRepository({ findBySlug: async () => categoryDoc({ isActive: false }) })
  );
  await assert.rejects(inactiveService.getCategoryBySlug('abayas'), (err) => err.statusCode === 404);

  const missingService = makeService(createStubRepository());
  await assert.rejects(missingService.getCategoryBySlug('abayas'), (err) => err.statusCode === 404);

  const badSlugService = makeService(createStubRepository());
  await assert.rejects(badSlugService.getCategoryBySlug('!!!'), (err) => err.statusCode === 400);
});

test('listCategories filters ACTIVE only with deterministic ordering', async () => {
  const repository = createStubRepository({
    findMany: async (filter, options) => {
      assert.deepEqual(filter, { isActive: true });
      assert.deepEqual(options.sort, { sortOrder: 1, createdAt: 1 });
      return [categoryDoc({ _id: ID_B }), categoryDoc()];
    },
  });
  const service = makeService(repository);
  const result = await service.listCategories();
  assert.equal(result.length, 2);
  assert.equal(result[0].id, ID_B);
});

test('updateCategory applies a partial PATCH without erasing omitted fields', async () => {
  const existing = categoryDoc({ name: 'Abayas', slug: 'abayas', description: 'keep me' });
  const repository = createStubRepository({
    findById: async () => existing,
    updateById: async (id, update) => ({ ...existing, ...update }),
  });
  const service = makeService(repository);
  const result = await service.updateCategory(ID_A, { sortOrder: 5 });

  const updateCall = repository.calls.find(([name]) => name === 'updateById');
  assert.deepEqual(updateCall[2], { sortOrder: 5 }, 'only the provided field changes');
  assert.equal(result.description, 'keep me', 'omitted fields are preserved');
  assert.equal(result.sortOrder, 5);
});

test('updateCategory deactivates a category via isActive:false', async () => {
  const existing = categoryDoc();
  const repository = createStubRepository({
    findById: async () => existing,
    updateById: async (id, update) => ({ ...existing, ...update }),
  });
  const service = makeService(repository);
  const result = await service.updateCategory(ID_A, { isActive: false });
  assert.equal(result.isActive, false);
});

test('updateCategory rejects a slug already used by another category', async () => {
  const existing = categoryDoc();
  const repository = createStubRepository({
    findById: async () => existing,
    findBySlug: async () => categoryDoc({ _id: ID_B, slug: 'jewelry' }),
  });
  const service = makeService(repository);
  await assert.rejects(
    service.updateCategory(ID_A, { slug: 'jewelry' }),
    (err) => err.code === ERROR_CODES.CATEGORY_SLUG_ALREADY_EXISTS
  );
});

test('updateCategory allows keeping the current slug (self-reference is not a collision)', async () => {
  const existing = categoryDoc();
  const repository = createStubRepository({
    findById: async () => existing,
    findBySlug: async () => existing,
    updateById: async (id, update) => ({ ...existing, ...update }),
  });
  const service = makeService(repository);
  const result = await service.updateCategory(ID_A, { slug: 'abayas' });
  assert.equal(result.slug, 'abayas');
});

test('updateCategory rejects immutable, unknown, and operator fields', async () => {
  const existing = categoryDoc();
  const repository = createStubRepository({ findById: async () => existing });
  const service = makeService(repository);
  for (const bad of [
    { _id: 'hack' },
    { createdAt: '2020-01-01' },
    { updatedAt: '2020-01-01' },
    { __v: 0 },
    { $set: { isActive: false } },
    { role: 'ADMIN' },
  ]) {
    await assert.rejects(service.updateCategory(ID_A, bad), (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, ERROR_CODES.INVALID_CATEGORY);
      return true;
    });
  }
  const updateCalls = repository.calls.filter(([name]) => name === 'updateById');
  assert.equal(updateCalls.length, 0);
});

test('updateCategory throws CATEGORY_NOT_FOUND for unknown ids', async () => {
  const service = makeService(createStubRepository());
  await assert.rejects(
    service.updateCategory(ID_A, { name: 'X' }),
    (err) => err.code === ERROR_CODES.CATEGORY_NOT_FOUND
  );
});

test('updateCategory rejects an empty update', async () => {
  const repository = createStubRepository({ findById: async () => categoryDoc() });
  const service = makeService(repository);
  await assert.rejects(
    service.updateCategory(ID_A, {}),
    (err) => err.code === ERROR_CODES.INVALID_CATEGORY
  );
});

test('toSafeCategory never exposes internal fields', () => {
  const service = makeService(createStubRepository());
  const safe = service.toSafeCategory(categoryDoc());
  assert.deepEqual(safe, {
    id: ID_A,
    name: 'Abayas',
    slug: 'abayas',
    description: null,
    image: null,
    isActive: true,
    sortOrder: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  for (const forbidden of ['_id', '__v', 'authProviderId']) {
    assert.ok(!(forbidden in safe), `${forbidden} never appears in the safe representation`);
  }
});

test('CategoryService requires a repository', () => {
  assert.throws(() => new CategoryService(), /repository/);
  assert.throws(() => new CategoryService({}), /repository/);
});
