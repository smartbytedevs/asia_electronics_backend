'use strict';

const { STOCK_LOCATIONS } = require('../../src/modules/inventory/inventory.constants');

/**
 * Test-only in-memory stubs for the inventory module.
 *
 * The inventory repository stub replicates the ATOMIC CONDITIONAL semantics of
 * the real repository: each mutation checks its invariant and applies its
 * `$inc`-equivalent synchronously (no `await` between check and mutate), so
 * concurrent service calls serialise at the mutation just as MongoDB's
 * document-level atomic updates do. This lets the concurrency tests exercise
 * the same code paths the production `findOneAndUpdate` filters guard.
 *
 * LIMITATION (documented in docs/inventory-state-machine.md): these are
 * single-threaded simulations, not real MongoDB snapshot-isolation races.
 */

function availableOnline(doc) {
  return doc.onlineQuantity - doc.reservedQuantity;
}

/**
 * Maps a STOCK_LOCATIONS value to the Inventory document field it mutates
 * (mirrors the real repository, which maps ONLINE/OFFLINE onto
 * onlineQuantity/offlineQuantity).
 */
const LOCATION_FIELDS = {
  [STOCK_LOCATIONS.ONLINE]: 'onlineQuantity',
  [STOCK_LOCATIONS.OFFLINE]: 'offlineQuantity',
};

function locationField(location) {
  const field = LOCATION_FIELDS[location];
  if (!field) throw new Error(`Unknown stock location: ${location}`);
  return field;
}

function hexId(n) {
  return n.toString(16).padStart(24, '0');
}

