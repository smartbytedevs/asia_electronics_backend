'use strict';

/**
 * Expense constants (Phase 13).
 *
 * A business expense is a single ADMIN-recorded cost line: an amount, an
 * optional free-text category label, a required description, and the date the
 * expense occurred. It feeds the admin analytics (profit/loss), so all money
 * is INTEGER MINOR UNITS (paisa) — the same representation as orders,
 * payments, and refunds (ADR-0013/ADR-0015).
 *
 * Expenses are deliberately APPEND-ONLY: there is no update/delete surface so
 * the financial record stays immutable and auditable (the same philosophy the
 * order/payment/refund models use for money). Fixes are recorded as new
 * offsetting expense lines rather than mutations.
 */

const EXPENSE_LIMITS = Object.freeze({
  DESCRIPTION_MAX: 500,
  CATEGORY_MAX: 100,
});

/**
 * Whitelist of every client-writable expense field. `createdBy` is ALWAYS
 * server-derived from the authenticated admin; `_id`/`createdAt`/`updatedAt`
 * are never client-writable.
 */
const EXPENSE_INPUT_FIELDS = Object.freeze([
  'amountMinorUnits',
  'category',
  'description',
  'expenseDate',
]);

const EXPENSE_MESSAGES = Object.freeze({
  EXPENSES_FETCHED: 'Expenses retrieved successfully',
  EXPENSE_FETCHED: 'Expense retrieved successfully',
  EXPENSE_CREATED: 'Expense created successfully',
  EXPENSE_NOT_FOUND: 'Expense not found',
  INVALID_EXPENSE: 'Invalid expense data',
});

module.exports = {
  EXPENSE_LIMITS,
  EXPENSE_INPUT_FIELDS,
  EXPENSE_MESSAGES,
};
