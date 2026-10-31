'use strict';

const { Router } = require('express');
const { ROLES } = require('../../constants');
const Expense = require('./expense.model');
const { createExpenseRepository } = require('./expense.repository');
const { ExpenseService } = require('./expense.service');
const { createExpenseController } = require('./expense.controller');
const authenticate = require('../../middlewares/authenticate');
const resolveCurrentUser = require('../../middlewares/resolveCurrentUser');
const authorizeRoles = require('../../middlewares/authorizeRoles');
const { defaultUserService } = require('../users/user.routes');

/**
 * Default expense service bound to the central config. Only DB operations
 * happen at request time — module load is connection-free.
 */
const defaultExpenseService = new ExpenseService({
  expenseRepository: createExpenseRepository(Expense),
});

/**
 * Admin expense router, mounted at /api/v1/admin/expenses. ADMIN only. The
 * acting id always comes from the authenticated user — never from the body.
 * Append-only: create + list + get (no update/delete; see expense.constants).
 */
function createExpenseRouter({
  expenseService = defaultExpenseService,
  userService = defaultUserService,
  verifier,
} = {}) {
  const router = Router();
  const controller = createExpenseController({ expenseService });

  const admin = [
    authenticate(verifier),
    resolveCurrentUser({ userService }),
    authorizeRoles(ROLES.ADMIN),
  ];

  router.post('/', admin, controller.createExpense);
  router.get('/', admin, controller.listExpenses);
  router.get('/:id', admin, controller.getExpense);

  return router;
}

const defaultRouter = createExpenseRouter();

module.exports = { createExpenseRouter, defaultRouter, defaultExpenseService };
