'use strict';

/**
 * Centralized Outlet constants.
 *
 * Outlets are the physical stores a business runs. Per-outlet inventory
 * (Phase 14) keys each Inventory record by `{ productVariantId, outletId }`;
 * `outletId: null` is the CENTRAL / online pool (storefront-visible stock).
 */

const OUTLET_LIMITS = Object.freeze({
  NAME_MAX: 100,
  CODE_MAX: 20,
  ADDRESS_MAX: 300,
  PHONE_MAX: 30,
});

/**
 * The complete set of client-writable outlet fields. Used by both the input
 * validator and the service to reject unknown/immutable keys (e.g. `_id`,
 * `createdAt`, or MongoDB operators such as `$set`). This is the field
 * allowlist that prevents mass-assignment and operator injection.
 */
const OUTLET_FIELDS = Object.freeze([
  'name',
  'code',
  'address',
  'phone',
  'isActive',
]);

const OUTLET_MESSAGES = Object.freeze({
  LIST_FETCHED: 'Outlets retrieved successfully',
  OUTLET_FETCHED: 'Outlet retrieved successfully',
  OUTLET_CREATED: 'Outlet created successfully',
  OUTLET_UPDATED: 'Outlet updated successfully',
  OUTLET_NOT_FOUND: 'Outlet not found',
  OUTLET_CODE_ALREADY_EXISTS: 'An outlet with this code already exists',
  INVALID_OUTLET: 'Invalid outlet data',
  INVALID_OUTLET_ID: 'Invalid outlet id',
  INVALID_OUTLET_CODE: 'Invalid outlet code',
});

module.exports = {
  OUTLET_LIMITS,
  OUTLET_FIELDS,
  OUTLET_MESSAGES,
};
