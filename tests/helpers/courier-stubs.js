'use strict';

/**
 * Test-only in-memory stubs for the courier module.
 *
 * Mirrors the Mongoose semantics of courierShipment.repository.js:
 * - `create` enforces the unique orderId index with a real duplicate-key error.
 * - `transitionStatus` is ATOMIC CONDITIONAL (returns null when the shipment is
 *   no longer in `fromStatus`) — the same conflict point the real repository has.
 * - Dotted `$set` paths (e.g. `submission.lastError`) are applied deeply.
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

function setDeep(doc, path, value) {
  const parts = path.split('.');
  let target = doc;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (!target[key] || typeof target[key] !== 'object') {
      target[key] = {};
    }
    target = target[key];
  }
  target[parts[parts.length - 1]] = value;
  return doc;
}

function createMemoryShipmentRepository(initial = []) {
  const docs = [...initial];
  let nextId = 1;

  const findById = (id) => docs.find((d) => String(d._id) === String(id)) || null;
  const findOne = (filter) => docs.find((d) => matches(d, filter)) || null;

  return {
    docs,
    findById: async (id) => findById(id),
    findOne: async (filter) => findOne(filter),
    findByOrderId: async (orderId) => findOne({ orderId }),
    findByConsignmentId: async (consignmentId) => findOne({ consignmentId }),
    findByMerchantReference: async (merchantReference) => findOne({ merchantReference }),

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
        status: 'PENDING',
        statusHistory: [],
        consignmentId: null,
        submission: {},
        providerStatus: {},
        fees: {},
        cancel: {},
        dispatch: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      docs.push(created);
      return created;
    },

    updateById: async (id, update) => {
      const doc = findById(id);
      if (!doc) return null;
      for (const [field, value] of Object.entries(update.$set || {})) {
        setDeep(doc, field, value);
      }
      doc.updatedAt = new Date();
      return doc;
    },

    transitionStatus: async (id, fromStatus, toStatus, historyEntry, setFields = {}) => {
      const doc = findById(id);
      if (!doc || doc.status !== fromStatus) return null;
      doc.status = toStatus;
      for (const [field, value] of Object.entries(setFields || {})) {
        setDeep(doc, field, value);
      }
      doc.statusHistory = [...(doc.statusHistory || []), historyEntry];
      doc.updatedAt = new Date();
      return doc;
    },

    recordSubmissionFailure: async (
      id,
      { payload, errorCode, errorMessage, errorRaw, performedBy, attemptedAt }
    ) => {
      const doc = findById(id);
      if (!doc || !['PENDING', 'FAILED'].includes(doc.status)) return null;
      doc.status = 'FAILED';
      doc.submission = {
        ...(doc.submission || {}),
        payload,
        lastError: { code: errorCode, message: errorMessage, raw: errorRaw || null },
        lastSubmitAttemptAt: attemptedAt,
      };
      doc.submission.attempts = (doc.submission.attempts || 0) + 1;
      doc.statusHistory = [
        ...(doc.statusHistory || []),
        { status: 'FAILED', at: attemptedAt, by: performedBy, note: errorMessage },
      ];
      doc.updatedAt = new Date();
      return doc;
    },

    recordSubmissionSuccess: async (
      id,
      {
        consignmentId,
        providerDeliveryFeeMinorUnits,
        currency = 'BDT',
        payload,
        providerStatus,
        providerStatusUpdatedAt,
        submittedAt,
        performedBy,
      }
    ) => {
      const doc = findById(id);
      if (!doc || !['PENDING', 'FAILED'].includes(doc.status)) return null;
      doc.status = 'ACTIVE';
      doc.consignmentId = consignmentId;
      doc.submission = {
        ...(doc.submission || {}),
        payload,
        submittedAt,
        lastSubmitAttemptAt: submittedAt,
        lastError: null,
      };
      doc.submission.attempts = (doc.submission.attempts || 0) + 1;
      doc.fees = { providerDeliveryFeeMinorUnits, currency };
      doc.providerStatus = {
        status: providerStatus,
        updatedAt: providerStatusUpdatedAt,
        fetchedAt: submittedAt,
      };
      doc.statusHistory = [
        ...(doc.statusHistory || []),
        {
          status: 'ACTIVE',
          at: submittedAt,
          by: performedBy,
          note: `Assigned consignment ${consignmentId}`,
          providerStatus,
        },
      ];
      doc.updatedAt = new Date();
      return doc;
    },

    touchProviderStatus: async (id, fields) => {
      const doc = findById(id);
      if (!doc) return null;
      for (const [field, value] of Object.entries(fields)) {
        setDeep(doc, field, value);
      }
      doc.updatedAt = new Date();
      return doc;
    },

    findReconcilable: async (statuses, fetchedBefore) =>
      docs.filter(
        (d) =>
          statuses.includes(d.status) &&
          (!d.providerStatus ||
            !d.providerStatus.fetchedAt ||
            d.providerStatus.fetchedAt < fetchedBefore)
      ),
  };
}

module.exports = { createMemoryShipmentRepository };
