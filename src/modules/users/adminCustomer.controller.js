'use strict';

const { validateCustomerListQuery } = require('./user.validation');
const { USER_MESSAGES } = require('./user.constants');

/**
 * Thin admin customer controller (list + detail). The acting ADMIN id is never
 * needed for read-only list/detail; filters come from validated query params
 * only. No customer mutation endpoints exist in this phase.
 */
function createAdminCustomerController({ userService }) {
  if (
    !userService ||
    typeof userService.listCustomers !== 'function' ||
    typeof userService.getCustomer !== 'function'
  ) {
    throw new Error('createAdminCustomerController requires a userService');
  }

  return {
    // GET /api/v1/admin/customers — ADMIN.
    listCustomers: async (req, res) => {
      const { filter } = validateCustomerListQuery(req.query);
      const data = await userService.listCustomers({
        ...filter,
        page: req.query.page,
        limit: req.query.limit,
      });
      res.status(200).json({
        success: true,
        message: USER_MESSAGES.CUSTOMERS_FETCHED,
        data,
      });
    },

    // GET /api/v1/admin/customers/:id — ADMIN.
    getCustomer: async (req, res) => {
      const customer = await userService.getCustomer(req.params.id);
      res.status(200).json({
        success: true,
        message: USER_MESSAGES.CUSTOMER_FETCHED,
        data: { customer },
      });
    },
  };
}

module.exports = { createAdminCustomerController };
