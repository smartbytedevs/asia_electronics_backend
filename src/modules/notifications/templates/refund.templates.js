'use strict';

const { buildEmail } = require('./base');
const { escapeHtml, formatMinorUnits } = require('./helpers');
const { NOTIFICATION_EVENT_CATEGORIES } = require('../notification.constants');

/**
 * Refund lifecycle templates (Phase 11, ADR-0019).
 *
 * Data shape (built by the RefundService callers):
 *   {
 *     entityRef: <refund id>,
 *     refund: { refundNumber, amountMinorUnits, paymentMethod },
 *   }
 */

const category = NOTIFICATION_EVENT_CATEGORIES.REFUND;

const REFUND_PROCESSED = {
  key: 'REFUND_PROCESSED',
  category,
  render: ({ customer, data }) => {
    const refund = data.refund || {};
    const subject = `Refund ${refund.refundNumber || ''} processed`;
    return buildEmail({
      customer,
      subject,
      title: 'Your refund has been processed',
      bodyHtml: `<p style="margin:0 0 16px;font-size:14px;color:#3f3f46;">Refund ${
        refund.refundNumber || ''
      } of ${formatMinorUnits(refund.amountMinorUnits)} has been processed.</p>
        <p style="margin:0;font-size:14px;color:#3f3f46;">The amount will be returned through the payment method used for your order. Please allow a few business days for it to appear.</p>`,
      bodyText: `Refund ${refund.refundNumber || ''} of ${formatMinorUnits(
        refund.amountMinorUnits
      )} has been processed.`,
    });
  },
};

const REFUND_VOIDED = {
  key: 'REFUND_VOIDED',
  category,
  render: ({ customer, data }) => {
    const refund = data.refund || {};
    const subject = `Refund ${refund.refundNumber || ''} cancelled`;
    return buildEmail({
      customer,
      subject,
      title: 'A pending refund has been cancelled',
      bodyHtml: `<p style="margin:0;font-size:14px;color:#3f3f46;">Refund ${
        refund.refundNumber || ''
      } has been cancelled and will not be paid out. If you believe this is a mistake, please contact our support team.</p>`,
      bodyText: `Refund ${refund.refundNumber || ''} has been cancelled.`,
    });
  },
};

module.exports = {
  REFUND_PROCESSED,
  REFUND_VOIDED,
};
