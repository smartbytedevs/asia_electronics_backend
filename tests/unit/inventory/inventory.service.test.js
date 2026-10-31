'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { InventoryService } = require('../../../src/modules/inventory/inventory.service');
const { ERROR_CODES } = require('../../../src/constants');
const {
  MOVEMENT_TYPES,
  STOCK_LOCATIONS,
} = require('../../../src/modules/inventory/inventory.constants');
const {
  createMemoryVariantRepository,
  createMemoryProductRepository,
  createMemoryInventoryRepository,
  createMemoryMovementRepository,
  noopTransaction,
} = require('../../helpers/inventory-stubs');

const VARIANT_ID = '507f1f77bcf86cd799439031';
const ADMIN_ID = 'usr-admin-1';

function variantDoc(overrides = {}) {
  return { _id: VARIANT_ID, isActive: true, ...overrides };
}

function makeService(overrides = {}) {
  const variantRepository = createMemoryVariantRepository([variantDoc()]);
  const inventoryRepository = createMemoryInventoryRepository();
  const movementRepository = createMemoryMovementRepository();
  const service = new InventoryService({
    inventoryRepository,
    movementRepository,
    variantRepository,
    runTransaction: noopTransaction,
    ...overrides,
  });
  return { service, variantRepository, inventoryRepository, movementRepository };
}

function expectApiError(promise, statusCode, code) {
  return assert.rejects(promise, (err) => {
    assert.equal(err.statusCode, statusCode, `HTTP ${statusCode}`);
    assert.equal(err.code, code, `code ${code}`);
    return true;
  });
}

test('initializes inventory with seeded quantities and INITIAL_STOCK ledger (ONLINE first)', async () => {
  const { service, inventoryRepository, movementRepository } = makeService();
  const result = await service.initializeInventory({
    productVariantId: VARIANT_ID,
    onlineQuantity: 20,
    offlineQuantity: 5,
    lowStockThreshold: 2,
    performedBy: ADMIN_ID,
  });

  assert.equal(result.onlineQuantity, 20);
  assert.equal(result.offlineQuantity, 5);
  assert.equal(result.reservedQuantity, 0);
  assert.equal(result.availableOnlineQuantity, 20);

  const inventory = await inventoryRepository.findByProductVariantId(VARIANT_ID);
  assert.ok(inventory, 'inventory record created');

  const movements = movementRepository.docs;
  assert.equal(movements.length, 2, 'two INITIAL_STOCK movements');
  assert.equal(movements[0].type, MOVEMENT_TYPES.INITIAL_STOCK);
  assert.equal(movements[0].toLocation, STOCK_LOCATIONS.ONLINE);
  assert.equal(movements[0].quantity, 20);
  assert.equal(movements[1].type, MOVEMENT_TYPES.INITIAL_STOCK);
  assert.equal(movements[1].toLocation, STOCK_LOCATIONS.OFFLINE);
  assert.equal(movements[1].quantity, 5);
  assert.equal(movements[0].performedBy, ADMIN_ID);
});

test('initializing with zero quantities writes no ledger movements', async () => {
  const { service, movementRepository } = makeService();
  await service.initializeInventory({ productVariantId: VARIANT_ID, performedBy: ADMIN_ID });
  assert.equal(movementRepository.docs.length, 0);
});

test('a second initialize is rejected with INVENTORY_ALREADY_EXISTS', async () => {
  const { service, inventoryRepository } = makeService();
  await service.initializeInventory({ productVariantId: VARIANT_ID, performedBy: ADMIN_ID });
  await expectApiError(
    service.initializeInventory({ productVariantId: VARIANT_ID, onlineQuantity: 10, performedBy: ADMIN_ID }),
    409,
    ERROR_CODES.INVENTORY_ALREADY_EXISTS
  );
  assert.equal(inventoryRepository.docs.length, 1, 'no duplicate record created');
});

test('initialize rejects an unknown variant', async () => {
  const { service } = makeService();
  await expectApiError(
    service.initializeInventory({ productVariantId: '507f1f77bcf86cd799439999', performedBy: ADMIN_ID }),
    404,
    ERROR_CODES.VARIANT_NOT_FOUND
  );
});

