'use strict';

/**
 * Test-only in-memory stubs for the refunds module (Phase 10, ADR-0018).
 *
 * These mirror the Mongoose semantics the real repository relies on:
 * - `create` enforces the `{ refundNumber }` unique index with a real
 *   duplicate-key error so the bounded retry is exercised.
 * - `conditionalTransition` is ATOMIC CONDITIONAL (no-op when the document is
 *   no longer in `fromStatus`) — the same conflict point the real repository
 *   has. It applies `{ $set, $push }` exactly like Mongoose.
 * - Filter matching compares ids by string and honours the operators the
 *   refund service uses.
 */

const { duplicateKeyError } = require('./payment-stubs');

function hexId(n) {
  return n.toString(16).padStart(24, '0');
}

function valueMatches(actual, expected) {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if (expected.$gte !== undefined && expected.$lte !== undefined) {
      return actual >= expected.$gte && actual <= expected.$lte;
    }
    if (expected.$gte !== undefined) {
      return actual >= expected.$gte;
    }
    if (expected.$lte !== undefined) {
      return actual <= expected.$lte;
    }
    if (expected.$ne !== undefined) {
      return String(actual) !== String(expected.$ne);
    }
  }
  return String(actual) === String(expected);
}

function matches(doc, filter = {}) {
  const effective = {};
  for (const [key, value] of Object.entries(filter)) {
    if (key === 'dateFrom') {
      effective.createdAt = { ...(effective.createdAt || {}), $gte: value };
    } else if (key === 'dateTo') {
      effective.createdAt = { ...(effective.createdAt || {}), $lte: value };
    } else if (key !== 'createdAt') {
      effective[key] = value;
    }
  }
  return Object.keys(effective).every((key) => valueMatches(doc[key], effective[key]));
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

function createMemoryRefundRepository(initial = []) {
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
      if (docs.some((d) => d.refundNumber === data.refundNumber)) {
        throw duplicateKeyError({ refundNumber: 1 });
      }
      const created = {
        _id: hexId(nextId++),
        status: 'PENDING',
        note: '',
        processedBy: null,
        processedAt: null,
        voidedBy: null,
        voidedAt: null,
        paymentId: null,
        statusHistory: [],
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

module.exports = { createMemoryRefundRepository };
