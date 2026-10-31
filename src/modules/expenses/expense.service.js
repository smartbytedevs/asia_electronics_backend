'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const { normalizePagination } = require('../../utils/pagination');
const { assertObjectId } = require('./expense.validation');
const { toExpenseOutput } = require('./expense.serializer');
const { EXPENSE_MESSAGES } = require('./expense.constants');

/**
 * Expense business logic (Phase 13).
 *
 * The acting admin id ALWAYS comes from `performedBy` (the authenticated
 * user) — never from the request body. Amounts are INTEGER MINOR UNITS and
 * validated as positive integers before persisting. Date filtering uses the
 * backend's existing `dateFrom`/`dateTo` convention against `expenseDate`.
 *
 * No update/delete surface exists: expense lines are append-only financial
 * records (see expense.constants.js).
 */
class ExpenseService {
  constructor({ expenseRepository }) {
    if (!expenseRepository || typeof expenseRepository.create !== 'function') {
      throw new Error('ExpenseService requires an expenseRepository');
    }
    this.expenseRepository = expenseRepository;
  }

  async createExpense({ input, performedBy }) {
    assertObjectId(performedBy, 'performedBy');
    const doc = await this.expenseRepository.create({
      ...input,
      createdBy: performedBy,
    });
    return toExpenseOutput(doc);
  }

  async listExpenses({ category, dateFrom, dateTo, page, limit }) {
    const filter = {};
    if (category !== undefined && category !== null && category !== '') {
      filter.category = String(category);
    }
    if (dateFrom) filter.dateFrom = dateFrom;
    if (dateTo) filter.dateTo = dateTo;
    const { page: safePage, limit: safeLimit, skip } = normalizePagination({ page, limit });
    const [docs, total] = await Promise.all([
      this.expenseRepository.findMany(filter, {
        sort: { expenseDate: -1, createdAt: -1 },
        skip,
        limit: safeLimit,
      }),
      this.expenseRepository.count(filter),
    ]);
    return {
      expenses: docs.map((doc) => toExpenseOutput(doc)),
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit),
      },
    };
  }

  async getExpense(expenseId) {
    assertObjectId(expenseId, 'expenseId');
    const doc = await this.expenseRepository.findById(expenseId);
    if (!doc) {
      throw new ApiError(404, EXPENSE_MESSAGES.EXPENSE_NOT_FOUND, ERROR_CODES.EXPENSE_NOT_FOUND);
    }
    return toExpenseOutput(doc);
  }
}

module.exports = { ExpenseService };