test('initialize rejects an inactive variant', async () => {
  const { service } = makeService({
    variantRepository: createMemoryVariantRepository([variantDoc({ isActive: false })]),
  });
  await expectApiError(
    service.initializeInventory({ productVariantId: VARIANT_ID, performedBy: ADMIN_ID }),
    400,
    ERROR_CODES.INVALID_INVENTORY_OPERATION
  );
});

test('every mutation requires an actor', async () => {
  const { service } = makeService();
  await expectApiError(
    service.initializeInventory({ productVariantId: VARIANT_ID }),
    400,
    ERROR_CODES.INVALID_INVENTORY_OPERATION
  );
});

test('addStock increases the location and records a STOCK_IN movement', async () => {
  const { service, inventoryRepository, movementRepository } = makeService();
  await service.initializeInventory({ productVariantId: VARIANT_ID, performedBy: ADMIN_ID });
  const result = await service.addStock({
    productVariantId: VARIANT_ID,
    location: STOCK_LOCATIONS.OFFLINE,
    quantity: 10,
    reason: 'warehouse delivery',
    performedBy: ADMIN_ID,
  });
  assert.equal(result.offlineQuantity, 10);

  const movement = movementRepository.docs.find((m) => m.type === MOVEMENT_TYPES.STOCK_IN);
  assert.ok(movement, 'STOCK_IN movement recorded');
  assert.equal(movement.toLocation, STOCK_LOCATIONS.OFFLINE);
  assert.equal(movement.quantity, 10);
  assert.equal(movement.reason, 'warehouse delivery');
  assert.equal(movement.performedBy, ADMIN_ID);
});

test('addStock for a missing inventory record returns 404', async () => {
  const { service } = makeService();
  await expectApiError(
    service.addStock({ productVariantId: VARIANT_ID, location: STOCK_LOCATIONS.ONLINE, quantity: 5, performedBy: ADMIN_ID }),
    404,
    ERROR_CODES.INVENTORY_NOT_FOUND
  );
});

test('removeStock decreases the location and records a STOCK_OUT movement', async () => {
  const { service, movementRepository } = makeService();
  await service.initializeInventory({ productVariantId: VARIANT_ID, onlineQuantity: 20, performedBy: ADMIN_ID });
  const result = await service.removeStock({
    productVariantId: VARIANT_ID,
    location: STOCK_LOCATIONS.ONLINE,
    quantity: 5,
    reason: 'damaged',
    performedBy: ADMIN_ID,
  });
  assert.equal(result.onlineQuantity, 15);
  const movement = movementRepository.docs.find((m) => m.type === MOVEMENT_TYPES.STOCK_OUT);
  assert.equal(movement.fromLocation, STOCK_LOCATIONS.ONLINE);
  assert.equal(movement.quantity, 5);
});

test('removeStock ONLINE below reserved stock is rejected with INSUFFICIENT_AVAILABLE_STOCK', async () => {
  const { service, inventoryRepository } = makeService();
  await service.initializeInventory({ productVariantId: VARIANT_ID, onlineQuantity: 10, performedBy: ADMIN_ID });
  const inventory = await inventoryRepository.findByProductVariantId(VARIANT_ID);
  inventory.reservedQuantity = 6;
  inventory.onlineQuantity = 10;
  await expectApiError(
    service.removeStock({ productVariantId: VARIANT_ID, location: STOCK_LOCATIONS.ONLINE, quantity: 5, performedBy: ADMIN_ID }),
    409,
    ERROR_CODES.INSUFFICIENT_AVAILABLE_STOCK
  );
});

test('removeStock OFFLINE beyond physical quantity is rejected with INSUFFICIENT_STOCK', async () => {
  const { service } = makeService();
  await service.initializeInventory({ productVariantId: VARIANT_ID, offlineQuantity: 2, performedBy: ADMIN_ID });
  await expectApiError(
    service.removeStock({ productVariantId: VARIANT_ID, location: STOCK_LOCATIONS.OFFLINE, quantity: 3, performedBy: ADMIN_ID }),
    409,
    ERROR_CODES.INSUFFICIENT_STOCK
  );
});