function matches(doc, filter = {}) {
  return Object.keys(filter).every((key) => {
    const expected = filter[key];
    const actual = doc[key];
    if (typeof expected === 'object' && expected !== null && expected.$gte !== undefined) {
      return actual >= expected.$gte;
    }
    if (
      typeof expected === 'object' &&
      expected !== null &&
      Array.isArray(expected.$in)
    ) {
      return expected.$in.some((value) => String(value) === String(actual));
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

function createMemoryVariantRepository(variants = []) {
  return {
    findById: async (id) =>
      variants.find((v) => String(v._id) === String(id)) || null,
    findMany: async (filter = {}, options = {}) => {
      let result = variants.filter((d) => matches(d, filter));
      result = applySort(result, options.sort);
      if (options.skip) result = result.slice(options.skip);
      if (options.limit) result = result.slice(0, options.limit);
      return result;
    },
    findByProduct: async (productId, _options = {}) =>
      variants.filter((v) => String(v.productId) === String(productId)),
    findOneByProduct: async (productId, filter = {}, _options = {}) =>
      variants.find(
        (v) =>
          String(v.productId) === String(productId) && matches(v, filter)
      ) || null,
  };
}

function createMemoryProductRepository(products = []) {
  const docs = [...products];
  let nextId = 1;
  return {
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
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      docs.push(created);
      return created;
    },
  };
}

function createMemoryInventoryRepository(initial = []) {
  const docs = [...initial];
  let nextId = 1;

  const find = (productVariantId) =>
    docs.find((d) => String(d.productVariantId) === String(productVariantId));

  const findProduct = (productId) =>
    docs.find(
      (d) => String(d.productId) === String(productId) && d.productVariantId == null
    );

  const findVariantOutlet = (productVariantId, outletId) =>
    docs.find(
      (d) =>
        String(d.productVariantId) === String(productVariantId) &&
        String(d.outletId) === String(outletId)
    );

  const touch = (doc) => {
    doc.updatedAt = new Date();
    return doc;
  };

  const seed = (data) => {
    const created = {
      _id: hexId(nextId++),
      productId: data.productId,
      productVariantId: data.productVariantId,
      outletId: data.outletId,
      onlineQuantity: data.onlineQuantity,
      offlineQuantity: 0,
      reservedQuantity: 0,
      lowStockThreshold: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    docs.push(created);
    return created;
  };

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
        onlineQuantity: 0,
        offlineQuantity: 0,
        reservedQuantity: 0,
        lowStockThreshold: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      docs.push(created);
      return created;
    },
    findByProductVariantId: async (productVariantId) => find(productVariantId) || null,
    findByProductId: async (productId) => findProduct(productId) || null,
    findByVariantAndOutlet: async (productVariantId, outletId) =>
      findVariantOutlet(productVariantId, outletId) || null,
    findByProductAndOutlet: async (productId, outletId) =>
      docs.find(
        (d) =>
          String(d.productId) === String(productId) &&
          d.productVariantId == null &&
          String(d.outletId) === String(outletId)
      ) || null,
    findBySubject: async (subject) =>
      docs.find(
        (d) =>
          String(d.productId) === String(subject.productId) &&
          String(d.productVariantId) === String(subject.productVariantId || null) &&
          String(d.outletId) === String(subject.outletId || null)
      ) || null,
    findManyByOutlet: async (outletId) =>
      docs.filter((d) => String(d.outletId) === String(outletId)),
    findLowStock: async () => docs.filter((d) => availableOnline(d) <= d.lowStockThreshold),
    addToLocation: async (productVariantId, location, quantity) => {
      const doc = find(productVariantId);
      if (!doc) return null;
      doc[locationField(location)] += quantity;
      return touch(doc);
    },
    addToProductLocation: async (productId, location, quantity) => {
      const doc = findProduct(productId);
      if (!doc) return null;
      doc[locationField(location)] += quantity;
      return touch(doc);
    },
    removeFromLocation: async (productVariantId, location, quantity) => {
      const doc = find(productVariantId);
      if (!doc) return null;
      const field = locationField(location);
      const ok = field === 'onlineQuantity'
        ? availableOnline(doc) >= quantity
        : doc[field] >= quantity;
      if (!ok) return null;
      doc[field] -= quantity;
      return touch(doc);
    },
    removeFromProductLocation: async (productId, location, quantity) => {
      const doc = findProduct(productId);
      if (!doc) return null;
      const field = locationField(location);
      const ok = field === 'onlineQuantity'
        ? availableOnline(doc) >= quantity
        : doc[field] >= quantity;
      if (!ok) return null;
      doc[field] -= quantity;
      return touch(doc);
    },
    addToOutletStock: async (productVariantId, outletId, quantity) => {
      let doc = findVariantOutlet(productVariantId, outletId);
      if (!doc) {
        doc = seed({ productVariantId, outletId, onlineQuantity: quantity });
        return touch(doc);
      }
      doc.onlineQuantity += quantity;
      return touch(doc);
    },
    removeFromOutletStock: async (productVariantId, outletId, quantity) => {
      const doc = findVariantOutlet(productVariantId, outletId);
      if (!doc || doc.onlineQuantity < quantity) return null;
      doc.onlineQuantity -= quantity;
      return touch(doc);
    },
    transferBetweenLocations: async (productVariantId, fromLocation, toLocation, quantity) => {
      const doc = find(productVariantId);
      if (!doc) return null;
      const fromField = locationField(fromLocation);
      const ok = fromField === 'onlineQuantity'
        ? availableOnline(doc) >= quantity
        : doc[fromField] >= quantity;
      if (!ok) return null;
      doc[fromField] -= quantity;
      doc[locationField(toLocation)] += quantity;
      return touch(doc);
    },
    transferBetweenProductLocations: async (productId, fromLocation, toLocation, quantity) => {
      const doc = findProduct(productId);
      if (!doc) return null;
      const fromField = locationField(fromLocation);
      const ok = fromField === 'onlineQuantity'
        ? availableOnline(doc) >= quantity
        : doc[fromField] >= quantity;
      if (!ok) return null;
      doc[fromField] -= quantity;
      doc[locationField(toLocation)] += quantity;
      return touch(doc);
    },
    adjustLocation: async (productVariantId, location, delta) => {
      const doc = find(productVariantId);
      if (!doc) return null;
      const field = locationField(location);
      if (delta < 0) {
        const ok = field === 'onlineQuantity'
          ? availableOnline(doc) >= -delta
          : doc[field] >= -delta;
        if (!ok) return null;
      }
      doc[field] += delta;
      return touch(doc);
    },
    adjustProductLocation: async (productId, location, delta) => {
      const doc = findProduct(productId);
      if (!doc) return null;
      const field = locationField(location);
      if (delta < 0) {
        const ok = field === 'onlineQuantity'
          ? availableOnline(doc) >= -delta
          : doc[field] >= -delta;
        if (!ok) return null;
      }
      doc[field] += delta;
      return touch(doc);
    },
    reserveOnline: async (productVariantId, quantity) => {
      const doc = find(productVariantId);
      if (!doc || availableOnline(doc) < quantity) return null;
      doc.reservedQuantity += quantity;
      return touch(doc);
    },
    reserveOnlineByProduct: async (productId, quantity) => {
      const doc = findProduct(productId);
      if (!doc || availableOnline(doc) < quantity) return null;
      doc.reservedQuantity += quantity;
      return touch(doc);
    },
    releaseReserved: async (productVariantId, quantity) => {
      const doc = find(productVariantId);
      if (!doc || doc.reservedQuantity < quantity) return null;
      doc.reservedQuantity -= quantity;
      return touch(doc);
    },
    releaseReservedByProduct: async (productId, quantity) => {
      const doc = findProduct(productId);
      if (!doc || doc.reservedQuantity < quantity) return null;
      doc.reservedQuantity -= quantity;
      return touch(doc);
    },
    consumeReserved: async (productVariantId, quantity) => {
      const doc = find(productVariantId);
      if (!doc || doc.reservedQuantity < quantity) return null;
      doc.reservedQuantity -= quantity;
      doc.onlineQuantity -= quantity;
      return touch(doc);
    },
    consumeReservedByProduct: async (productId, quantity) => {
      const doc = findProduct(productId);
      if (!doc || doc.reservedQuantity < quantity) return null;
      doc.reservedQuantity -= quantity;
      doc.onlineQuantity -= quantity;
      return touch(doc);
    },
  };
}

function createMemoryMovementRepository(initial = []) {
  const docs = [...initial];
  let nextId = 1;
  return {
    docs,
    create: async (data) => {
      const created = {
        _id: hexId(nextId++),
        fromLocation: null,
        toLocation: null,
        reason: null,
        referenceType: null,
        referenceId: null,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      docs.push(created);
      return created;
    },
    findMany: async (filter = {}, options = {}) => {
      let result = docs.filter((d) => matches(d, filter));
      result = applySort(result, options.sort);
      if (options.skip) result = result.slice(options.skip);
      if (options.limit) result = result.slice(0, options.limit);
      return result;
    },
    findManyByProductVariant: async (productVariantId, options = {}) => {
      let result = docs.filter((d) => String(d.productVariantId) === String(productVariantId));
      result = applySort(result, options.sort);
      if (options.skip) result = result.slice(options.skip);
      if (options.limit) result = result.slice(0, options.limit);
      return result;
    },
    findManyByInventory: async (inventoryId, options = {}) => {
      let result = docs.filter((d) => String(d.inventoryId) === String(inventoryId));
      result = applySort(result, options.sort);
      if (options.skip) result = result.slice(options.skip);
      if (options.limit) result = result.slice(0, options.limit);
      return result;
    },
    count: async (filter = {}) => docs.filter((d) => matches(d, filter)).length,
  };
}

function createMemoryReservationRepository(initial = []) {
  const docs = [...initial];
  let nextId = 1;
  return {
    docs,
    create: async (data) => {
      const created = {
        _id: hexId(nextId++),
        status: 'ACTIVE',
        expiresAt: null,
        metadata: {},
        resolvedAt: null,
        resolvedBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      docs.push(created);
      return created;
    },
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
    findActiveByReference: async (referenceType, referenceId) =>
      docs.find(
        (d) =>
          d.referenceType === referenceType &&
          d.referenceId === referenceId &&
          d.status === 'ACTIVE'
      ) || null,
    transitionStatus: async (id, fromStatus, toStatus, fields) => {
      const doc = docs.find((d) => String(d._id) === String(id));
      if (!doc || doc.status !== fromStatus) return null;
      Object.assign(doc, { status: toStatus, ...fields }, { updatedAt: new Date() });
      return doc;
    },
  };
}

function noopTransaction(work) {
  return work({ id: 'session-test' });
}

module.exports = {
  availableOnline,
  createMemoryVariantRepository,
  createMemoryProductRepository,
  createMemoryInventoryRepository,
  createMemoryMovementRepository,
  createMemoryReservationRepository,
  noopTransaction,
};
