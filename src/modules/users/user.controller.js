'use strict';

const { USER_MESSAGES } = require('./user.constants');

/**
 * Thin user controller: reads the resolved application identity (`req.user`,
 * set by `resolveCurrentUser`) and serializes a safe response. No Mongoose
 * queries, JWT verification, role logic, or business calculations here.
 */
function createUserController({ userService } = {}) {
  if (!userService || typeof userService.toSafeUser !== 'function') {
    throw new Error('createUserController requires a userService');
  }

  return {
    /**
     * GET /api/v1/me — returns the current authenticated application user.
     * Route chain: authenticate → resolveCurrentUser → this handler.
     */
    getMe: (req, res) => {
      res.status(200).json({
        success: true,
        message: USER_MESSAGES.PROFILE_FETCHED,
        data: { user: userService.toSafeUser(req.user) },
      });
    },
  };
}

module.exports = { createUserController };
