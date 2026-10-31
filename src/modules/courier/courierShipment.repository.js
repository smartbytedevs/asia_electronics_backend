'use strict';

const { createBaseRepository } = require('../base/base.repository');
const { COURIER_STATUSES } = require('./courier.constants');

/**
 * Courier shipment persistence layer (Phase 09, ADR-0017).
 *
 * Encapsulates database operations only — no authorization, business rules,
 * HTTP, or provider calls. The guarded updates below are the ATOMIC CONFLICT
 * POINT for the courier state machine: submit/cancel/status transitions move a
 * shipment ONLY while it is still in the expected source status, so concurrent
 * dispatches/cancels/webhooks cannot double-apply.
 */
function createCourierShipmentRepository(model) {
  const base = createBaseRepository(model);

  return {
    ...base,

    findByOrderId: (orderId, options = {}) => base.findOne({ orderId }, options),

    findByConsignmentId: (consignmentId, options = {}) =>
      base.findOne({ consignmentId }, options),

    findByMerchantReference: (merchantReference, options = {}) =>
      base.findOne({ merchantReference }, options),

    /**
     * Atomic status transition: moves a shipment from `fromStatus` to
     * `toStatus` ONLY while it is still in `fromStatus`, applies any extra
     * `$set` fields (e.g. consignmentId, cancel timestamps), appends the
     * history entry, and returns the updated doc (or `null` on conflict).
     */
    transitionStatus: (id, fromStatus, toStatus, historyEntry, setFields = {}, options = {}) =>
      model.findOneAndUpdate(
        { _id: id, status: fromStatus },
        { $set: { status: toStatus, ...setFields }, $push: { statusHistory: historyEntry } },
        { new: true, runValidators: true, ...options }
      ),

    /**
     * Records a failed provider submission on a PENDING/FAILED shipment:
     * keeps the status FAILED, increments the attempt counter, snapshots the
     * error, and appends history. Returns the updated doc (or `null` if the
     * shipment already left PENDING/FAILED — e.g. concurrently cancelled).
     */
    recordSubmissionFailure: (
      id,
      { payload, errorCode, errorMessage, errorRaw, performedBy, attemptedAt }
    ) =>
      model.findOneAndUpdate(
        { _id: id, status: { $in: [COURIER_STATUSES.PENDING, COURIER_STATUSES.FAILED] } },
        {
          $set: {
            status: COURIER_STATUSES.FAILED,
            'submission.payload': payload,
            'submission.lastError': {
              code: errorCode,
              message: errorMessage,
              raw: errorRaw || null,
            },
            'submission.lastSubmitAttemptAt': attemptedAt,
          },
          $inc: { 'submission.attempts': 1 },
          $push: {
            statusHistory: {
              status: COURIER_STATUSES.FAILED,
              at: attemptedAt,
              by: performedBy,
              note: errorMessage,
            },
          },
        },
        { new: true, runValidators: true }
      ),

    /**
     * Records a successful provider submission on a PENDING/FAILED shipment:
     * transitions to ACTIVE, stores the consignment id + provider fees, and
     * snapshots the initial provider status. Returns the updated doc (or
     * `null` on a lost race).
     */
    recordSubmissionSuccess: (
      id,
      {
        consignmentId,
        providerDeliveryFeeMinorUnits,
        currency = 'BDT',
        payload,
        providerStatus,
        providerStatusUpdatedAt,
        submittedAt,
        performedBy,
      }
    ) =>
      model.findOneAndUpdate(
        { _id: id, status: { $in: [COURIER_STATUSES.PENDING, COURIER_STATUSES.FAILED] } },
        {
          $set: {
            status: COURIER_STATUSES.ACTIVE,
            consignmentId,
            'submission.payload': payload,
            'submission.submittedAt': submittedAt,
            'submission.lastSubmitAttemptAt': submittedAt,
            'submission.lastError': null,
            'fees.providerDeliveryFeeMinorUnits': providerDeliveryFeeMinorUnits,
            'fees.currency': currency,
            'providerStatus.status': providerStatus,
            'providerStatus.updatedAt': providerStatusUpdatedAt,
            'providerStatus.fetchedAt': submittedAt,
          },
          $inc: { 'submission.attempts': 1 },
          $push: {
            statusHistory: {
              status: COURIER_STATUSES.ACTIVE,
              at: submittedAt,
              by: performedBy,
              note: `Assigned consignment ${consignmentId}`,
              providerStatus,
            },
          },
        },
        { new: true, runValidators: true }
      ),

    /**
     * Refreshes provider status without changing the local lifecycle status
     * (used while a shipment stays ACTIVE).
     */
    touchProviderStatus: (id, { providerStatus, updatedAt, fetchedAt }, options = {}) =>
      model.findByIdAndUpdate(
        id,
        {
          $set: {
            'providerStatus.status': providerStatus,
            'providerStatus.updatedAt': updatedAt,
            'providerStatus.fetchedAt': fetchedAt,
          },
        },
        { new: true, runValidators: true, ...options }
      ),

    /**
     * Shipments eligible for provider reconciliation: open statuses whose last
     * check is older than `fetchedBefore` (or never checked).
     */
    findReconcilable: (statuses, fetchedBefore, options = {}) =>
      model.find(
        {
          status: { $in: statuses },
          $or: [
            { 'providerStatus.fetchedAt': null },
            { 'providerStatus.fetchedAt': { $lt: fetchedBefore } },
          ],
        },
        null,
        options
      ),
  };
}

module.exports = { createCourierShipmentRepository };
