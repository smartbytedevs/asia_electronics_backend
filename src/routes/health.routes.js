'use strict';

const { Router } = require('express');
const { getDatabaseState } = require('../config/database');

const router = Router();

/**
 * GET /api/v1/health
 * Liveness probe. No business logic.
 *
 * Reports application availability plus the safe database connection state.
 * Does not expose internal connection details or credentials.
 *
 * Response:
 * {
 *   "success": true,
 *   "message": "Asia Electronics API is healthy",
 *   "data": { "database": "connected" }
 * }
 */
router.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Asia Electronics API is healthy',
    data: {
      database: getDatabaseState(),
    },
  });
});

module.exports = router;
