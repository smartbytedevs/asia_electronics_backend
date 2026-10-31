'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { StockTransferService } = require('../../../src/modules/stockTransfers/stockTransfer.service');
const { ERROR_CODES } = require('../../../src/constants');
const { MOVEMENT_TYPES } = require('../../../src/modules/inventory/inventory.constants');
const {
  createMemoryVariantRepository,
  createMemoryInventoryRepository,
  createMemoryMovementRepository,
  noopTransaction,
} = require('../../helpers/inventory-stubs');
const {
  createMemoryOutletRepository,
  createMemoryStockTransferRepository,
} = require('../../helpers/stockTransfer-stubs');

const VARIANT_ID = '507f1f77bcf86cd799439031';
const SOURCE_OUTLET_ID = '507f1f77bcf86cd799439041';
const DEST_OUTLET_ID = '507f1f77bcf86cd799439042';
const OTHER_OUTLET_ID = '507f1f77bcf86cd799439043';
const ADMIN_ID = 'usr-admin-1';

function variantDoc(overrides = {}) {
  return { _id: VARIANT_ID, sku: 'ABAYA-52', isActive: true, ...overrides };
}

function outletDoc(overrides = {}) {
  return { _id: SOURCE_OUTLET_ID, name: 'Outlet A', code: 'OUT-A', isActive: true, ...overrides };
}

function makeService(overrides = {}) {
  const variantRepository = createMemoryVariantRepository([variantDoc()]);
  const inventoryRepository = createMemoryInventoryRepository();
  const movementRepository = createMemoryMovementRepository();
  const outletRepository = createMemoryOutletRepository([
    outletDoc(),
    outletDoc({ _id: DEST_OUTLET_ID, name: 'Outlet B', code: 'OUT-B' }),
    outletDoc({ _id: OTHER_OUTLET_ID, name: 'Outlet C', code: 'OUT-C' }),
  ]);
  const transferRepository = createMemoryStockTransferRepository();
  const service = new StockTransferService({
    transferRepository,
    inventoryRepository,
    movementRepository,
    variantRepository,
    outletRepository,
    runTransaction: noopTransaction,
    ...overrides,
  });
  return {
    service,
    variantRepository,
    inventoryRepository,
    movementRepository,
    outletRepository,
    transferRepository,
  };
}

