'use strict';

const { parsePathaoDateTime } = require('./pathao.mapper');

/**
 * Pathao webhook payload normalization (Phase 09, ADR-0017).
 *
 * Pathao's merchant webhook posts an event object with `consignment_id`,
 * `merchant_order_id`, `order_status` (and/or an `event` name) plus a
 * `X-Pathao-Signature` header (the registered secret). This module only
 * extracts the fields the CourierService needs; signature verification and
 * local-status mapping stay in the service.
 */
function normalizePathaoWebhook(payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  return {
    consignmentId: data.consignment_id ? String(data.consignment_id) : null,
    merchantReference: data.merchant_order_id || null,
    providerStatus: data.order_status || null,
    providerStatusUpdatedAt: parsePathaoDateTime(
      data.order_status_updated_at || data.updated_at
    ),
    note: `Pathao webhook (${data.event || data.order_status || 'status update'})`,
  };
}

module.exports = { normalizePathaoWebhook };
