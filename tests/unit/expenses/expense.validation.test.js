'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateCreateExpenseInput,
  validateExpenseListQuery,
  assertObjectId,
} = require('../../../src/modules/expenses/expense.validation');
const { ERROR_CODES } = require('../../../src/constants');
const { EXPENSE_LIMITS } = require('../../../src/modules/expenses/expense.constants');

const ADMIN = '507f1f77bcf86cd799439811';

function captureError(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return null;
}

function assertInvalidExpense(fn, messagePart) {
  const err = captureError(fn);
  assert.ok(err, 'expected an error to be thrown');
  assert.equal(err.statusCode, 400);
  assert.equal(err.code, ERROR_CODES.INVALID_EXPENSE);
  if (messagePart) {
    assert.ok(
      String(err.message).includes(messagePart),
      `message "${err.message}" should include "${messagePart}"`
    );
  }
}

test('valid create input: amount + description required, optional category/date', () => {
  const { value } = validateCreateExpenseInput({
    amountMinorUnits: 50000,
    description: '  Shop rent  ',
    category: ' Rent ',
    expenseDate: '2026-08-01T00:00:00.000Z',
  });
  assert.equal(value.amountMinorUnits, 50000);
  assert.equal(value.description, 'Shop rent');
  assert.equal(value.category, 'Rent');
  assert.equal(value.expenseDate.toISOString(), '2026-08-01T00:00:00.000Z');
});

test('valid create input without category/date keeps them absent', () => {
  const { value } = validateCreateExpenseInput({ amountMinorUnits: 1000, description: 'Tea' });
  assert.equal(value.category, undefined);
  assert.equal(value.expenseDate, undefined);
});

test('amount is required and must be a positive integer', () => {
  assertInvalidExpense(() => validateCreateExpenseInput({ description: 'Rent' }), 'amountMinorUnits is required');
  for (const amount of [0, -5, 3.5, '5000', NaN, Infinity]) {
    assertInvalidExpense(
      () => validateCreateExpenseInput({ amountMinorUnits: amount, description: 'Rent' }),
      'positive integer'
    );
  }
});

test('description is required, trimmed, and bounded', () => {
  assertInvalidExpense(() => validateCreateExpenseInput({ amountMinorUnits: 1000 }), 'description is required');
  assertInvalidExpense(() => validateCreateExpenseInput({ amountMinorUnits: 1000, description: '   ' }), 'not be empty');
  assertInvalidExpense(
    () => validateCreateExpenseInput({ amountMinorUnits: 1000, description: 'x'.repeat(EXPENSE_LIMITS.DESCRIPTION_MAX + 1) }),
    'description must not exceed'
  );
});

test('category is optional, trimmed, and bounded', () => {
  assert.equal(validateCreateExpenseInput({ amountMinorUnits: 1000, description: 'Rent' }).value.category, undefined);
  assert.equal(
    validateCreateExpenseInput({ amountMinorUnits: 1000, description: 'Rent', category: '  ' }).value.category,
    undefined
  );
  assertInvalidExpense(
    () => validateCreateExpenseInput({ amountMinorUnits: 1000, description: 'Rent', category: 'x'.repeat(EXPENSE_LIMITS.CATEGORY_MAX + 1) }),
    'category must not exceed'
  );
});

test('expenseDate must be a parseable ISO-8601 string when provided', () => {
  assertInvalidExpense(() => validateCreateExpenseInput({ amountMinorUnits: 1000, description: 'Rent', expenseDate: 'not-a-date' }));
  assertInvalidExpense(() => validateCreateExpenseInput({ amountMinorUnits: 1000, description: 'Rent', expenseDate: 12345 }));
  assertInvalidExpense(() => validateCreateExpenseInput({ amountMinorUnits: 1000, description: 'Rent', expenseDate: {} }));
});

test('immutable, identity, and Mongo operator keys are rejected', () => {
  assertInvalidExpense(() => validateCreateExpenseInput({ amountMinorUnits: 1000, description: 'Rent', createdBy: ADMIN }), 'unknown field(s)');
  assertInvalidExpense(() => validateCreateExpenseInput({ amountMinorUnits: 1000, description: 'Rent', _id: 'x' }), 'unknown field(s)');
  assertInvalidExpense(() => validateCreateExpenseInput({ amountMinorUnits: 1000, description: 'Rent', status: 'VERIFIED' }), 'unknown field(s)');
  assertInvalidExpense(
    () => validateCreateExpenseInput({ amountMinorUnits: 1000, description: 'Rent', $set: { amountMinorUnits: 1 } }),
    'MongoDB update operators'
  );
});

test('non-object bodies are rejected', () => {
  assertInvalidExpense(() => validateCreateExpenseInput(null), 'must be an object');
  assertInvalidExpense(() => validateCreateExpenseInput([]), 'must be an object');
  assertInvalidExpense(() => validateCreateExpenseInput('expense'), 'must be an object');
});

test('list query: category pass-through and dateFrom/dateTo parsing', () => {
  const { filter, dateFrom, dateTo } = validateExpenseListQuery({
    category: 'Rent',
    dateFrom: '2026-08-01',
    dateTo: '2026-08-05',
  });
  assert.equal(filter.category, 'Rent');
  assert.equal(dateFrom.toISOString().slice(0, 10), '2026-08-01');
  assert.equal(dateTo.toISOString().slice(0, 10), '2026-08-05');
});

test('list query: dateFrom after dateTo is rejected', () => {
  assertInvalidExpense(() => validateExpenseListQuery({ dateFrom: '2026-08-10', dateTo: '2026-08-01' }), 'on or before');
});

test('list query: invalid dates and non-strings are rejected', () => {
  assertInvalidExpense(() => validateExpenseListQuery({ dateFrom: 'banana' }), 'ISO-8601');
  assertInvalidExpense(() => validateExpenseListQuery({ dateTo: 5 }), 'ISO-8601');
});

test('assertObjectId validates 24-character hex ids', () => {
  assert.equal(assertObjectId(ADMIN, 'adminId'), ADMIN);
  assertInvalidExpense(() => assertObjectId('not-an-id', 'adminId'), '24-character hex');
  assertInvalidExpense(() => assertObjectId(123, 'adminId'), '24-character hex');
});
