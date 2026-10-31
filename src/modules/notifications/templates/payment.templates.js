'use strict';

const { buildEmail } = require('./base');
const { escapeHtml, formatMinorUnits } = require('./helpers');
const { NOTIFICATION_EVENT_CATEGORIES } = require('../notification.constants');

/**
 * Payment lifecycle templates (Phase 11, ADR-0019).
 *
 * Data shape (built by the PaymentService callers):
 *   {
 *     entityRef: <payment id>,
 *     order: { orderNumber },
 *     payment: { transactionReference, amountMinorUnits },
 *     note,               // staff note (verified/rejected) — optional
 *   }
 */

const category = NOTIFICATION_EVENT_CATEGORIES.PAYMENT;

const PAYMENT_SUBMITTED = {
  key: 'PAYMENT_SUBMITTED',
  category,
  render: ({ customer, data }) => {
    const order = data.order || {};
    const payment = data.payment || {};
    const subject = `Payment received for order ${order.orderNumber || ''}`;
    return buildEmail({
      customer,
      subject,
      title: 'We received your payment',
      bodyHtml: `<p style="margin:0 0 16px;font-size:14px;color:#3f3f46;">Thank you — we received a payment submission of ${formatMinorUnits(
        payment.amountMinorUnits
      )} for order ${escapeHtml(order.orderNumber || '')}.</p>
        <p style="margin:0;font-size:14px;color:#3f3f46;">Our team will verify it shortly. If you made a bank transfer, keep your transaction reference ${
          payment.transactionReference ? `(${escapeHtml(payment.transactionReference)})` : ''
        } handy.</p>`,
      bodyText: `We received your payment of ${formatMinorUnits(
        payment.amountMinorUnits
      )} for order ${order.orderNumber || ''}. It is pending verification.`,
    });
  },
};

const PAYMENT_VERIFIED = {
  key: 'PAYMENT_VERIFIED',
  category,
  render: ({ customer, data }) => {
    const order = data.order || {};
    const payment = data.payment || {};
    const subject = `Payment verified for order ${order.orderNumber || ''}`;
    return buildEmail({
      customer,
      subject,
      title: 'Your payment has been verified',
      bodyHtml: `<p style="margin:0 0 16px;font-size:14px;color:#3f3f46;">We verified your payment of ${formatMinorUnits(
        payment.amountMinorUnits
      )} for order ${escapeHtml(order.orderNumber || '')}.</p>
        <p style="margin:0;font-size:14px;color:#3f3f46;">Our team is preparing your order.</p>`,
      bodyText: `Your payment of ${formatMinorUnits(
        payment.amountMinorUnits
      )} for order ${order.orderNumber || ''} has been verified.`,
    });
  },
};

const PAYMENT_REJECTED = {
  key: 'PAYMENT_REJECTED',
  category,
  render: ({ customer, data }) => {
    const order = data.order || {};
    const subject = `Action needed: payment for order ${order.orderNumber || ''}`;
    const note = data.note ? `<p style="margin:0 0 16px;font-size:14px;color:#3f3f46;">Reason: ${escapeHtml(data.note)}</p>` : '';
    return buildEmail({
      customer,
      subject,
      title: 'We could not verify your payment',
      bodyHtml: `<p style="margin:0 0 16px;font-size:14px;color:#3f3f46;">We could not verify the payment for order ${escapeHtml(
        order.orderNumber || ''
      )}.${note}</p>
        <p style="margin:0;font-size:14px;color:#3f3f46;">Please resubmit your payment proof with the correct details. No amount has been charged that is not part of your order.</p>`,
      bodyText: `We could not verify the payment for order ${order.orderNumber || ''}. Please resubmit your payment proof.`,
    });
  },
};

module.exports = {
  PAYMENT_SUBMITTED,
  PAYMENT_VERIFIED,
  PAYMENT_REJECTED,
};
