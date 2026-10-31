'use strict';

/**
 * Test-only in-memory stubs for the cart + orders modules.
 *
 * These mirror the Mongoose semantics the repositories rely on:
 * - Order stub `create` enforces the two unique indexes ({orderNumber},
 *   {customerId, idempotencyKey}) with real duplicate-key errors so the
 *   checkout retry + idempotency paths are exercised.
 * - `transitionStatus` is ATOMIC CONDITIONAL (no-op when the order is no
 *   longer in `fromStatus`), the same conflict point the real repository has.
 * - Cart items are materialized with `_id` + `toObject()` like Mongoose
 *   subdocuments, because CartService reads/writes them as such.
 *
 * LIMITATION (documented in docs/order-state-machine.md): single-threaded
 * simulation, not real MongoDB snapshot-isolation races.
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

function duplicateKeyError(keyPattern) {
  const err = new Error('E11000 duplicate key error');
  err.code = 11000;
  err.name = 'MongoServerError';
  err.keyPattern = keyPattern;
  return err;
}

let nextSubId = 1000;
function materializeItem(item) {
  const sub = { _id: hexId(nextSubId++), ...item };
  sub.toObject = function toObject() {
    const { toObject: _omit, ...rest } = this;
    return rest;
  };
  return sub;
}

function createMemoryOrderRepository(initial = []) {
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
    create: async (data) => {
      const byNumber = docs.find((d) => d.orderNumber === data.orderNumber);
      if (byNumber) throw duplicateKeyError({ orderNumber: 1 });
      const byKey = docs.find(
        (d) =>
          String(d.customerId) === String(data.customerId) &&
          d.idempotencyKey === data.idempotencyKey
      );
      if (byKey) throw duplicateKeyError({ customerId: 1, idempotencyKey: 1 });
      const created = {
        _id: hexId(nextId++),
        status: 'PENDING',
        statusHistory: [],
        reservationReference: null,
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
      for (const [field, value] of Object.entries(update.$set || {})) {
        doc[field] = value;
      }
      doc.updatedAt = new Date();
      return doc;
    },
    findByIdempotencyKey: async (customerId, idempotencyKey) =>
      findOne({ customerId, idempotencyKey }),
    findByOrderNumber: async (orderNumber) => findOne({ orderNumber }),
    transitionStatus: async (id, fromStatus, toStatus, historyEntry, _options = {}) => {
      const doc = findById(id);
      if (!doc || doc.status !== fromStatus) return null;
      doc.status = toStatus;
      doc.statusHistory = [...(doc.statusHistory || []), historyEntry];
      doc.updatedAt = new Date();
      return doc;
    },
  };
}

function createMemoryCartRepository(initial = []) {
  const docs = [...initial];
  let nextId = 1;

  const findByCustomer = (customerId) =>
    docs.find((d) => String(d.customerId) === String(customerId)) || null;

  return {
    docs,
    findByCustomer: async (customerId) => findByCustomer(customerId),
    create: async (data) => {
      const created = {
        ...data,
        _id: hexId(nextId++),
        items: (data.items || []).map(materializeItem),
        isCheckedOut: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      docs.push(created);
      return created;
    },
    setItems: async (customerId, items) => {
      const doc = findByCustomer(customerId);
      if (!doc) return null;
      doc.items = items.map(materializeItem);
      doc.isCheckedOut = false;
      doc.updatedAt = new Date();
      return doc;
    },
    markCheckedOutAndClear: async (customerId) => {
      const doc = findByCustomer(customerId);
      if (!doc) return null;
      doc.items = [];
      doc.isCheckedOut = true;
      doc.updatedAt = new Date();
      return doc;
    },
    clearItems: async (customerId) => {
      const doc = findByCustomer(customerId);
      if (!doc) return null;
      doc.items = [];
      doc.updatedAt = new Date();
      return doc;
    },
  };
}

function createMemoryProductRepository(products = []) {
  return {
    findById: async (id) =>
      products.find((p) => String(p._id) === String(id)) || null,
  };
}

/**
 * Transaction wrapper that simulates MongoDB's rollback for the in-memory
 * stubs: it snapshots every given repository's `docs` array (which all stubs
 * expose) and restores it if `work` throws. Lets checkout failure tests assert
 * that a failed checkout created no order, reserved nothing, and did not clear
 * the cart — the same invariant the real MongoDB transaction guarantees.
 */
function createRollbackTransaction(repos = []) {
  const snapshot = () =>
    repos.map((repo) => JSON.parse(JSON.stringify(repo.docs || [])));
  return async (work) => {
    const saved = snapshot();
    const session = { id: 'session-rollback-test' };
    try {
      return await work(session);
    } catch (err) {
      repos.forEach((repo, index) => {
        repo.docs.length = 0;
        repo.docs.push(...saved[index]);
      });
      throw err;
    }
  };
}

module.exports = {
  createMemoryOrderRepository,
  createMemoryCartRepository,
  createMemoryProductRepository,
  createRollbackTransaction,
  materializeItem,
};
