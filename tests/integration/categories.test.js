'use strict';

process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createCategoryRouter } = require('../../src/modules/categories/category.routes');
const { CategoryService } = require('../../src/modules/categories/category.service');
const { UserService } = require('../../src/modules/users/user.service');
const { ROLES, ACCOUNT_STATUSES, ERROR_CODES } = require('../../src/constants');
const notFound = require('../../src/middlewares/notFound');
const errorHandler = require('../../src/middlewares/errorHandler');
const { createJwtVerifier } = require('../../src/integrations/auth/jwtVerifier');
const { createKeyPair, signToken } = require('../../tests/helpers/jwt-fixtures');

const ISSUER = 'taqwa-frontend';
const AUDIENCE = 'taqwa-backend';
const ALGORITHMS = ['RS256'];

const MESSAGES = {
  UNAUTHORIZED: 'Authentication required',
  FORBIDDEN: 'You do not have permission to perform this action',
  LIST_FETCHED: 'Categories retrieved successfully',
  CATEGORY_FETCHED: 'Category retrieved successfully',
  CATEGORY_CREATED: 'Category created successfully',
  CATEGORY_UPDATED: 'Category updated successfully',
  CATEGORY_NOT_FOUND: 'Category not found',
  CATEGORY_ALREADY_EXISTS: 'A category with this name already exists',
  CATEGORY_SLUG_ALREADY_EXISTS: 'A category with this slug already exists',
};

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

function categoryDoc(overrides = {}) {
  return {
    _id: '507f1f77bcf86cd799439011',
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

let nextCategoryId = 2;
function freshCategoryId() {
  const id = `507f1f77bcf86cd7994390${String(nextCategoryId).padStart(2, '0')}`;
  nextCategoryId += 1;
  return id;
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

function createStubCategoryRepository(categories) {
  return {
    findOne: async (filter) =>
      categories.find((c) => Object.keys(filter).every((k) => c[k] === filter[k])) || null,
    findById: async (id) =>
      categories.find((c) => String(c._id) === String(id)) || null,
    findMany: async (filter, options) => {
      const docs = categories.filter((c) =>
        Object.keys(filter).every((k) => c[k] === filter[k])
      );
      const { sort = {} } = options || {};
      return [...docs].sort((a, b) => {
        for (const [field, dir] of Object.entries(sort)) {
          const av = a[field] === undefined ? 0 : a[field];
          const bv = b[field] === undefined ? 0 : b[field];
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          if (cmp !== 0) return dir === -1 ? -cmp : cmp;
        }
        return 0;
      });
    },
    create: async (data) => {
      const created = {
        _id: freshCategoryId(),
        isActive: true,
        sortOrder: 0,
        description: null,
        image: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      categories.push(created);
      return created;
    },
    updateById: async (id, update) => {
      const doc = categories.find((c) => String(c._id) === String(id));
      if (!doc) return null;
      Object.assign(doc, update, { updatedAt: new Date() });
      return doc;
    },
    findBySlug: async (slug) =>
      categories.find((c) => c.slug === slug) || null,
    existsBySlug: async (slug) =>
      Boolean(categories.find((c) => c.slug === slug)),
  };
}

function buildApp({ users, categories, autoProvisionCustomers = true, verifier }) {
  const userService = new UserService({
    repository: createStubUserRepository(users),
    autoProvisionCustomers,
  });
  const categoryService = new CategoryService({
    repository: createStubCategoryRepository(categories),
  });
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/categories',
    createCategoryRouter({
      categoryService,
      userService,
      verifier,
    })
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
  // A CUSTOMER token that tries to claim the ADMIN role in the JWT.
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

function seedCatalog() {
  return [
    categoryDoc(),
    categoryDoc({
      _id: '507f1f77bcf86cd799439020',
      name: 'Jewelry',
      slug: 'jewelry',
      sortOrder: 0,
    }),
    categoryDoc({
      _id: '507f1f77bcf86cd799439021',
      name: 'Old Category',
      slug: 'old-category',
      isActive: false,
      sortOrder: 0,
    }),
  ];
}

test('GET /api/v1/categories is public and lists ACTIVE categories in sortOrder order', withServer(
  () => buildApp({ users: [], categories: seedCatalog(), verifier }),
  async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/categories`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.message, MESSAGES.LIST_FETCHED);
    assert.deepEqual(
      body.data.categories.map((c) => c.slug),
      ['jewelry', 'abayas'],
      'inactive categories are excluded and ordering is sortOrder ASC'
    );
  }
));

test('GET /api/v1/categories responses never leak internals', withServer(
  () => buildApp({ users: [], categories: seedCatalog(), verifier }),
  async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/categories`);
    const raw = await res.text();
    assert.ok(!raw.includes('_id'), 'raw _id is never serialized');
    assert.ok(!raw.includes('__v'), 'version key is never serialized');
  }
));

test('GET /api/v1/categories/:id returns a safe category (public)', withServer(
  () => buildApp({ users: [], categories: seedCatalog(), verifier }),
  async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/categories/507f1f77bcf86cd799439011`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.category.id, '507f1f77bcf86cd799439011');
    assert.equal(body.data.category.name, 'Abayas');
    assert.equal(body.data.category.slug, 'abayas');
    assert.equal(body.data.category.createdAt, '2026-01-01T00:00:00.000Z');
  }
));

test('GET /api/v1/categories/:id unknown id → 404 CATEGORY_NOT_FOUND', withServer(
  () => buildApp({ users: [], categories: seedCatalog(), verifier }),
  async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/categories/507f1f77bcf86cd799439099`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.message, MESSAGES.CATEGORY_NOT_FOUND);
    assert.equal(body.error.code, ERROR_CODES.CATEGORY_NOT_FOUND);
  }
));

test('GET /api/v1/categories/:id inactive → 404 (soft deactivation behaves as not-found publicly)', withServer(
  () => buildApp({ users: [], categories: seedCatalog(), verifier }),
  async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/categories/507f1f77bcf86cd799439021`);
    assert.equal(res.status, 404);
  }
));

test('GET /api/v1/categories/:id malformed id → 400 INVALID_CATEGORY', withServer(
  () => buildApp({ users: [], categories: seedCatalog(), verifier }),
  async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/categories/not-an-id`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, ERROR_CODES.INVALID_CATEGORY);
  }
));

