'use strict';

const ApiError = require('../../utils/ApiError');
const { ERROR_CODES } = require('../../constants');
const { PAYMENT_MESSAGES, PAYMENT_METHOD_TYPES } = require('./payment.constants');
const { assertObjectId } = require('./paymentMethod.validation');
const {
  serializePaymentMethodForCustomer,
  serializePaymentMethodForAdmin,
} = require('./paymentMethod.serializer');

/**
 * PaymentMethod business logic (Phase 08, ADR-0016).
 *
 * ADMIN manages methods; customers only read ACTIVE ones. Deactivation is
 * ALWAYS soft (`isActive: false`) — payment methods are never hard deleted
 * because payments snapshot the method at submission time.
 */
class PaymentMethodService {
  constructor({ paymentMethodRepository }) {
    if (!paymentMethodRepository || typeof paymentMethodRepository.findById !== 'function') {
      throw new Error('PaymentMethodService requires a paymentMethodRepository');
    }
    this.paymentMethodRepository = paymentMethodRepository;
  }

  paymentMethodNotFound() {
    return new ApiError(
      404,
      PAYMENT_MESSAGES.PAYMENT_METHOD_NOT_FOUND,
      ERROR_CODES.PAYMENT_METHOD_NOT_FOUND
    );
  }

  codeAlreadyExists() {
    return new ApiError(
      409,
      `A payment method with this code already exists`,
      ERROR_CODES.PAYMENT_METHOD_CODE_ALREADY_EXISTS
    );
  }

  cardMetadataNotAllowed() {
    return new ApiError(
      400,
      'CARD payment methods do not accept manual transfer metadata',
      ERROR_CODES.INVALID_PAYMENT_METHOD
    );
  }

  isDuplicateKeyError(err) {
    return Boolean(
      err &&
        err.code === 11000 &&
        err.keyPattern &&
        Object.prototype.hasOwnProperty.call(err.keyPattern, 'code')
    );
  }

  async listActiveForCustomer() {
    const docs = await this.paymentMethodRepository.findMany(
      { isActive: true },
      { sort: { sortOrder: 1 }, lean: true }
    );
    return docs.map((doc) => serializePaymentMethodForCustomer(doc));
  }

  async createPaymentMethod(value) {
    try {
      const doc = await this.paymentMethodRepository.create(value);
      return serializePaymentMethodForAdmin(doc);
    } catch (err) {
      if (this.isDuplicateKeyError(err)) {
        throw this.codeAlreadyExists();
      }
      throw err;
    }
  }

  async updatePaymentMethod({ paymentMethodId, updates }) {
    assertObjectId(paymentMethodId, 'paymentMethodId');
    const existing = await this.paymentMethodRepository.findById(paymentMethodId);
    if (!existing) {
      throw this.paymentMethodNotFound();
    }
    const mergedType = updates.type || existing.type || PAYMENT_METHOD_TYPES.MANUAL;
    const mergedMetadata = updates.metadata !== undefined ? updates.metadata : existing.metadata || {};
    if (mergedType === PAYMENT_METHOD_TYPES.CARD) {
      const hasManualFields = Object.values(mergedMetadata).some(
        (value) => value !== null && value !== undefined && value !== ''
      );
      if (hasManualFields) {
        throw this.cardMetadataNotAllowed();
      }
    }
    const updated = await this.paymentMethodRepository.updateById(
      paymentMethodId,
      { $set: updates },
      { new: true, runValidators: true }
    );
    return serializePaymentMethodForAdmin(updated || existing);
  }

  async getPaymentMethodForAdmin(paymentMethodId) {
    assertObjectId(paymentMethodId, 'paymentMethodId');
    const doc = await this.paymentMethodRepository.findById(paymentMethodId);
    if (!doc) {
      throw this.paymentMethodNotFound();
    }
    return serializePaymentMethodForAdmin(doc);
  }
}

module.exports = { PaymentMethodService };
