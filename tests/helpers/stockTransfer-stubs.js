'use strict';

const { STOCK_TRANSFER_STATUSES } = require('../../src/modules/stockTransfers/stockTransfer.constants');

/**
 * Test-only in-memory stubs for the stock-transfer module (Phase 14).
 *
 * `createMemoryOutletRepository` and `createMemoryStockTransferRepository`
 * mirror the real repositories' signatures; the inventory/movement/variant
 * stubs come from `inventory-stubs.js`.
 */

function hexId(n) {
  return n.toString(16).padStart(24, '0');
}

function matches(doc, filter = {}) {
  return Object.keys(filter).every((key) => {
    const expected = filter[key];
    const actual = doc[key];
    if (typeof expected === 'object' && expected !== null && expected.$or !== undefined) {
      return expected.$or.some((alt) => matches(doc, alt));
    }
    if (typeof expected === 'object' && expected !== null && expected.$gte !== undefined) {
      return actual >= expected.$gte;
    }
    return actual === expected;
  });
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

function createMemoryOutletRepository(outlets = []) {
  return {
    docs: outlets,
    findById: async (id) =>
      outlets.find((o) => String(o._id) === String(id)) || null,
    findOne: async (filter) => outlets.find((o) => matches(o, filter)) || null,
    findMany: async (filter = {}, options = {}) => {
      let result = outlets.filter((o) => matches(o, filter));
      result = applySort(result, options.sort);
      if (options.skip) result = result.slice(options.skip);
      if (options.limit) result = result.slice(0, options.limit);
      return result;
    },
    count: async (filter = {}) => outlets.filter((o) => matches(o, filter)).length,
    create: async (data) => {
      const created = {
        _id: hexId(outlets.length + 1),
        address: null,
        phone: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      outlets.push(created);
      return created;
    },
    updateById: async (id, update) => {
      const doc = outlets.find((o) => String(o._id) === String(id));
      if (!doc) return null;
      Object.assign(doc, update, { updatedAt: new Date() });
      return doc;
    },
    findByCode: async (code) => outlets.find((o) => o.code === code) || null,
    existsByCode: async (code) => outlets.some((o) => o.code === code),
    listActive: async () => outlets.filter((o) => o.isActive === true),
  };
}

function createMemoryStockTransferRepository(initial = []) {
  const docs = [...initial];
  let nextId = 1;
  return {
    docs,
    findById: async (id) => docs.find((d) => String(d._id) === String(id)) || null,
    findOne: async (filter) => docs.find((d) => matches(d, filter)) || null,
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
        _id: hexId(nextId++),
        status: STOCK_TRANSFER_STATUSES.COMPLETED,
        completedAt: new Date(),
        reason: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      docs.push(created);
      return created;
    },
    findManyByOutlet: async (outletId, options = {}) =>
      applySort(
        docs.filter(
          (d) => String(d.sourceOutletId) === String(outletId) || String(d.destinationOutletId) === String(outletId)
        ),
        options.sort
      ),
    findManyByVariant: async (productVariantId, options = {}) =>
      applySort(docs.filter((d) => String(d.productVariantId) === String(productVariantId)), options.sort),
  };
}

module.exports = {
  createMemoryOutletRepository,
  createMemoryStockTransferRepository,
};
