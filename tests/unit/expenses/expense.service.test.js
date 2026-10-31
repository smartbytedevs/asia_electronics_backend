'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ExpenseService } = require('../../../src/modules/expenses/expense.service');
const { ERROR_CODES } = require('../../../src/constants');
const { createMemoryExpenseRepository } = require('../../helpers/expense-stubs');

const ADMIN = '507f1f77bcf86cd799439821';
const UNKNOWN_ID = '507f1f77bcf86cd799439899';

function makeExpense(overrides = {}) {
  return {
    _id: '507f1f77bcf86cd7994398a1',
    amountMinorUnits: 50000,
    category: 'Rent',
    description: 'August shop rent',
    expenseDate: new Date('2026-08-02T00:00:00.000Z'),
    createdBy: ADMIN,
    createdAt: new Date('2026-08-02T10:00:00.000Z'),
    updatedAt: new Date('2026-08-02T10:00:00.000Z'),
    ...overrides,
  };
}

function createHarness({ expenses = [] } = {}) {
  const expenseRepo = createMemoryExpenseRepository(expenses);
  const service = new ExpenseService({ expenseRepository: expenseRepo });
  return { service, expenseRepo };
}

test('createExpense persists with createdBy ALWAYS from performedBy, never the body', async () => {
  const { service, expenseRepo } = createHarness();
  const expense = await service.createExpense({
    input: { amountMinorUnits: 25000, description: 'Packaging', category: 'Logistics' },
    performedBy: ADMIN,
  });

  assert.equal(expense.amountMinorUnits, 25000);
  assert.equal(expense.description, 'Packaging');
  assert.equal(expense.category, 'Logistics');
  assert.equal(expense.createdBy.id, ADMIN);
  assert.equal(expenseRepo.docs.length, 1);
  assert.equal(expenseRepo.docs[0].createdBy, ADMIN);
});

test('createExpense accepts a back-dated expenseDate', async () => {
  const { service, expenseRepo } = createHarness();
  const expense = await service.createExpense({
    input: { amountMinorUnits: 1000, description: 'Tea', expenseDate: new Date('2026-07-20T00:00:00.000Z') },
    performedBy: ADMIN,
  });
  assert.equal(expense.expenseDate, '2026-07-20T00:00:00.000Z');
  assert.equal(expenseRepo.docs[0].expenseDate.toISOString(), '2026-07-20T00:00:00.000Z');
});

test('createExpense rejects a missing/invalid performedBy', async () => {
  const { service } = createHarness();
  for (const performedBy of [undefined, null, 'nope', 42]) {
    await assert.rejects(
      () => service.createExpense({ input: { amountMinorUnits: 1000, description: 'Rent' }, performedBy }),
      (err) => err.statusCode === 400 && err.code === ERROR_CODES.INVALID_EXPENSE
    );
  }
});

test('listExpenses returns everything newest-expenseDate-first without filters', async () => {
  const { service } = createHarness({
    expenses: [
      makeExpense({ _id: '507f1f77bcf86cd7994398a2', expenseDate: new Date('2026-08-03T00:00:00.000Z') }),
      makeExpense({ _id: '507f1f77bcf86cd7994398a3', expenseDate: new Date('2026-08-01T00:00:00.000Z') }),
    ],
  });
  const data = await service.listExpenses({});
  assert.equal(data.expenses.length, 2);
  assert.equal(data.expenses[0].id, '507f1f77bcf86cd7994398a2');
  assert.equal(data.pagination.total, 2);
  assert.equal(data.pagination.page, 1);
  assert.equal(data.pagination.totalPages, 1);
});

test('listExpenses filters by category and date range', async () => {
  const { service } = createHarness({
    expenses: [
      makeExpense({ _id: '507f1f77bcf86cd7994398a4', category: 'Rent', expenseDate: new Date('2026-08-01T00:00:00.000Z') }),
      makeExpense({ _id: '507f1f77bcf86cd7994398a5', category: 'Utilities', expenseDate: new Date('2026-08-03T00:00:00.000Z') }),
      makeExpense({ _id: '507f1f77bcf86cd7994398a6', category: 'Rent', expenseDate: new Date('2026-08-10T00:00:00.000Z') }),
    ],
  });

  const rent = await service.listExpenses({ category: 'Rent' });
  assert.equal(rent.pagination.total, 2);

  const august = await service.listExpenses({
    dateFrom: new Date('2026-08-01T00:00:00.000Z'),
    dateTo: new Date('2026-08-05T00:00:00.000Z'),
  });
  assert.equal(august.pagination.total, 2);

  const rentInAugust = await service.listExpenses({
    category: 'Rent',
    dateFrom: new Date('2026-08-01T00:00:00.000Z'),
    dateTo: new Date('2026-08-05T00:00:00.000Z'),
  });
  assert.equal(rentInAugust.pagination.total, 1);
  assert.equal(rentInAugust.expenses[0].id, '507f1f77bcf86cd7994398a4');
});

test('listExpenses applies pagination', async () => {
  const expenses = Array.from({ length: 5 }, (_, i) =>
    makeExpense({
      _id: `507f1f77bcf86cd799439a${i}`,
      expenseDate: new Date(`2026-08-0${i + 1}T00:00:00.000Z`),
    })
  );
  const { service } = createHarness({ expenses });
  const page2 = await service.listExpenses({ page: 2, limit: 2 });
  assert.equal(page2.expenses.length, 2);
  assert.equal(page2.pagination.page, 2);
  assert.equal(page2.pagination.total, 5);
  assert.equal(page2.pagination.totalPages, 3);
});

test('getExpense returns a serialized expense', async () => {
  const { service } = createHarness({ expenses: [makeExpense()] });
  const expense = await service.getExpense('507f1f77bcf86cd7994398a1');
  assert.equal(expense.description, 'August shop rent');
});

test('getExpense throws EXPENSE_NOT_FOUND for unknown ids and 400 for invalid ids', async () => {
  const { service } = createHarness();
  await assert.rejects(
    () => service.getExpense(UNKNOWN_ID),
    (err) => err.statusCode === 404 && err.code === ERROR_CODES.EXPENSE_NOT_FOUND
  );
  await assert.rejects(
    () => service.getExpense('not-an-id'),
    (err) => err.statusCode === 400 && err.code === ERROR_CODES.INVALID_EXPENSE
  );
});
