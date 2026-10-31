'use strict';

const { buildEmail } = require('./base');
const { escapeHtml, formatMinorUnits } = require('./helpers');
const { NOTIFICATION_EVENT_CATEGORIES } = require('../notification.constants');

/**
 * Return lifecycle templates (Phase 11, ADR-0019).
 *
 * Data shape (built by the ReturnService callers):
 *   {
 *     entityRef: <return id>,
 *     order: { orderNumber },
 *     return: {
 *       returnNumber, reason, itemCount,
 *       items: [{ productName, quantity }],
 *       refundAmountMinorUnits,   // completed only
 *     },
 *   }
 */

const category = NOTIFICATION_EVENT_CATEGORIES.RETURN;

const RETURN_REQUESTED = {
  key: 'RETURN_REQUESTED',
  category,
  render: ({ customer, data }) => {
    const order = data.order || {};
    const returnDoc = data.return || {};
    const subject = `Return request ${returnDoc.returnNumber || ''} received`;
    const reason = returnDoc.reason
      ? `<p style="margin:0 0 16px;font-size:14px;color:#3f3f46;">Reason: ${escapeHtml(returnDoc.reason)}</p>`
      : '';
    return buildEmail({
      customer,
      subject,
      title: 'We received your return request',
      bodyHtml: `<p style="margin:0 0 16px;font-size:14px;color:#3f3f46;">Your return request ${
        returnDoc.returnNumber || ''
      } for order ${escapeHtml(order.orderNumber || '')} has been received.</p>${reason}
        <p style="margin:0;font-size:14px;color:#3f3f46;">Our team will review it and notify you of the outcome.</p>`,
      bodyText: `Your return request ${returnDoc.returnNumber || ''} for order ${order.orderNumber || ''} has been received.`,
    });
  },
};

const RETURN_APPROVED = {
  key: 'RETURN_APPROVED',
  category,
  render: ({ customer, data }) => {
    const order = data.order || {};
    const returnDoc = data.return || {};
    const subject = `Return ${returnDoc.returnNumber || ''} approved`;
    return buildEmail({
      customer,
      subject,
      title: 'Your return has been approved',
      bodyHtml: `<p style="margin:0 0 16px;font-size:14px;color:#3f3f46;">Return ${
        returnDoc.returnNumber || ''
      } for order ${escapeHtml(order.orderNumber || '')} has been approved.</p>
        <p style="margin:0;font-size:14px;color:#3f3f46;">Our team will coordinate the pickup, and once the return is completed your refund will be initiated.</p>`,
      bodyText: `Return ${returnDoc.returnNumber || ''} for order ${order.orderNumber || ''} has been approved.`,
    });
  },
};

const RETURN_REJECTED = {
  key: 'RETURN_REJECTED',
  category,
  render: ({ customer, data }) => {
    const order = data.order || {};
    const returnDoc = data.return || {};
    const subject = `Return ${returnDoc.returnNumber || ''} could not be approved`;
    return buildEmail({
      customer,
      subject,
      title: 'We could not approve your return',
      bodyHtml: `<p style="margin:0 0 16px;font-size:14px;color:#3f3f46;">Unfortunately return ${
        returnDoc.returnNumber || ''
      } for order ${escapeHtml(order.orderNumber || '')} could not be approved.</p>
        <p style="margin:0;font-size:14px;color:#3f3f46;">If you have any questions, please contact our support team.</p>`,
      bodyText: `Return ${returnDoc.returnNumber || ''} for order ${order.orderNumber || ''} could not be approved.`,
    });
  },
};

const RETURN_COMPLETED = {
  key: 'RETURN_COMPLETED',
  category,
  render: ({ customer, data }) => {
    const order = data.order || {};
    const returnDoc = data.return || {};
    const subject = `Return ${returnDoc.returnNumber || ''} completed`;
    return buildEmail({
      customer,
      subject,
      title: 'Your return has been completed',
      bodyHtml: `<p style="margin:0 0 16px;font-size:14px;color:#3f3f46;">Return ${
        returnDoc.returnNumber || ''
      } for order ${escapeHtml(order.orderNumber || '')} has been completed.</p>
        <p style="margin:0;font-size:14px;color:#3f3f46;">A refund of ${formatMinorUnits(
          returnDoc.refundAmountMinorUnits
        )} has been initiated and will be processed by our team.</p>`,
      bodyText: `Return ${returnDoc.returnNumber || ''} for order ${
        order.orderNumber || ''
      } has been completed. A refund of ${formatMinorUnits(returnDoc.refundAmountMinorUnits)} has been initiated.`,
    });
  },
};

const RETURN_CANCELLED = {
  key: 'RETURN_CANCELLED',
  category,
  render: ({ customer, data }) => {
    const order = data.order || {};
    const returnDoc = data.return || {};
    const subject = `Return ${returnDoc.returnNumber || ''} cancelled`;
    return buildEmail({
      customer,
      subject,
      title: 'Your return has been cancelled',
      bodyHtml: `<p style="margin:0;font-size:14px;color:#3f3f46;">Return ${
        returnDoc.returnNumber || ''
      } for order ${escapeHtml(order.orderNumber || '')} has been cancelled. No changes were made to your order.</p>`,
      bodyText: `Return ${returnDoc.returnNumber || ''} for order ${order.orderNumber || ''} has been cancelled.`,
    });
  },
};

module.exports = {
  RETURN_REQUESTED,
  RETURN_APPROVED,
  RETURN_REJECTED,
  RETURN_COMPLETED,
  RETURN_CANCELLED,
};