test('GET /api/v1/categories/slug/:slug normalizes and resolves (public)', withServer(
  () => buildApp({ users: [], categories: seedCatalog(), verifier }),
  async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/categories/slug/ABAYAS`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.category.slug, 'abayas');
  }
));

test('GET /api/v1/categories/slug/:slug unknown → 404', withServer(
  () => buildApp({ users: [], categories: seedCatalog(), verifier }),
  async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/categories/slug/does-not-exist`);
    assert.equal(res.status, 404);
  }
));

test('POST /api/v1/categories without a token → 401', withServer(
  () => buildApp({ users: seedUsers(), categories: seedCatalog(), verifier }),
  async (baseUrl) => {
    const res = await post(`${baseUrl}/api/v1/categories`, null, { name: 'Hijabs' });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, ERROR_CODES.UNAUTHORIZED);
  }
));

test('POST /api/v1/categories as CUSTOMER → 403', withServer(
  () => buildApp({ users: seedUsers(), categories: seedCatalog(), verifier }),
  async (baseUrl) => {
    const res = await post(`${baseUrl}/api/v1/categories`, tokenCustomer, { name: 'Hijabs' });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error.code, ERROR_CODES.FORBIDDEN);
  }
));

test('POST /api/v1/categories as STAFF → 403', withServer(
  () => buildApp({ users: seedUsers(), categories: seedCatalog(), verifier }),
  async (baseUrl) => {
    const res = await post(`${baseUrl}/api/v1/categories`, tokenStaff, { name: 'Hijabs' });
    assert.equal(res.status, 403);
  }
));

