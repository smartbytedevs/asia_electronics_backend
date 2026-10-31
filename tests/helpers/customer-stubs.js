'use strict';

/**
 * Test-only in-memory stub for the users module.
 *
 * Mirrors the Mongoose semantics the real repository relies on for the admin
 * customer surface: `findById`, `findMany`/`count` with string-normalized
 * filter matching and `createdAt` sort, plus the identity resolution methods
 * (`findByAuthProviderId`, `create`) the UserService needs in the app wiring.
 */

function hexId(n) {
  return n.toString(16).padStart(24, '0');
}

function matches(doc, filter = {}) {
  return Object.keys(filter).every((key) => String(doc[key]) === String(filter[key]));
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

function createMemoryUserRepository(initial = []) {
  const docs = [...initial];

  return {
    docs,
    findById: async (id) => docs.find((d) => String(d._id) === String(id)) || null,
    findOne: async (filter) => docs.find((d) => matches(d, filter)) || null,
    findByAuthProviderId: async (authProviderId) =>
      docs.find((d) => d.authProviderId === authProviderId) || null,
    findByEmail: async (email) => docs.find((d) => d.email === email) || null,
    findMany: async (filter = {}, options = {}) => {
      let result = docs.filter((d) => matches(d, filter));
      result = applySort(result, options.sort);
      if (options.skip) result = result.slice(options.skip);
      if (options.limit) result = result.slice(0, options.limit);
      return result;
    },
    count: async (filter = {}) => docs.filter((d) => matches(d, filter)).length,
    create: async (data) => {
      const created = {
        _id: hexId(docs.length + 1),
        role: 'CUSTOMER',
        status: 'ACTIVE',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      docs.push(created);
      return created;
    },
  };
}

module.exports = { createMemoryUserRepository };