function seedOutletStock(inventoryRepository, outletId, quantity) {
  const doc = {
    _id: `inv-${String(outletId).slice(-4)}`,
    productVariantId: VARIANT_ID,
    outletId,
    onlineQuantity: quantity,
    offlineQuantity: 0,
    reservedQuantity: 0,
    lowStockThreshold: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  inventoryRepository.docs.push(doc);
  return doc;
}

function expectApiError(promise, statusCode, code) {
  return assert.rejects(promise, (err) => {
    assert.equal(err.statusCode, statusCode, `HTTP ${statusCode}`);
    assert.equal(err.code, code, `code ${code}`);
    return true;
  });
}

test('transfers stock between outlets atomically and records audit movements', async () => {
  const { service, inventoryRepository, movementRepository, transferRepository } = makeService();
  seedOutletStock(inventoryRepository, SOURCE_OUTLET_ID, 20);
  seedOutletStock(inventoryRepository, DEST_OUTLET_ID, 5);

  const transfer = await service.createTransfer({
    sourceOutletId: SOURCE_OUTLET_ID,
    destinationOutletId: DEST_OUTLET_ID,
    productVariantId: VARIANT_ID,
    quantity: 5,
    reason: 'replenish gulshan',
    performedBy: ADMIN_ID,
  });

  assert.equal(transfer.status, 'COMPLETED');
  assert.ok(transfer.completedAt, 'completedAt set');
  assert.equal(transfer.createdBy, ADMIN_ID, 'createdBy comes from the actor');
  assert.equal(transfer.quantity, 5);

  const source = inventoryRepository.docs.find((d) => String(d.outletId) === SOURCE_OUTLET_ID);
  const dest = inventoryRepository.docs.find((d) => String(d.outletId) === DEST_OUTLET_ID);
  assert.equal(source.onlineQuantity, 15, 'source decreased');
  assert.equal(dest.onlineQuantity, 10, 'destination increased');

  const movements = movementRepository.docs;
  assert.equal(movements.length, 2, 'one movement per side');
  const sourceMovement = movements.find((m) => m.type === MOVEMENT_TYPES.TRANSFER_OUT);
  const destMovement = movements.find((m) => m.type === MOVEMENT_TYPES.TRANSFER_IN);
  assert.ok(sourceMovement, 'TRANSFER_OUT written');
  assert.ok(destMovement, 'TRANSFER_IN written');
  assert.equal(sourceMovement.quantity, 5);
  assert.equal(destMovement.quantity, 5);
  assert.equal(sourceMovement.outletId, SOURCE_OUTLET_ID);
  assert.equal(destMovement.outletId, DEST_OUTLET_ID);
  assert.equal(sourceMovement.performedBy, ADMIN_ID);
  assert.equal(destMovement.performedBy, ADMIN_ID);
  assert.equal(sourceMovement.referenceType, 'STOCK_TRANSFER');
  assert.equal(sourceMovement.referenceId, transfer.id, 'movements reference the transfer');
  assert.equal(destMovement.referenceId, transfer.id);

  assert.equal(transferRepository.docs.length, 1);
});

test('seeds the destination outlet record when it has no inventory yet', async () => {
  const { service, inventoryRepository } = makeService();
  seedOutletStock(inventoryRepository, SOURCE_OUTLET_ID, 10);

  await service.createTransfer({
    sourceOutletId: SOURCE_OUTLET_ID,
    destinationOutletId: DEST_OUTLET_ID,
    productVariantId: VARIANT_ID,
    quantity: 4,
    performedBy: ADMIN_ID,
  });

  const source = inventoryRepository.docs.find((d) => String(d.outletId) === SOURCE_OUTLET_ID);
  const dest = inventoryRepository.docs.find((d) => String(d.outletId) === DEST_OUTLET_ID);
  assert.equal(source.onlineQuantity, 6);
  assert.ok(dest, 'destination record created');
  assert.equal(dest.onlineQuantity, 4);
  assert.equal(dest.productVariantId, VARIANT_ID);
});

test('rejects a transfer with insufficient source stock and writes nothing', async () => {
  const { service, inventoryRepository, movementRepository, transferRepository } = makeService();
  seedOutletStock(inventoryRepository, SOURCE_OUTLET_ID, 3);
  seedOutletStock(inventoryRepository, DEST_OUTLET_ID, 0);

  await expectApiError(
    service.createTransfer({
      sourceOutletId: SOURCE_OUTLET_ID,
      destinationOutletId: DEST_OUTLET_ID,
      productVariantId: VARIANT_ID,
      quantity: 5,
      performedBy: ADMIN_ID,
    }),
    409,
    ERROR_CODES.INSUFFICIENT_STOCK
  );

  const source = inventoryRepository.docs.find((d) => String(d.outletId) === SOURCE_OUTLET_ID);
  assert.equal(source.onlineQuantity, 3, 'source untouched');
  assert.equal(movementRepository.docs.length, 0, 'no movements on failure');
  assert.equal(transferRepository.docs.length, 0, 'no transfer record on failure');
});

test('rejects a transfer when the source outlet has no inventory record', async () => {
  const { service, movementRepository, transferRepository } = makeService();

  await expectApiError(
    service.createTransfer({
      sourceOutletId: SOURCE_OUTLET_ID,
      destinationOutletId: DEST_OUTLET_ID,
      productVariantId: VARIANT_ID,
      quantity: 1,
      performedBy: ADMIN_ID,
    }),
    409,
    ERROR_CODES.INSUFFICIENT_STOCK
  );
  assert.equal(movementRepository.docs.length, 0);
  assert.equal(transferRepository.docs.length, 0);
});

test('rejects an inactive source outlet', async () => {
  const { service, inventoryRepository, outletRepository } = makeService();
  seedOutletStock(inventoryRepository, SOURCE_OUTLET_ID, 10);
  outletRepository.docs[0].isActive = false;

  await expectApiError(
    service.createTransfer({
      sourceOutletId: SOURCE_OUTLET_ID,
      destinationOutletId: DEST_OUTLET_ID,
      productVariantId: VARIANT_ID,
      quantity: 1,
      performedBy: ADMIN_ID,
    }),
    400,
    ERROR_CODES.OUTLET_INACTIVE
  );
});

test('rejects an inactive destination outlet', async () => {
  const { service, inventoryRepository, outletRepository } = makeService();
  seedOutletStock(inventoryRepository, SOURCE_OUTLET_ID, 10);
  const dest = outletRepository.docs.find((o) => String(o._id) === DEST_OUTLET_ID);
  dest.isActive = false;

  await expectApiError(
    service.createTransfer({
      sourceOutletId: SOURCE_OUTLET_ID,
      destinationOutletId: DEST_OUTLET_ID,
      productVariantId: VARIANT_ID,
      quantity: 1,
      performedBy: ADMIN_ID,
    }),
    400,
    ERROR_CODES.OUTLET_INACTIVE
  );
});

test('rejects an unknown outlet', async () => {
  const { service, inventoryRepository } = makeService();
  seedOutletStock(inventoryRepository, SOURCE_OUTLET_ID, 10);

  await expectApiError(
    service.createTransfer({
      sourceOutletId: SOURCE_OUTLET_ID,
      destinationOutletId: '507f1f77bcf86cd799439999',
      productVariantId: VARIANT_ID,
      quantity: 1,
      performedBy: ADMIN_ID,
    }),
    404,
    ERROR_CODES.OUTLET_NOT_FOUND
  );
});

test('rejects same source and destination outlet', async () => {
  const { service } = makeService();

  await expectApiError(
    service.createTransfer({
      sourceOutletId: SOURCE_OUTLET_ID,
      destinationOutletId: SOURCE_OUTLET_ID,
      productVariantId: VARIANT_ID,
      quantity: 1,
      performedBy: ADMIN_ID,
    }),
    400,
    ERROR_CODES.INVALID_STOCK_TRANSFER
  );
});

test('rejects invalid quantities', async () => {
  const { service } = makeService();

  for (const quantity of [0, -1, 1.5, '5', null, undefined]) {
    await expectApiError(
      service.createTransfer({
        sourceOutletId: SOURCE_OUTLET_ID,
        destinationOutletId: DEST_OUTLET_ID,
        productVariantId: VARIANT_ID,
        quantity,
        performedBy: ADMIN_ID,
      }),
      400,
      ERROR_CODES.INVALID_STOCK_TRANSFER
    );
  }
});

test('rejects an unknown product variant', async () => {
  const { service, inventoryRepository } = makeService();
  seedOutletStock(inventoryRepository, SOURCE_OUTLET_ID, 10);

  await expectApiError(
    service.createTransfer({
      sourceOutletId: SOURCE_OUTLET_ID,
      destinationOutletId: DEST_OUTLET_ID,
      productVariantId: '507f1f77bcf86cd799439999',
      quantity: 1,
      performedBy: ADMIN_ID,
    }),
    404,
    ERROR_CODES.VARIANT_NOT_FOUND
  );
});

test('rejects an inactive product variant', async () => {
  const { service, inventoryRepository } = makeService({
    variantRepository: createMemoryVariantRepository([variantDoc({ isActive: false })]),
  });
  seedOutletStock(inventoryRepository, SOURCE_OUTLET_ID, 10);

  await expectApiError(
    service.createTransfer({
      sourceOutletId: SOURCE_OUTLET_ID,
      destinationOutletId: DEST_OUTLET_ID,
      productVariantId: VARIANT_ID,
      quantity: 1,
      performedBy: ADMIN_ID,
    }),
    400,
    ERROR_CODES.INVALID_STOCK_TRANSFER
  );
});

test('requires the actor (createdBy must come from the authenticated user)', async () => {
  const { service } = makeService();

  await expectApiError(
    service.createTransfer({
      sourceOutletId: SOURCE_OUTLET_ID,
      destinationOutletId: DEST_OUTLET_ID,
      productVariantId: VARIANT_ID,
      quantity: 1,
    }),
    400,
    ERROR_CODES.INVALID_STOCK_TRANSFER
  );
});

test('two simultaneous transfers cannot oversell the source outlet', async () => {
  const { service, inventoryRepository, transferRepository } = makeService();
  seedOutletStock(inventoryRepository, SOURCE_OUTLET_ID, 10);
  seedOutletStock(inventoryRepository, DEST_OUTLET_ID, 0);
  seedOutletStock(inventoryRepository, OTHER_OUTLET_ID, 0);

  const [first, second] = await Promise.allSettled([
    service.createTransfer({
      sourceOutletId: SOURCE_OUTLET_ID,
      destinationOutletId: DEST_OUTLET_ID,
      productVariantId: VARIANT_ID,
      quantity: 6,
      performedBy: ADMIN_ID,
    }),
    service.createTransfer({
      sourceOutletId: SOURCE_OUTLET_ID,
      destinationOutletId: OTHER_OUTLET_ID,
      productVariantId: VARIANT_ID,
      quantity: 6,
      performedBy: ADMIN_ID,
    }),
  ]);

  const fulfilled = [first, second].filter((r) => r.status === 'fulfilled');
  const rejected = [first, second].filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one transfer succeeds');
  assert.equal(rejected.length, 1, 'exactly one transfer fails');
  assert.equal(rejected[0].reason.statusCode, 409);
  assert.equal(rejected[0].reason.code, ERROR_CODES.INSUFFICIENT_STOCK);

  const source = inventoryRepository.docs.find((d) => String(d.outletId) === SOURCE_OUTLET_ID);
  assert.equal(source.onlineQuantity, 4, 'source never driven below zero');
  assert.equal(transferRepository.docs.length, 1, 'only the successful transfer is recorded');
});

test('lists transfers newest first and fetches a single transfer', async () => {
  const { service, inventoryRepository } = makeService();
  seedOutletStock(inventoryRepository, SOURCE_OUTLET_ID, 10);

  const first = await service.createTransfer({
    sourceOutletId: SOURCE_OUTLET_ID,
    destinationOutletId: DEST_OUTLET_ID,
    productVariantId: VARIANT_ID,
    quantity: 2,
    performedBy: ADMIN_ID,
  });
  await new Promise((r) => setTimeout(r, 5));
  const second = await service.createTransfer({
    sourceOutletId: SOURCE_OUTLET_ID,
    destinationOutletId: OTHER_OUTLET_ID,
    productVariantId: VARIANT_ID,
    quantity: 3,
    performedBy: ADMIN_ID,
  });

  const list = await service.listTransfers({ page: 1, limit: 10 });
  assert.equal(list.pagination.total, 2);
  assert.equal(list.transfers.length, 2);
  assert.equal(list.transfers[0].id, second.id, 'newest first');

  const fetched = await service.getTransfer(first.id);
  assert.equal(fetched.id, first.id);
  assert.equal(fetched.sourceOutletId, SOURCE_OUTLET_ID);
  assert.equal(fetched.destinationOutletId, DEST_OUTLET_ID);
});

test('getTransfer resolves unknown id to 404 STOCK_TRANSFER_NOT_FOUND', async () => {
  const { service } = makeService();
  await expectApiError(
    service.getTransfer('507f1f77bcf86cd799439999'),
    404,
    ERROR_CODES.STOCK_TRANSFER_NOT_FOUND
  );
});
