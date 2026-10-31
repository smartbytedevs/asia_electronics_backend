'use strict';

const {
  CourierProviderError,
  COURIER_PROVIDER_ERROR_CODES,
} = require('./courier.errors');

/**
 * Deterministic in-memory courier provider (Phase 09, ADR-0017).
 *
 * Used by development and the test suite when COURIER_PROVIDER=mock (the
 * default). Implements the courier provider interface (courier.provider.interface.js)
 * so the CourierService is exercised end-to-end without real credentials.
 *
 * Behavior:
 *  - submitShipment(payload): validates basic recipient shape, assigns a
 *    consignment id `MOCK-<n>`, charges a fixed delivery fee of 6000 minor
 *    units (BDT 60.00), and reports provider status 'Pending'.
 *  - fetchShipmentStatus(consignmentId): current status of an existing
 *    consignment; TRACKING_NOT_FOUND for unknown ids.
 *  - cancelShipment(consignmentId): 'Cancelled' for cancellable consignments;
 *    CANCEL_REJECTED once the parcel has delivered.
 *
 * Test hooks are exposed on the returned object under `_harness`:
 *  - _registry: Map<consignmentId, record> for asserting provider-side state.
 *  - advance(consignmentId, status): simulate a provider-side transition.
 *  - failNextSubmitWith(err): inject a failure for the next submit call.
 *  - failNextCancelWith(err): inject a failure for the next cancel call.
 */
function createMockCourierProvider({ now = Date.now } = {}) {
  const registry = new Map();
  // Consignment ids MUST be globally unique: the shipment model enforces a
  // unique `consignmentId` index (like a real provider), so a counter that
  // restarts at MOCK-000001 on every process boot would collide with a
  // previously stored ACTIVE shipment and blow up the next dispatch with an
  // E11000. Seed the counter with the process start time so ids stay unique
  // across restarts while keeping the `MOCK-<digits>` shape.
  let sequence = Date.now();

  function nextConsignmentId() {
    sequence += 1;
    return `MOCK-${String(sequence).padStart(6, '0')}`;
  }

  /**
   * Maps a mock-provider status label to a LOCAL courier status (interface
   * requirement — the service only speaks local statuses).
   */
  function mapProviderStatus(providerStatus) {
    const label = String(providerStatus || '').toLowerCase();
    if (label.includes('delivered')) {
      return 'DELIVERED';
    }
    if (label.includes('cancelled')) {
      return 'CANCELLED';
    }
    return 'ACTIVE';
  }

  function assertPayload(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new CourierProviderError(
        COURIER_PROVIDER_ERROR_CODES.PROVIDER_REJECTED,
        'shipment payload is required'
      );
    }
    const missing = ['merchantReference', 'recipientName', 'recipientPhone', 'recipientAddress']
      .filter((key) => !payload[key]);
    if (missing.length > 0) {
      throw new CourierProviderError(
        COURIER_PROVIDER_ERROR_CODES.PROVIDER_REJECTED,
        `missing required fields: ${missing.join(', ')}`
      );
    }
  }

  const harness = {
    _registry: registry,
    advance: (consignmentId, status, at = new Date()) => {
      const record = registry.get(consignmentId);
      if (!record) {
        throw new Error(`Mock provider: unknown consignment ${consignmentId}`);
      }
      record.status = status;
      if (status === 'Delivered') {
        record.deliveredAt = at;
      }
      if (status === 'Cancelled') {
        record.cancelledAt = at;
      }
      record.statusUpdatedAt = at;
      return record;
    },
    failNextSubmitWith: (err) => {
      harness._failSubmit = err;
    },
    failNextCancelWith: (err) => {
      harness._failCancel = err;
    },
    _failSubmit: null,
    _failCancel: null,
  };

  return {
    name: 'mock',

    mapProviderStatus,

    async submitShipment(payload) {
      if (harness._failSubmit) {
        const err = harness._failSubmit;
        harness._failSubmit = null;
        throw err;
      }
      assertPayload(payload);
      const consignmentId = nextConsignmentId();
      const nowMs = now();
      registry.set(consignmentId, {
        consignmentId,
        merchantReference: payload.merchantReference,
        status: 'Pending',
        statusUpdatedAt: new Date(nowMs),
        deliveredAt: null,
        cancelledAt: null,
        amountToCollectMinorUnits: payload.amountToCollectMinorUnits || 0,
      });
      return {
        consignmentId,
        providerDeliveryFeeMinorUnits: 6000,
        providerStatus: 'Pending',
        providerStatusUpdatedAt: new Date(nowMs),
        localStatus: mapProviderStatus('Pending'),
        raw: { message: 'Order Created Successfully', data: { consignment_id: consignmentId } },
      };
    },

    async fetchShipmentStatus(consignmentId) {
      const record = registry.get(consignmentId);
      if (!record) {
        throw new CourierProviderError(
          COURIER_PROVIDER_ERROR_CODES.TRACKING_NOT_FOUND,
          `consignment ${consignmentId} not found`
        );
      }
      return {
        providerStatus: record.status,
        providerStatusUpdatedAt: record.statusUpdatedAt,
        localStatus: mapProviderStatus(record.status),
        raw: { data: record },
      };
    },

    async cancelShipment(consignmentId) {
      if (harness._failCancel) {
        const err = harness._failCancel;
        harness._failCancel = null;
        throw err;
      }
      const record = registry.get(consignmentId);
      if (!record) {
        throw new CourierProviderError(
          COURIER_PROVIDER_ERROR_CODES.CANCEL_REJECTED,
          `consignment ${consignmentId} not found`
        );
      }
      if (record.status === 'Delivered') {
        throw new CourierProviderError(
          COURIER_PROVIDER_ERROR_CODES.CANCEL_REJECTED,
          `consignment ${consignmentId} is already delivered and cannot be cancelled`
        );
      }
      record.status = 'Cancelled';
      record.cancelledAt = new Date(now());
      return { cancelledAt: record.cancelledAt, raw: { data: record } };
    },

    _harness: harness,
  };
}

module.exports = { createMockCourierProvider };
