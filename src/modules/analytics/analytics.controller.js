'use strict';

const { ANALYTICS_MESSAGES } = require('./analytics.constants');

/**
 * Thin ADMIN-only analytics controller (Phase 13): delegate to the service and
 * serialize the envelope. All parameters come from the query string.
 */
function createAnalyticsController({ analyticsService }) {
  if (!analyticsService || typeof analyticsService.getSummary !== 'function') {
    throw new Error('createAnalyticsController requires an analyticsService');
  }

  return {
    // GET /api/v1/admin/analytics/summary?dateFrom=&dateTo= — ADMIN only.
    getSummary: async (req, res) => {
      const data = await analyticsService.getSummary({
        dateFrom: req.query.dateFrom,
        dateTo: req.query.dateTo,
      });
      res.status(200).json({
        success: true,
        message: ANALYTICS_MESSAGES.SUMMARY_FETCHED,
        data,
      });
    },

    // GET /api/v1/admin/analytics/daily?dateFrom=&dateTo= — ADMIN only.
    getDaily: async (req, res) => {
      const data = await analyticsService.getDaily({
        dateFrom: req.query.dateFrom,
        dateTo: req.query.dateTo,
      });
      res.status(200).json({
        success: true,
        message: ANALYTICS_MESSAGES.DAILY_FETCHED,
        data,
      });
    },
  };
}

module.exports = { createAnalyticsController };
