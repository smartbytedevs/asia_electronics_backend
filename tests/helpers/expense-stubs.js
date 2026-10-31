'use strict';

/**
 * Test-only in-memory stubs for the expenses module (Phase 13).
 *
 * Mirrors the Mongoose semantics the real repository relies on:
 * - `findMany`/`count` translate the OPT-IN `dateFrom`/`dateTo` filters to an
 *   `expenseDate` range (the same convention as the real buildQuery) and
 *   support `$gte`/`$lte`/`$ne` operators for other fields,
 * - `create` fills the id and default fields like the model would.
 */

function hexId(n) {
  return n.toString(16).padStart(24, '0');
}

function valueMatches(actual, expected) {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if (expected.$ne !== undefined) {
      return String(actual) !== String(expected.$ne);
    }
    if (expected.$gte !== undefined && expected.$lte !== undefined) {
      return actual >= expected.$gte && actual <= expected.$lte;
    }
    if (expected.$gte !== undefined) {
      return actual >= expected.$gte;
    }
    if (expected.$lte !== undefined) {
      return actual <= expected.$lte;
    }
  }
  return String(actual) === String(expected);
}

function docMatches(doc, filter = {}) {
  for (const [key, expected] of Object.entries(filter)) {
    if (key === 'dateFrom') {
      if (new Date(doc.expenseDate) < new Date(expected)) return false;
    } else if (key === 'dateTo') {
      if (new Date(doc.expenseDate) > new Date(expected)) return false;
    } else if (!valueMatches(doc[key], expected)) {
      return false;
    }
  }
  return true;
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

function createMemoryExpenseRepository(initial = []) {
  const docs = [...initial];
  let nextId = 1;

  const findById = (id) => docs.find((d) => String(d._id) === String(id)) || null;

  return {
    docs,
    findById: async (id) => findById(id),
    findOne: async (filter = {}) => docs.find((d) => docMatches(d, filter)) || null,
    findMany: async (filter = {}, options = {}) => {
      let result = docs.filter((d) => docMatches(d, filter));
      result = applySort(result, options.sort);
      if (options.skip) result = result.slice(options.skip);
      if (options.limit) result = result.slice(0, options.limit);
      return result;
    },
    count: async (filter = {}) => docs.filter((d) => docMatches(d, filter)).length,
    create: async (data) => {
      const created = {
        _id: hexId(nextId++),
        category: null,
        expenseDate: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      docs.push(created);
      return created;
    },
  };
}

module.exports = { createMemoryExpenseRepository };
