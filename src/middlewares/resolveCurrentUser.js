'use strict';

const ApiError = require('../utils/ApiError');
const { ACCOUNT_STATUSES } = require('../constants');

const MESSAGES = {
  UNAUTHORIZED: 'Authentication required',
  ACCOUNT_NOT_FOUND: 'User account not found',
  ACCOUNT_SUSPENDED: 'Account is suspended',
  ACCOUNT_DISABLED: 'Account is disabled',
};

/**
 * Resolves the APPLICATION identity for a verified authentication identity.
 *
 * Composed AFTER `authenticate` (which sets `req.auth`) and BEFORE
 * `authorizeRoles` (which reads `req.user.role`):
 *
 *   authenticate → resolveCurrentUser → authorizeRoles → controller
 *
 * - Looks up the application User via the injected userService using
 *   `req.auth.authProviderId` (provisioning a CUSTOMER when the service allows).
 * - Enforces account status: only ACTIVE users are admitted.
 * - Sets `req.user` to the application identity
 *   ({ id, authProviderId, email, displayName, phone, role, status }) whose
 *   `role` is the authoritative role for authorization (ADR-0011).
 *
 * Never queries MongoDB directly: JWT verification and application user
 * resolution stay separate concerns.
 */
function resolveCurrentUser({ userService } = {}) {
  if (
    !userService ||
    typeof userService.resolveAuthenticatedUser !== 'function'
  ) {
    throw new Error('resolveCurrentUser requires a userService');
  }

  return async function resolveCurrentUserMiddleware(req, res, next) {
    if (!req.auth) {
      return next(ApiError.unauthorized(MESSAGES.UNAUTHORIZED));
    }

    try {
      const user = await userService.resolveAuthenticatedUser(req.auth);
      if (!user) {
        return next(ApiError.forbidden(MESSAGES.ACCOUNT_NOT_FOUND));
      }

      if (user.status !== ACCOUNT_STATUSES.ACTIVE) {
        const message =
          user.status === ACCOUNT_STATUSES.SUSPENDED
            ? MESSAGES.ACCOUNT_SUSPENDED
            : MESSAGES.ACCOUNT_DISABLED;
        return next(ApiError.forbidden(message));
      }

      req.user = user;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = resolveCurrentUser;
