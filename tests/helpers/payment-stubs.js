'use strict';

/**
 * Test-only in-memory stubs for the payments module (Phase 08, ADR-0016).
 *
 * These mirror the Mongoose semantics the real repositories rely on:
 * - `create` enforces the `{ orderId }` unique index with a real duplicate-key
 *   error so the first-submission race is exercised.
 * - `conditionalTransition` is ATOMIC CONDITIONAL (no-op when the document is
 *   no longer in `fromStatus`) — the same conflict point the real repository
 *   has. It applies `{ $set, $push, $unset }` exactly like Mongoose.
 * - Filter matching supports the operators the payment service uses
 *   (`$ne`, `$gte`, `$lte`), comparing ids by string.
 * - The PaymentMethod stub enforces the `{ code }` unique index.
 *
 * LIMITATION (documented in docs/payment-state-machine.md): single-threaded
 * simulation, not real MongoDB snapshot-isolation races.
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

function duplicateKeyError(keyPattern) {
  const err = new Error('E11000 duplicate key error');
  err.code = 11000;
  err.name = 'MongoServerError';
  err.keyPattern = keyPattern;
  return err;
}

function createMemoryPaymentRepository(initial = []) {
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
    if (update.$unset) {
      for (const field of Object.keys(update.$unset)) {
        delete next[field];
      }
    }
    next.updatedAt = new Date();
    return next;
  };

  // Replaces the document in the array instead of mutating it in place, so
  // references handed out earlier (e.g. `findOne`) stay stable snapshots —
  // the same behaviour real MongoDB `findOneAndUpdate` has.
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
      const byOrder = docs.find((d) => String(d.orderId) === String(data.orderId));
      if (byOrder) throw duplicateKeyError({ orderId: 1 });
      const created = {
        _id: hexId(nextId++),
        status: 'UNPAID',
        statusHistory: [],
        notes: null,
        verifiedBy: null,
        verifiedAt: null,
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
  };
}

function createMemoryPaymentMethodRepository(initial = []) {
  const docs = [...initial];
  let nextId = 1;

  const findById = (id) => docs.find((d) => String(d._id) === String(id)) || null;
  const findOne = (filter) => docs.find((d) => matches(d, filter)) || null;

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
    findByCode: async (code) => findOne({ code }),
    create: async (data) => {
      const byCode = docs.find((d) => d.code === data.code);
      if (byCode) throw duplicateKeyError({ code: 1 });
      const created = {
        _id: hexId(nextId++),
        type: 'MANUAL',
        metadata: {},
        isActive: true,
        sortOrder: 0,
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
      if (update.$set) {
        for (const [field, value] of Object.entries(update.$set)) {
          doc[field] = value;
        }
      }
      doc.updatedAt = new Date();
      return doc;
    },
  };
}

module.exports = {
  createMemoryPaymentRepository,
  createMemoryPaymentMethodRepository,
  duplicateKeyError,
};
