'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { PaymentMethodService } = require('../../../src/modules/payments/paymentMethod.service');
const { ERROR_CODES } = require('../../../src/constants');
const { createMemoryPaymentMethodRepository } = require('../../helpers/payment-stubs');

function makeMethod(overrides = {}) {
  return {
    _id: '507f1f77bcf86cd799439301',
    code: 'BANK_TRANSFER',
    displayName: 'Bank Transfer',
    type: 'MANUAL',
    metadata: { accountName: 'Taqwa', accountNumber: '0123', instructions: 'Use order number' },
    isActive: true,
    sortOrder: 1,
    createdAt: new Date('2026-08-08T00:00:00.000Z'),
    updatedAt: new Date('2026-08-08T00:00:00.000Z'),
    ...overrides,
  };
}

function createService(initial = []) {
  const repo = createMemoryPaymentMethodRepository(initial);
  return { service: new PaymentMethodService({ paymentMethodRepository: repo }), repo };
}

test('customers only see active methods, ordered by sortOrder, without operational flags', async () => {
  const { service } = createService([
    makeMethod({ _id: '507f1f77bcf86cd799439302', code: 'NAGAD', displayName: 'Nagad', sortOrder: 0 }),
    makeMethod({ sortOrder: 1 }),
    makeMethod({ _id: '507f1f77bcf86cd799439303', code: 'OFFLINE', displayName: 'Offline', isActive: false }),
  ]);
  const list = await service.listActiveForCustomer();
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((m) => m.code), ['NAGAD', 'BANK_TRANSFER']);
  assert.equal(list[0].metadata.accountNumber, '0123');
  assert.equal('isActive' in list[0], false, 'customer view hides isActive');
  assert.equal('sortOrder' in list[0], false, 'customer view hides sortOrder');
  assert.equal('createdAt' in list[0], false, 'customer view hides timestamps');
});

test('createPaymentMethod stores the (pre-validated) admin input and returns the admin representation', async () => {
  const { service } = createService();
  const created = await service.createPaymentMethod({
    code: 'BANK_TRANSFER',
    displayName: 'Bank Transfer',
    type: 'MANUAL',
    metadata: { accountNumber: '0999' },
  });
  assert.equal(created.code, 'BANK_TRANSFER');
  assert.equal(created.isActive, true);
  assert.equal(created.sortOrder, 0);
  assert.equal(created.metadata.accountNumber, '0999');
});

test('duplicate code → PAYMENT_METHOD_CODE_ALREADY_EXISTS', async () => {
  const { service } = createService([makeMethod()]);
  await assert.rejects(
    () => service.createPaymentMethod({ code: 'BANK_TRANSFER', displayName: 'X', type: 'MANUAL' }),
    (err) => err.statusCode === 409 && err.code === ERROR_CODES.PAYMENT_METHOD_CODE_ALREADY_EXISTS
  );
});

test('updatePaymentMethod soft-deactivates and renames without hard delete', async () => {
  const initial = makeMethod();
  const { service, repo } = createService([initial]);
  const updated = await service.updatePaymentMethod({
    paymentMethodId: initial._id,
    updates: { isActive: false, displayName: 'Renamed Bank' },
  });
  assert.equal(updated.isActive, false);
  assert.equal(updated.displayName, 'Renamed Bank');
  assert.equal(repo.docs.length, 1, 'no hard delete');
  assert.equal(repo.docs[0].code, 'BANK_TRANSFER', 'code is immutable');
});

test('updatePaymentMethod on a missing id → PAYMENT_METHOD_NOT_FOUND', async () => {
  const { service } = createService([makeMethod()]);
  await assert.rejects(
    () => service.updatePaymentMethod({ paymentMethodId: '507f1f77bcf86cd799439999', updates: { isActive: false } }),
    (err) => err.statusCode === 404 && err.code === ERROR_CODES.PAYMENT_METHOD_NOT_FOUND
  );
});

test('getPaymentMethodForAdmin includes operational fields', async () => {
  const initial = makeMethod();
  const { service } = createService([initial]);
  const found = await service.getPaymentMethodForAdmin(initial._id);
  assert.equal(found.code, 'BANK_TRANSFER');
  assert.equal(found.isActive, true);
  assert.equal(found.sortOrder, 1);
  await assert.rejects(
    () => service.getPaymentMethodForAdmin('507f1f77bcf86cd799439999'),
    (err) => err.code === ERROR_CODES.PAYMENT_METHOD_NOT_FOUND
  );
});

test('constructor rejects a missing repository', () => {
  assert.throws(() => new PaymentMethodService({}), /paymentMethodRepository/);
});
