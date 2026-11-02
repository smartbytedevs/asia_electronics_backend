'use strict';

const {
  parsePathaoDateTime,
  mapWebhookEventToProviderStatus,
} = require('./pathao.mapper');

/**
 * Pathao webhook payload normalization (Phase 09, ADR-0017).
 *
 * Pathao's merchant webhook posts an event object with `consignment_id`,
 * `merchant_order_id`, `event` (e.g. `order.delivered`), `updated_at` and
 * `timestamp`, signed with the registered webhook secret in the
 * `X-PATHAO-Signature` header. Some legacy/integration payloads also include
 * `order_status`. This module only extracts the fields the CourierService
 * needs; signature verification and local-status mapping stay in the service.
 *
 * The merchant panel first calls the callback with
 * `{ event: 'webhook_integration' }` and expects the integration secret to be
 * echoed in `X-Pathao-Merchant-Webhook-Integration-Secret`. That challenge is
 * handled by the controller before this normalizer runs.
 */
function isWebhookIntegrationEvent(payload) {
  return Boolean(
    payload &&
      typeof payload === 'object' &&
      String(payload.event || '').toLowerCase() === 'webhook_integration'
  );
}

function normalizePathaoWebhook(payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  const event = data.event || null;
  const providerStatus =
    data.order_status ||
    data.order_status_slug ||
    mapWebhookEventToProviderStatus(event);

  return {
    consignmentId: data.consignment_id ? String(data.consignment_id) : null,
    merchantReference: data.merchant_order_id || null,
    providerStatus,
    providerStatusUpdatedAt: parsePathaoDateTime(
      data.order_status_updated_at || data.updated_at || data.timestamp
    ),
    event,
    note: `Pathao webhook (${event || providerStatus || 'status update'})`,
  };
}

module.exports = { isWebhookIntegrationEvent, normalizePathaoWebhook };
