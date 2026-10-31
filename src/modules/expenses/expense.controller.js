'use strict';

const { validateCreateExpenseInput, validateExpenseListQuery } = require('./expense.validation');
const { EXPENSE_MESSAGES } = require('./expense.constants');

/**
 * Thin ADMIN-only expense controller (Phase 13): validate input, delegate to
 * the service, serialize the envelope. The acting admin id ALWAYS comes from
 * `req.user.id` — never from the request body.
 */
function createExpenseController({ expenseService }) {
  if (!expenseService || typeof expenseService.createExpense !== 'function') {
    throw new Error('createExpenseController requires an expenseService');
  }

  const performedBy = (req) => req.user.id;

  return {
    // POST /api/v1/admin/expenses — ADMIN only.
    createExpense: async (req, res) => {
      const { value } = validateCreateExpenseInput(req.body);
      const expense = await expenseService.createExpense({
        input: value,
        performedBy: performedBy(req),
      });
      res.status(201).json({
        success: true,
        message: EXPENSE_MESSAGES.EXPENSE_CREATED,
        data: { expense },
      });
    },

    // GET /api/v1/admin/expenses — ADMIN only.
    listExpenses: async (req, res) => {
      const { filter, dateFrom, dateTo } = validateExpenseListQuery(req.query);
      const data = await expenseService.listExpenses({
        ...filter,
        dateFrom,
        dateTo,
        page: req.query.page,
        limit: req.query.limit,
      });
      res.status(200).json({
        success: true,
        message: EXPENSE_MESSAGES.EXPENSES_FETCHED,
        data,
      });
    },

    // GET /api/v1/admin/expenses/:id — ADMIN only.
    getExpense: async (req, res) => {
      const expense = await expenseService.getExpense(req.params.id);
      res.status(200).json({
        success: true,
        message: EXPENSE_MESSAGES.EXPENSE_FETCHED,
        data: { expense },
      });
    },
  };
}

module.exports = { createExpenseController };
