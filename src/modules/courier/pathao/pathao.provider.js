'use strict';

const { PathaoClient } = require('./pathao.client');
const pathaoMapper = require('./pathao.mapper');
const {
  CourierProviderError,
  COURIER_PROVIDER_ERROR_CODES,
} = require('../courier.errors');

/**
 * Pathao provider — implements the courier provider interface
 * (courier.provider.interface.js) over the Pathao Courier Merchant API.
 *
 * Construction never throws (configuration validation is deferred to first
 * use); credentials come from the central config via `client`.
 */
function createPathaoCourierProvider({ client, config, mapper = pathaoMapper }) {
  if (!client || typeof client.createOrder !== 'function') {
    throw new Error('createPathaoCourierProvider requires a PathaoClient');
  }
  const storeId = config && config.storeId;

  return {
    name: 'pathao',

    mapProviderStatus: (providerStatus) => mapper.mapProviderStatus(providerStatus),

    async submitShipment(payload) {
      if (!storeId) {
        throw new CourierProviderError(
          COURIER_PROVIDER_ERROR_CODES.NOT_CONFIGURED,
          'Pathao courier is not configured (missing: PATHAO_STORE_ID). See .env.example.'
        );
      }
      const response = await client.createOrder(
        mapper.buildCreateOrderPayload({ payload, storeId })
      );
      const result = mapper.mapSubmitResult(response);
      if (!result.consignmentId) {
        throw new CourierProviderError(
          COURIER_PROVIDER_ERROR_CODES.PROVIDER_REJECTED,
          'Pathao create order did not return a consignment_id',
          { raw: response }
        );
      }
      return { ...result, localStatus: mapper.mapProviderStatus(result.providerStatus) };
    },

    async fetchShipmentStatus(consignmentId) {
      const response = await client.getOrderStatus(consignmentId);
      const result = mapper.mapStatusResult(response);
      if (!result.providerStatus) {
        throw new CourierProviderError(
          COURIER_PROVIDER_ERROR_CODES.TRACKING_NOT_FOUND,
          `No status available for consignment ${consignmentId}`,
          { raw: response }
        );
      }
      return { ...result, localStatus: mapper.mapProviderStatus(result.providerStatus) };
    },

    async cancelShipment(consignmentId) {
      const response = await client.cancelOrder(consignmentId);
      return mapper.mapCancelResult(response);
    },
  };
}

module.exports = { createPathaoCourierProvider, PathaoClient };
