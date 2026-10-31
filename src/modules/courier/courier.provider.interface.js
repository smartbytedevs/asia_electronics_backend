'use strict';

/**
 * Courier provider interface (Phase 09, ADR-0017).
 *
 * The CourierService depends ONLY on this abstraction — never on Pathao or the
 * mock directly (ADR-0004). Implementations:
 *
 *   const { createPathaoCourierProvider } = require('./pathao/pathao.provider');
 *   const { createMockCourierProvider } = require('./courier.provider.mock');
 *
 * Every method is async and throws `CourierProviderError`
 * (./courier.errors.js) on failure. Resolved payloads are provider-normalized
 * (consignment id + minor-unit fees) so the service stays unit-agnostic.
 *
 * @typedef {object} ShipmentPayload
 *   Normalized submission payload — provider-agnostic:
 *   {
 *     merchantReference: string,     // order.orderNumber
 *     recipientName: string,
 *     recipientPhone: string,
 *     recipientAddress: string,
 *     itemDescription: string,
 *     specialInstruction: string|null,
 *     itemQuantity: number,          // total units
 *     itemWeightKg: number,          // 0.5–10
 *     deliveryType: string,          // provider-specific code (e.g. 'NORMAL')
 *     amountToCollectMinorUnits: number, // COD to collect at the door (0 otherwise)
 *   }
 *
 * @typedef {object} SubmitResult
 *   { consignmentId: string, providerDeliveryFeeMinorUnits: number,
 *     providerStatus: string|null, providerStatusUpdatedAt: Date|null,
 *     localStatus: string, raw: any }
 *   `localStatus` is the provider's OWN status label mapped to a LOCAL courier
 *   status (COURIER_STATUSES) so the service never maps provider labels itself.
 *
 * @typedef {object} StatusResult
 *   { providerStatus: string, providerStatusUpdatedAt: Date|null,
 *     localStatus: string, raw: any }
 *
 * @typedef {object} CancelResult
 *   { cancelledAt: Date|null, raw: any }
 *
 * Additional member required on the provider object:
 *   mapProviderStatus(providerStatusLabel) -> local COURIER_STATUSES
 * Used by the service for webhook status updates. Implementations map ONLY
 * their own status labels (Pathao labels for Pathao, mock labels for mock).
 */

/**
 * Throws when the provider has not been configured (missing credentials).
 * Implementations should call this from their constructor/init path.
 */
function assertProviderConfigured(providerConfig) {
  const missing = Object.entries(providerConfig || {})
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    const { CourierProviderError, COURIER_PROVIDER_ERROR_CODES } = require('./courier.errors');
    throw new CourierProviderError(
      COURIER_PROVIDER_ERROR_CODES.NOT_CONFIGURED,
      `Courier provider is not configured (missing: ${missing.join(', ')}). See .env.example.`
    );
  }
}

module.exports = { assertProviderConfigured };
