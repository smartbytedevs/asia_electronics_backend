'use strict';

const ApiError = require('../utils/ApiError');
const { ROLES } = require('../constants');

const MESSAGES = {
  UNAUTHORIZED: 'Authentication required',
  FORBIDDEN: 'You do not have permission to perform this action',
};

const ALL_ROLES = Object.values(ROLES);

/**
 * Guards a route by role. MUST be composed AFTER `authenticate` and
 * `resolveCurrentUser` so that `req.user` holds the application identity whose
 * `role` is the authoritative application role (ADR-0011).
 *
 * - Authenticated but role not allowed → 403 (FORBIDDEN).
 * - No application identity present (misconfigured composition) → 401 (UNAUTHORIZED).
 *
 * Unknown role names fail fast at factory time (programmer error).
 */
function authorizeRoles(...allowed) {
  for (const role of allowed) {
    if (!ALL_ROLES.includes(role)) {
      throw new Error(
        `authorizeRoles: unknown role "${role}". Allowed: ${ALL_ROLES.join(', ')}.`
      );
    }
  }

  return function authorizeRolesMiddleware(req, res, next) {
    if (!req.user || !req.user.role) {
      return next(ApiError.unauthorized(MESSAGES.UNAUTHORIZED));
    }
    if (!allowed.includes(req.user.role)) {
      return next(ApiError.forbidden(MESSAGES.FORBIDDEN));
    }
    return next();
  };
}

module.exports = authorizeRoles;
