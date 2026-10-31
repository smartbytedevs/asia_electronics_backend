'use strict';

/**
 * Expense response serializer (Phase 13). Returns a plain envelope for
 * `data.expense` / `data.expenses`. `createdBy` may be a bare ObjectId, a
 * populated lean user doc, or null — bare ids serialize to `{ id }` and
 * populated users expose only safe identity fields.
 */

function isBareId(value) {
  return Boolean(value) && !value._id;
}

function toISO(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function serializeUserRef(user) {
  if (!user) return null;
  if (isBareId(user)) {
    return { id: String(user) };
  }
  const value = { id: String(user._id) };
  if (user.name) value.name = user.name;
  if (user.email) value.email = user.email;
  return value;
}

function toExpenseOutput(expense) {
  if (!expense) return null;
  return {
    id: expense._id.toString(),
    amountMinorUnits: expense.amountMinorUnits,
    category: expense.category || null,
    description: expense.description,
    expenseDate: toISO(expense.expenseDate),
    createdBy: serializeUserRef(expense.createdBy),
    createdAt: toISO(expense.createdAt),
    updatedAt: toISO(expense.updatedAt),
  };
}

module.exports = { toExpenseOutput };