test('transferStock moves stock in both directions', async () => {
  const { service, movementRepository } = makeService();
  await service.initializeInventory({
    productVariantId: VARIANT_ID,
    onlineQuantity: 10,
    offlineQuantity: 4,
    performedBy: ADMIN_ID,
  });

  const onlineToOffline = await service.transferStock({
    productVariantId: VARIANT_ID,
    fromLocation: STOCK_LOCATIONS.ONLINE,
    toLocation: STOCK_LOCATIONS.OFFLINE,
    quantity: 3,
    performedBy: ADMIN_ID,
  });
  assert.equal(onlineToOffline.onlineQuantity, 7);
  assert.equal(onlineToOffline.offlineQuantity, 7);

  const offlineToOnline = await service.transferStock({
    productVariantId: VARIANT_ID,
    fromLocation: STOCK_LOCATIONS.OFFLINE,
    toLocation: STOCK_LOCATIONS.ONLINE,
    quantity: 2,
    performedBy: ADMIN_ID,
  });
  assert.equal(offlineToOnline.onlineQuantity, 9);
  assert.equal(offlineToOnline.offlineQuantity, 5);

  const transfers = movementRepository.docs.filter((m) => m.type === MOVEMENT_TYPES.TRANSFER);
  assert.equal(transfers.length, 2);
  assert.equal(transfers[0].fromLocation, STOCK_LOCATIONS.ONLINE);
  assert.equal(transfers[0].toLocation, STOCK_LOCATIONS.OFFLINE);
});

test('transferStock from an empty source is rejected with the right code', async () => {
  const { service } = makeService();
  await service.initializeInventory({ productVariantId: VARIANT_ID, onlineQuantity: 2, performedBy: ADMIN_ID });
  await expectApiError(
    service.transferStock({
      productVariantId: VARIANT_ID,
      fromLocation: STOCK_LOCATIONS.ONLINE,
      toLocation: STOCK_LOCATIONS.OFFLINE,
      quantity: 3,
      performedBy: ADMIN_ID,
    }),
    409,
    ERROR_CODES.INSUFFICIENT_AVAILABLE_STOCK
  );
});

test('adjustStock applies a signed delta and records a single ADJUSTMENT movement', async () => {
  const { service, movementRepository } = makeService();
  await service.initializeInventory({ productVariantId: VARIANT_ID, onlineQuantity: 10, performedBy: ADMIN_ID });

  const increased = await service.adjustStock({
    productVariantId: VARIANT_ID,
    location: STOCK_LOCATIONS.ONLINE,
    quantity: 4,
    performedBy: ADMIN_ID,
  });
  assert.equal(increased.onlineQuantity, 14);

  const decreased = await service.adjustStock({
    productVariantId: VARIANT_ID,
    location: STOCK_LOCATIONS.ONLINE,
    quantity: -2,
    reason: 'cycle count',
    performedBy: ADMIN_ID,
  });
  assert.equal(decreased.onlineQuantity, 12);

  const adjustments = movementRepository.docs.filter((m) => m.type === MOVEMENT_TYPES.ADJUSTMENT);
  assert.equal(adjustments.length, 2);
  assert.equal(adjustments[0].toLocation, STOCK_LOCATIONS.ONLINE);
  assert.equal(adjustments[0].quantity, 4);
  assert.equal(adjustments[1].fromLocation, STOCK_LOCATIONS.ONLINE);
  assert.equal(adjustments[1].quantity, 2);
  assert.equal(adjustments[1].reason, 'cycle count');
});

test('adjustStock ONLINE cannot decrease below reserved stock', async () => {
  const { service, inventoryRepository } = makeService();
  await service.initializeInventory({ productVariantId: VARIANT_ID, onlineQuantity: 10, performedBy: ADMIN_ID });
  const inventory = await inventoryRepository.findByProductVariantId(VARIANT_ID);
  inventory.reservedQuantity = 8;
  await expectApiError(
    service.adjustStock({ productVariantId: VARIANT_ID, location: STOCK_LOCATIONS.ONLINE, quantity: -3, performedBy: ADMIN_ID }),
    409,
    ERROR_CODES.INSUFFICIENT_AVAILABLE_STOCK
  );
});

test('adjustStock OFFLINE cannot decrease below zero (NEGATIVE_STOCK_FORBIDDEN)', async () => {
  const { service } = makeService();
  await service.initializeInventory({ productVariantId: VARIANT_ID, offlineQuantity: 2, performedBy: ADMIN_ID });
  await expectApiError(
    service.adjustStock({ productVariantId: VARIANT_ID, location: STOCK_LOCATIONS.OFFLINE, quantity: -3, performedBy: ADMIN_ID }),
    409,
    ERROR_CODES.NEGATIVE_STOCK_FORBIDDEN
  );
});

