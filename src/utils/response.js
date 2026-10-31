'use strict';

/**
 * Response envelope helpers.
 *
 * Success: { "success": true, "message": "...", "data": ... }
 * Error envelope is produced by middlewares/errorHandler.js
 *
 * See docs/api-contract.md for the full convention.
 */
function sendSuccess(res, data, message = 'Operation successful', statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
  });
}

module.exports = {
  sendSuccess,
};
