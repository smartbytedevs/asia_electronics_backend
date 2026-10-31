'use strict';

/**
 * Test-only in-memory stub for the notifications module.
 *
 * Implements the full method set the NotificationService relies on:
 *   - read surface (admin): `findById`, `findMany`/`count` with string-
 *     normalized filter matching and `createdAt` sort;
 *   - write surface (best-effort delivery): `create`, `findRecentDuplicate`,
 *     `markSkipped`, `markSent`, `markFailed`.
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

function createMemoryNotificationRepository(initial = []) {
  const docs = [...initial];
  let nextId = 1;

  function update(id, patch) {
    const doc = docs.find((d) => String(d._id) === String(id));
    if (!doc) {
      return null;
    }
    Object.assign(doc, patch, { updatedAt: new Date() });
    return doc;
  }

  return {
    docs,
    findById: async (id) => docs.find((d) => String(d._id) === String(id)) || null,
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
        recipient: null,
        recipientEmail: null,
        channel: 'EMAIL',
        eventType: 'ORDER_PLACED',
        templateKey: null,
        entityRef: null,
        payload: {},
        status: 'QUEUED',
        attempts: 0,
        lastAttemptAt: null,
        lastError: null,
        provider: null,
        providerRef: null,
        deliveredAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      docs.push(created);
      return created;
    },
    findRecentDuplicate: async (recipient, eventType, entityRef, since) =>
      docs.find(
        (d) =>
          String(d.recipient) === String(recipient) &&
          d.eventType === eventType &&
          d.entityRef === entityRef &&
          d.createdAt >= since
      ) || null,
    markSkipped: async (id, { reason, at }) => update(id, { status: 'SKIPPED', lastError: { code: 'SKIPPED', message: reason }, lastAttemptAt: at, attempts: 1 }),
    markSent: async (id, { provider, providerRef, deliveredAt }) =>
      update(id, { status: 'SENT', provider, providerRef, deliveredAt, lastAttemptAt: deliveredAt, attempts: 1, lastError: null }),
    markFailed: async (id, { code, message, at }) =>
      update(id, { status: 'FAILED', lastError: { code, message }, lastAttemptAt: at, attempts: 1 }),
  };
}

module.exports = { createMemoryNotificationRepository };
