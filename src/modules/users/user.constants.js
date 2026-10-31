'use strict';

const { ROLES, ACCOUNT_STATUSES } = require('../../constants');

const USER_MESSAGES = Object.freeze({
  PROFILE_FETCHED: 'User profile retrieved successfully',
  ACCOUNT_NOT_FOUND: 'User account not found',
  CUSTOMERS_FETCHED: 'Customers retrieved successfully',
  CUSTOMER_FETCHED: 'Customer retrieved successfully',
  USER_NOT_FOUND: 'Customer not found',
  INVALID_ROLE: 'role must be one of: ADMIN, STAFF, CUSTOMER',
  INVALID_STATUS: 'status must be one of: ACTIVE, SUSPENDED, DISABLED',
});

/**
 * Auto-provisioning is STRICTLY limited to CUSTOMER accounts. A verified
 * authentication identity never implies an administrative role; ADMIN/STAFF
 * users are created only by trusted application-side processes.
 */
const DEFAULT_USER_ROLE = ROLES.CUSTOMER;
const DEFAULT_USER_STATUS = ACCOUNT_STATUSES.ACTIVE;

module.exports = {
  USER_MESSAGES,
  DEFAULT_USER_ROLE,
  DEFAULT_USER_STATUS,
};