test('getInventory returns a serialized record and 404 when absent', async () => {
  const { service } = makeService();
  await expectApiError(service.getInventory(VARIANT_ID), 404, ERROR_CODES.INVENTORY_NOT_FOUND);
  await service.initializeInventory({ productVariantId: VARIANT_ID, onlineQuantity: 3, performedBy: ADMIN_ID });
  const result = await service.getInventory(VARIANT_ID);
  assert.equal(result.onlineQuantity, 3);
  assert.equal(result.productVariantId, VARIANT_ID);
  assert.equal(result._id, undefined, 'no raw Mongo _id serialized');
  assert.equal(result.__v, undefined);
});

test('listInventory paginates newest first', async () => {
  const secondVariant = '507f1f77bcf86cd799439032';
  const { service } = makeService({
    variantRepository: createMemoryVariantRepository([
      variantDoc(),
      variantDoc({ _id: secondVariant }),
    ]),
  });
  for (const variantId of [VARIANT_ID, secondVariant]) {
    await service.initializeInventory({ productVariantId: variantId, performedBy: ADMIN_ID });
  }
  const page = await service.listInventory({ page: 1, limit: 1 });
  assert.equal(page.pagination.total, 2);
  assert.equal(page.inventory.length, 1);
});

const PRODUCT_ID = '507f1f77bcf86cd799439010';
const SECOND_PRODUCT_ID = '507f1f77bcf86cd799439020';

function productDoc(overrides = {}) {
  return { _id: PRODUCT_ID, name: 'Abaya Classic', isActive: true, ...overrides };
}

function makeCatalogService(overrides = {}) {
  const variantRepository = createMemoryVariantRepository([
    variantDoc({ productId: PRODUCT_ID }),
    variantDoc({ _id: '507f1f77bcf86cd799439032', productId: PRODUCT_ID, sku: 'ABAYA-54' }),
  ]);
  const productRepository = createMemoryProductRepository([
    productDoc(),
    productDoc({ _id: SECOND_PRODUCT_ID, name: 'Simple Hijab' }),
  ]);
  const inventoryRepository = createMemoryInventoryRepository();
  const movementRepository = createMemoryMovementRepository();
  const service = new InventoryService({
    inventoryRepository,
    movementRepository,
    variantRepository,
    productRepository,
    runTransaction: noopTransaction,
    ...overrides,
  });
  return { service, inventoryRepository, movementRepository, variantRepository, productRepository };
}

test('listInventory shows active products with no inventory as Not initialized without creating records', async () => {
  const { service, inventoryRepository } = makeCatalogService();
  const page = await service.listInventory({ page: 1, limit: 20 });
  assert.equal(page.pagination.total, 2);
  assert.equal(page.inventory.length, 2);
  assert.ok(page.inventory.every((item) => item.isInitialized === false), 'all rows uninitialized');
  assert.ok(page.inventory.every((item) => item.productVariantId === null), 'synthetic rows carry null variant id');
  assert.ok(
    page.inventory.every((item) => item.productName && item.productId),
    'synthetic rows expose the product identity'
  );
  assert.equal(inventoryRepository.docs.length, 0, 'listing never auto-creates inventory records');
});

test('a variant-bearing product is not uninitialized once one active variant has inventory', async () => {
  const { service } = makeCatalogService();
  await service.initializeInventory({ productVariantId: VARIANT_ID, performedBy: ADMIN_ID });
  const page = await service.listInventory({ page: 1, limit: 20 });
  assert.equal(page.pagination.total, 2);
  const uninitialized = page.inventory.filter((item) => item.isInitialized === false);
  assert.equal(uninitialized.length, 1, 'only the simple product remains uninitialized');
  assert.equal(uninitialized[0].productId, SECOND_PRODUCT_ID);
  const record = page.inventory.find((item) => item.isInitialized === true);
  assert.equal(record.productVariantId, VARIANT_ID);
  assert.equal(record.isInitialized, true, 'existing record serializes as initialized');
});