test('POST /api/v1/categories as ADMIN → 201 with auto-derived slug and safe payload', withServer(
  () => buildApp({ users: seedUsers(), categories: seedCatalog(), verifier }),
  async (baseUrl) => {
    const res = await post(`${baseUrl}/api/v1/categories`, tokenAdmin, {
      name: 'Baby Dresses',
      sortOrder: 5,
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.message, MESSAGES.CATEGORY_CREATED);
    assert.equal(body.data.category.name, 'Baby Dresses');
    assert.equal(body.data.category.slug, 'baby-dresses');
    assert.equal(body.data.category.sortOrder, 5);
    assert.equal(body.data.category.isActive, true, 'isActive defaults to true');
    assert.ok(/^[0-9a-fA-F]{24}$/.test(body.data.category.id), 'id is a plain object id');
  }
));

test('POST as ADMIN with an explicit slug → 201 and the slug is respected', withServer(
  () => buildApp({ users: seedUsers(), categories: seedCatalog(), verifier }),
  async (baseUrl) => {
    const res = await post(`${baseUrl}/api/v1/categories`, tokenAdmin, {
      name: 'Our Abayas',
      slug: 'our-abayas',
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.data.category.slug, 'our-abayas');
  }
));

test('POST as ADMIN with an explicit slug collision → 400 CATEGORY_SLUG_ALREADY_EXISTS', withServer(
  () => buildApp({ users: seedUsers(), categories: seedCatalog(), verifier }),
  async (baseUrl) => {
    const res = await post(`${baseUrl}/api/v1/categories`, tokenAdmin, {
      name: 'Jewelry Again',
      slug: 'jewelry',
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, ERROR_CODES.CATEGORY_SLUG_ALREADY_EXISTS);
    assert.equal(body.message, MESSAGES.CATEGORY_SLUG_ALREADY_EXISTS);
  }
));

test('POST as ADMIN with a duplicate name → 400 CATEGORY_ALREADY_EXISTS', withServer(
  () => buildApp({ users: seedUsers(), categories: seedCatalog(), verifier }),
  async (baseUrl) => {
    const res = await post(`${baseUrl}/api/v1/categories`, tokenAdmin, { name: 'Abayas' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, ERROR_CODES.CATEGORY_ALREADY_EXISTS);
  }
));

test('POST as ADMIN with operator injection ($set) → 400 INVALID_CATEGORY', withServer(
  () => buildApp({ users: seedUsers(), categories: seedCatalog(), verifier }),
  async (baseUrl) => {
    const res = await post(`${baseUrl}/api/v1/categories`, tokenAdmin, {
      name: 'Hijabs',
      $set: { role: 'ADMIN' },
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, ERROR_CODES.INVALID_CATEGORY);
  }
));

test('role claim in the JWT cannot elevate a CUSTOMER to create categories', withServer(
  () => buildApp({ users: seedUsers(), categories: seedCatalog(), verifier }),
  async (baseUrl) => {
    const res = await post(`${baseUrl}/api/v1/categories`, tokenAdminClaimSpoof, {
      name: 'Hijabs',
    });
    assert.equal(res.status, 403, 'application role comes from the stored User, not the token');
  }
));

test('PATCH /api/v1/categories/:id without a token → 401 and as CUSTOMER → 403', withServer(
  () => buildApp({ users: seedUsers(), categories: seedCatalog(), verifier }),
  async (baseUrl) => {
    const unauthed = await patch(
      `${baseUrl}/api/v1/categories/507f1f77bcf86cd799439011`,
      null,
      { name: 'X' }
    );
    assert.equal(unauthed.status, 401);

    const forbidden = await patch(
      `${baseUrl}/api/v1/categories/507f1f77bcf86cd799439011`,
      tokenCustomer,
      { name: 'X' }
    );
    assert.equal(forbidden.status, 403);
  }
));

test('PATCH as ADMIN applies a partial update without erasing omitted fields', withServer(
  () => buildApp({ users: seedUsers(), categories: seedCatalog(), verifier }),
  async (baseUrl) => {
    const categories = seedCatalog();
    const res = await patch(
      `${baseUrl}/api/v1/categories/507f1f77bcf86cd799439011`,
      tokenAdmin,
      { sortOrder: 9 }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.message, MESSAGES.CATEGORY_UPDATED);
    assert.equal(body.data.category.sortOrder, 9);
    assert.equal(body.data.category.name, 'Abayas', 'name preserved (PATCH semantics)');
  }
));

test('PATCH as ADMIN deactivates a category and it vanishes from public reads', withServer(
  () => buildApp({ users: seedUsers(), categories: seedCatalog(), verifier }),
  async (baseUrl) => {
    const deactivate = await patch(
      `${baseUrl}/api/v1/categories/507f1f77bcf86cd799439011`,
      tokenAdmin,
      { isActive: false }
    );
    assert.equal(deactivate.status, 200);
    const deactivated = await deactivate.json();
    assert.equal(deactivated.data.category.isActive, false);

    const publicGet = await fetch(`${baseUrl}/api/v1/categories/507f1f77bcf86cd799439011`);
    assert.equal(publicGet.status, 404, 'inactive category is not publicly visible');
  }
));

test('PATCH as ADMIN with unknown id → 404 CATEGORY_NOT_FOUND', withServer(
  () => buildApp({ users: seedUsers(), categories: seedCatalog(), verifier }),
  async (baseUrl) => {
    const res = await patch(
      `${baseUrl}/api/v1/categories/507f1f77bcf86cd799439099`,
      tokenAdmin,
      { name: 'X' }
    );
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, ERROR_CODES.CATEGORY_NOT_FOUND);
  }
));

test('PATCH as ADMIN with an empty body → 400 INVALID_CATEGORY', withServer(
  () => buildApp({ users: seedUsers(), categories: seedCatalog(), verifier }),
  async (baseUrl) => {
    const res = await patch(
      `${baseUrl}/api/v1/categories/507f1f77bcf86cd799439011`,
      tokenAdmin,
      {}
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, ERROR_CODES.INVALID_CATEGORY);
  }
));

test('raw token is never echoed in responses', withServer(
  () => buildApp({ users: seedUsers(), categories: seedCatalog(), verifier }),
  async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/categories`, {
      headers: { Authorization: `Bearer ${tokenCustomer}` },
    });
    const raw = await res.text();
    assert.ok(!raw.includes(tokenCustomer), 'raw token never appears in the response body');
  }
));
