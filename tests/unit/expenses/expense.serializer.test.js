'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { toExpenseOutput } = require('../../../src/modules/expenses/expense.serializer');

const ADMIN = '507f1f77bcf86cd799439812';
const EXPENSE_ID = '507f1f77bcf86cd799439813';

test('serializes a full expense document', () => {
  const output = toExpenseOutput({
    _id: EXPENSE_ID,
    amountMinorUnits: 50000,
    category: 'Rent',
    description: 'August shop rent',
    expenseDate: new Date('2026-08-01T00:00:00.000Z'),
    createdBy: ADMIN,
    createdAt: new Date('2026-08-01T10:00:00.000Z'),
    updatedAt: new Date('2026-08-01T10:00:00.000Z'),
  });

  assert.deepEqual(output, {
    id: EXPENSE_ID,
    amountMinorUnits: 50000,
    category: 'Rent',
    description: 'August shop rent',
    expenseDate: '2026-08-01T00:00:00.000Z',
    createdBy: { id: ADMIN },
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
  });
});

test('populated createdBy exposes only safe identity fields', () => {
  const output = toExpenseOutput({
    _id: EXPENSE_ID,
    amountMinorUnits: 1000,
    description: 'Tea',
    createdBy: { _id: ADMIN, name: 'Admin Person', email: 'admin@example.com' },
  });
  assert.deepEqual(output.createdBy, { id: ADMIN, name: 'Admin Person', email: 'admin@example.com' });
});

test('missing optional fields serialize to null and never leak internals', () => {
  const output = toExpenseOutput({
    _id: EXPENSE_ID,
    amountMinorUnits: 1000,
    description: 'Tea',
    createdBy: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
  });
  assert.equal(output.category, null);
  assert.equal(output.expenseDate, null);
  assert.equal(output.createdBy, null);
  assert.equal(output.updatedAt, null);
  const raw = JSON.stringify(output);
  assert.ok(!raw.includes('_id') && !raw.includes('__v') && !raw.includes('version'), 'no raw internals leak');
});

test('null and invalid inputs are safe', () => {
  assert.equal(toExpenseOutput(null), null);
  assert.equal(toExpenseOutput(undefined), null);
  assert.equal(toExpenseOutput({ _id: EXPENSE_ID, description: 'x', expenseDate: 'invalid-date' }).expenseDate, null);
});