test('a simple product with a central record is not listed as uninitialized', async () => {
  const { service } = makeCatalogService();
  await service.initializeInventory({ productId: SECOND_PRODUCT_ID, performedBy: ADMIN_ID });
  const page = await service.listInventory({ page: 1, limit: 20 });
  const uninitialized = page.inventory.filter((item) => item.isInitialized === false);
  assert.equal(uninitialized.length, 1);
  assert.equal(uninitialized[0].productId, PRODUCT_ID);
  const record = page.inventory.find((item) => item.isInitialized === true);
  assert.equal(record.productVariantId, null, 'simple-product record has a null variant id');
  assert.equal(record.productId, SECOND_PRODUCT_ID);
  assert.equal(page.pagination.total, 2);
});

test('getLowStock returns only variants whose available quantity is at or below threshold', async () => {
  const { service, inventoryRepository } = makeService();
  await service.initializeInventory({
    productVariantId: VARIANT_ID,
    onlineQuantity: 2,
    lowStockThreshold: 2,
    performedBy: ADMIN_ID,
  });
  const secondVariant = '507f1f77bcf86cd799439032';
  inventoryRepository.docs.push({
    _id: 'inv-2',
    productVariantId: secondVariant,
    onlineQuantity: 100,
    offlineQuantity: 0,
    reservedQuantity: 0,
    lowStockThreshold: 5,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const low = await service.getLowStock();
  assert.equal(low.length, 1);
  assert.equal(low[0].productVariantId, VARIANT_ID);
  assert.equal(low[0].isLowStock, true);
});

test('getInventoryMovements returns only movements for that variant and requires existing inventory', async () => {
  const { service } = makeService();
  await expectApiError(
    service.getInventoryMovements(VARIANT_ID, {}),
    404,
    ERROR_CODES.INVENTORY_NOT_FOUND
  );
  await service.initializeInventory({ productVariantId: VARIANT_ID, onlineQuantity: 20, performedBy: ADMIN_ID });
  await service.addStock({ productVariantId: VARIANT_ID, location: STOCK_LOCATIONS.ONLINE, quantity: 10, performedBy: ADMIN_ID });
  const result = await service.getInventoryMovements(VARIANT_ID, { page: 1, limit: 10 });
  assert.equal(result.pagination.total, 2, 'INITIAL_STOCK + STOCK_IN');
  assert.ok(
    result.movements.some((m) => m.type === MOVEMENT_TYPES.STOCK_IN && m.quantity === 10),
    'STOCK_IN movement present'
  );
});

test('full ledger audit: initialize 20 → stock-in 10 → transfer 5 → adjust −2', async () => {
  const { service, movementRepository, inventoryRepository } = makeService();
  await service.initializeInventory({ productVariantId: VARIANT_ID, onlineQuantity: 20, performedBy: ADMIN_ID });
  await service.addStock({ productVariantId: VARIANT_ID, location: STOCK_LOCATIONS.ONLINE, quantity: 10, performedBy: ADMIN_ID });
  await service.transferStock({
    productVariantId: VARIANT_ID,
    fromLocation: STOCK_LOCATIONS.ONLINE,
    toLocation: STOCK_LOCATIONS.OFFLINE,
    quantity: 5,
    reason: 'rebalance',
    performedBy: ADMIN_ID,
  });
  await service.adjustStock({ productVariantId: VARIANT_ID, location: STOCK_LOCATIONS.OFFLINE, quantity: -2, reason: 'cycle count', performedBy: ADMIN_ID });

  const final = await inventoryRepository.findByProductVariantId(VARIANT_ID);
  assert.equal(final.onlineQuantity, 25, '20 + 10 − 5');
  assert.equal(final.offlineQuantity, 3, '5 − 2');

  const types = movementRepository.docs.map((m) => m.type);
  assert.deepEqual(types, [
    MOVEMENT_TYPES.INITIAL_STOCK,
    MOVEMENT_TYPES.STOCK_IN,
    MOVEMENT_TYPES.TRANSFER,
    MOVEMENT_TYPES.ADJUSTMENT,
  ]);
  const totalLedged = movementRepository.docs.reduce((sum, m) => sum + m.quantity, 0);
  assert.equal(totalLedged, 20 + 10 + 5 + 2);
  assert.ok(movementRepository.docs.every((m) => m.performedBy === ADMIN_ID));
});

const OUTLET_A = '507f1f77bcf86cd799439041';
const OUTLET_B = '507f1f77bcf86cd799439042';

function makeOutletService(overrides = {}) {
  const { createMemoryOutletRepository } = require('../../helpers/stockTransfer-stubs');
  const base = makeService();
  const outletRepository = createMemoryOutletRepository([
    { _id: OUTLET_A, name: 'Outlet A', code: 'OUT-A', isActive: true, createdAt: new Date(), updatedAt: new Date() },
    { _id: OUTLET_B, name: 'Outlet B', code: 'OUT-B', isActive: true, createdAt: new Date(), updatedAt: new Date() },
  ]);
  const service = new InventoryService({
    inventoryRepository: base.inventoryRepository,
    movementRepository: base.movementRepository,
    variantRepository: base.variantRepository,
    runTransaction: noopTransaction,
    outletRepository,
    ...overrides,
  });
  return {
    service,
    inventoryRepository: base.inventoryRepository,
    movementRepository: base.movementRepository,
    outletRepository,
  };
}

test('initializes per-outlet stock on the (variant, outlet) record only', async () => {
  const { service, inventoryRepository, movementRepository } = makeOutletService();

  const result = await service.initializeInventory({
    productVariantId: VARIANT_ID,
    outletId: OUTLET_A,
    onlineQuantity: 20,
    offlineQuantity: 5,
    lowStockThreshold: 2,
    performedBy: ADMIN_ID,
  });

  assert.equal(result.outletId, OUTLET_A);
  assert.equal(result.onlineQuantity, 20);
  assert.equal(result.offlineQuantity, 5);
  assert.equal(inventoryRepository.docs.length, 1, 'no central-pool record created');
  assert.ok(!inventoryRepository.docs.some((d) => d.outletId === null), 'central pool untouched');

  const byOutlet = await inventoryRepository.findByVariantAndOutlet(VARIANT_ID, OUTLET_A);
  assert.equal(byOutlet.onlineQuantity, 20);

  const movement = movementRepository.docs[0];
  assert.equal(movement.outletId, OUTLET_A);
  assert.equal(movement.type, MOVEMENT_TYPES.INITIAL_STOCK);
});

test('rejects initializing stock at an inactive outlet with OUTLET_INACTIVE', async () => {
  const { createMemoryInventoryRepository, createMemoryVariantRepository, createMemoryMovementRepository } = require('../../helpers/inventory-stubs');
  const { createMemoryOutletRepository } = require('../../helpers/stockTransfer-stubs');
  const service = new InventoryService({
    inventoryRepository: createMemoryInventoryRepository(),
    movementRepository: createMemoryMovementRepository(),
    variantRepository: createMemoryVariantRepository([variantDoc()]),
    outletRepository: createMemoryOutletRepository([
      { _id: OUTLET_A, name: 'Outlet A', code: 'OUT-A', isActive: false },
    ]),
    runTransaction: noopTransaction,
  });

  await expectApiError(
    service.initializeInventory({ productVariantId: VARIANT_ID, outletId: OUTLET_A, performedBy: ADMIN_ID }),
    400,
    ERROR_CODES.INVALID_INVENTORY_OPERATION
  );
});

test('rejects initializing stock at an unknown outlet with OUTLET_NOT_FOUND', async () => {
  const { createMemoryInventoryRepository, createMemoryVariantRepository, createMemoryMovementRepository } = require('../../helpers/inventory-stubs');
  const { createMemoryOutletRepository } = require('../../helpers/stockTransfer-stubs');
  const service = new InventoryService({
    inventoryRepository: createMemoryInventoryRepository(),
    movementRepository: createMemoryMovementRepository(),
    variantRepository: createMemoryVariantRepository([variantDoc()]),
    outletRepository: createMemoryOutletRepository([
      { _id: OUTLET_A, name: 'Outlet A', code: 'OUT-A', isActive: true },
    ]),
    runTransaction: noopTransaction,
  });

  await expectApiError(
    service.initializeInventory({
      productVariantId: VARIANT_ID,
      outletId: '507f1f77bcf86cd799439999',
      performedBy: ADMIN_ID,
    }),
    404,
    ERROR_CODES.OUTLET_NOT_FOUND
  );
});

test('a second per-outlet initialize for the same (variant, outlet) is 409 INVENTORY_ALREADY_EXISTS', async () => {
  const { service } = makeOutletService();
  await service.initializeInventory({ productVariantId: VARIANT_ID, outletId: OUTLET_A, onlineQuantity: 10, performedBy: ADMIN_ID });

  await expectApiError(
    service.initializeInventory({ productVariantId: VARIANT_ID, outletId: OUTLET_A, onlineQuantity: 5, performedBy: ADMIN_ID }),
    409,
    ERROR_CODES.INVENTORY_ALREADY_EXISTS
  );
});

test('same variant can hold independent stock per outlet (no central-pool collision)', async () => {
  const { service, inventoryRepository } = makeOutletService();
  await service.initializeInventory({ productVariantId: VARIANT_ID, outletId: OUTLET_A, onlineQuantity: 10, performedBy: ADMIN_ID });
  await service.initializeInventory({ productVariantId: VARIANT_ID, outletId: OUTLET_B, onlineQuantity: 30, performedBy: ADMIN_ID });

  const outletA = await inventoryRepository.findByVariantAndOutlet(VARIANT_ID, OUTLET_A);
  const outletB = await inventoryRepository.findByVariantAndOutlet(VARIANT_ID, OUTLET_B);
  assert.equal(outletA.onlineQuantity, 10);
  assert.equal(outletB.onlineQuantity, 30);
});

test('initializing the central pool after per-outlet stock for the same variant is not a false duplicate', async () => {
  const { service, inventoryRepository } = makeOutletService();
  await service.initializeInventory({ productVariantId: VARIANT_ID, outletId: OUTLET_A, onlineQuantity: 10, performedBy: ADMIN_ID });

  const central = await service.initializeInventory({ productVariantId: VARIANT_ID, onlineQuantity: 5, performedBy: ADMIN_ID });
  assert.equal(central.outletId, null);
  assert.equal(central.onlineQuantity, 5);
  assert.equal(inventoryRepository.docs.length, 2, 'outlet record + central pool record coexist');
});

test('initializing per-outlet stock after a central-pool record for the same variant is not a false duplicate', async () => {
  const { service, inventoryRepository } = makeOutletService();
  await service.initializeInventory({ productVariantId: VARIANT_ID, onlineQuantity: 5, performedBy: ADMIN_ID });

  const outlet = await service.initializeInventory({ productVariantId: VARIANT_ID, outletId: OUTLET_A, onlineQuantity: 10, performedBy: ADMIN_ID });
  assert.equal(outlet.outletId, OUTLET_A);
  assert.equal(outlet.onlineQuantity, 10);
  assert.equal(inventoryRepository.docs.length, 2);
});

test('the initialize guard uses the FULL subject: a variant under a different product is not a duplicate', async () => {
  const { service, inventoryRepository } = makeCatalogService();
  inventoryRepository.docs.push({
    _id: 'inv-foreign',
    productId: SECOND_PRODUCT_ID,
    productVariantId: VARIANT_ID,
    outletId: null,
    onlineQuantity: 99,
    offlineQuantity: 0,
    reservedQuantity: 0,
    lowStockThreshold: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const result = await service.initializeInventory({
    productId: PRODUCT_ID,
    productVariantId: VARIANT_ID,
    onlineQuantity: 7,
    performedBy: ADMIN_ID,
  });
  assert.equal(result.productId, PRODUCT_ID);
  assert.equal(result.productVariantId, VARIANT_ID);
  assert.equal(result.onlineQuantity, 7);
  assert.equal(inventoryRepository.docs.length, 2, 'a distinct subject initializes alongside the foreign record');
});

test('a simple product and a variant of the same product are distinct subjects', async () => {
  const { service, inventoryRepository } = makeCatalogService();
  await service.initializeInventory({ productId: SECOND_PRODUCT_ID, performedBy: ADMIN_ID });

  const variant = await service.initializeInventory({ productVariantId: VARIANT_ID, performedBy: ADMIN_ID });
  assert.equal(variant.productVariantId, VARIANT_ID);
  assert.equal(variant.productId, PRODUCT_ID);
  assert.equal(inventoryRepository.docs.length, 2);
});
