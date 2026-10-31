'use strict';

/**
 * Test-only in-memory stubs for the returns module (Phase 10, ADR-0018).
 *
 * These mirror the Mongoose semantics the real repository relies on:
 * - `create` enforces the `{ refundNumber/returnNumber }` unique index and the
 *   `{ orderId, idempotencyKey }` compound index with real duplicate-key
 *   errors so the idempotent-submit and number-retry paths are exercised.
 * - `conditionalTransition` is ATOMIC CONDITIONAL (no-op when the document is
 *   no longer in `fromStatus`) — the same conflict point the real repository
 *   has. It applies `{ $set, $push }` exactly like Mongoose.
 * - Filter matching compares ids by string and honours the operators the
 *   return service uses (`$in`).
 */

const { duplicateKeyError } = require('./payment-stubs');

function hexId(n) {
  return n.toString(16).padStart(24, '0');
}

function valueMatches(actual, expected) {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if (Array.isArray(expected.$in)) {
      return expected.$in.some((v) => String(v) === String(actual));
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

function matches(doc, filter = {}) {
  return Object.keys(filter).every((key) => valueMatches(doc[key], filter[key]));
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

function createMemoryReturnRepository(initial = []) {
  const docs = [...initial];
  let nextId = 1;

  const findById = (id) => docs.find((d) => String(d._id) === String(id)) || null;
  const findOne = (filter) => docs.find((d) => matches(d, filter)) || null;

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
    findOne: async (filter) => findOne(filter),
    findMany: async (filter = {}, options = {}) => {
      let result = docs.filter((d) => matches(d, filter));
      result = applySort(result, options.sort);
      if (options.skip) result = result.slice(options.skip);
      if (options.limit) result = result.slice(0, options.limit);
      return result;
    },
    count: async (filter = {}) => docs.filter((d) => matches(d, filter)).length,
    create: async (data) => {
      if (docs.some((d) => d.returnNumber === data.returnNumber)) {
        throw duplicateKeyError({ returnNumber: 1 });
      }
      if (
        docs.some(
          (d) =>
            String(d.orderId) === String(data.orderId) &&
            String(d.idempotencyKey) === String(data.idempotencyKey)
        )
      ) {
        throw duplicateKeyError({ orderId: 1, idempotencyKey: 1 });
      }
      const created = {
        _id: hexId(nextId++),
        status: 'PENDING',
        statusHistory: [],
        refundId: null,
        notes: null,
        approvedBy: null,
        approvedAt: null,
        rejectedBy: null,
        rejectedAt: null,
        cancelledBy: null,
        cancelledAt: null,
        completedBy: null,
        completedAt: null,
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
  };
}

module.exports = { createMemoryReturnRepository };
