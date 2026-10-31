'use strict';

/**
 * Test-only in-memory stubs for the reviews module.
 *
 * These mirror the Mongoose semantics the real repository relies on:
 * - `findMany`/`count` filter by status/productId (string-normalized ids),
 * - `conditionalTransition` is ATOMIC CONDITIONAL (no-op when the document is
 *   no longer in `fromStatus`) — the same conflict point the real repository
 *   has. It applies `{ $set, $push }` exactly like Mongoose,
 * - `aggregateApprovedRatings` returns per-rating counts of APPROVED reviews
 *   like the real aggregation pipeline.
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

function createMemoryReviewRepository(initial = []) {
  const docs = [...initial];
  let nextId = 1;

  const findById = (id) => docs.find((d) => String(d._id) === String(id)) || null;

  const applyUpdate = (doc, update) => {
    const next = { ...doc };
    if (update.$set) {
      for (const [field, value] of Object.entries(update.$set)) {
        next[field] = value;
      }
    }
    if (update.$push) {
      for (const [field, value] of Object.entries(update.$push)) {
        next[field] = [...(next[field] || []), value];
      }
    }
    next.updatedAt = new Date();
    return next;
  };

  const replace = (id, next) => {
    const index = docs.findIndex((d) => String(d._id) === String(id));
    if (index === -1) return null;
    docs[index] = next;
    return next;
  };

  return {
    docs,
    findById: async (id) => findById(id),
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
        status: 'PENDING',
        statusHistory: [],
        customerDisplayName: null,
        comment: null,
        approvedBy: null,
        approvedAt: null,
        rejectedBy: null,
        rejectedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      docs.push(created);
      return created;
    },
    updateById: async (id, update, _options = {}) => {
      const doc = findById(id);
      if (!doc) return null;
      return replace(id, applyUpdate(doc, update));
    },
    conditionalTransition: async (id, fromStatus, update, _options = {}) => {
      const doc = findById(id);
      if (!doc || doc.status !== fromStatus) return null;
      return replace(id, applyUpdate(doc, update));
    },
    aggregateApprovedRatings: async (productId) => {
      const counts = new Map();
      for (const doc of docs) {
        if (String(doc.productId) === String(productId) && doc.status === 'APPROVED') {
          counts.set(doc.rating, (counts.get(doc.rating) || 0) + 1);
        }
      }
      return Array.from(counts.entries()).map(([rating, count]) => ({ rating, count }));
    },
  };
}

module.exports = { createMemoryReviewRepository };
