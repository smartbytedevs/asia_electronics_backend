'use strict';

const { buildEmail } = require('./base');
const { escapeHtml } = require('./helpers');
const { NOTIFICATION_EVENT_CATEGORIES } = require('../notification.constants');

/**
 * Courier lifecycle templates (Phase 11, ADR-0019).
 *
 * Data shape (built by the CourierService callers):
 *   {
 *     entityRef: <shipment id>,
 *     order: { orderNumber },
 *     shipment: { consignmentId },
 *   }
 */

const category = NOTIFICATION_EVENT_CATEGORIES.COURIER;

const SHIPMENT_DISPATCHED = {
  key: 'SHIPMENT_DISPATCHED',
  category,
  render: ({ customer, data }) => {
    const order = data.order || {};
    const shipment = data.shipment || {};
    const subject = `Order ${order.orderNumber || ''} is on its way`;
    return buildEmail({
      customer,
      subject,
      title: 'Your order has been dispatched',
      bodyHtml: `<p style="margin:0 0 16px;font-size:14px;color:#3f3f46;">Good news — order ${escapeHtml(
        order.orderNumber || ''
      )} has been handed to our courier partner.</p>
        <p style="margin:0;font-size:14px;color:#3f3f46;">Tracking number: ${escapeHtml(
          shipment.consignmentId || 'assigned on delivery'
        )}.</p>`,
      bodyText: `Order ${order.orderNumber || ''} has been dispatched. Tracking number: ${shipment.consignmentId || 'assigned on delivery'}.`,
    });
  },
};

const ORDER_DELIVERED = {
  key: 'ORDER_DELIVERED',
  category,
  render: ({ customer, data }) => {
    const order = data.order || {};
    const subject = `Order ${order.orderNumber || ''} delivered`;
    return buildEmail({
      customer,
      subject,
      title: 'Your order has been delivered',
      bodyHtml: `<p style="margin:0 0 16px;font-size:14px;color:#3f3f46;">Order ${escapeHtml(
        order.orderNumber || ''
      )} has been delivered. We hope you love it!</p>
        <p style="margin:0;font-size:14px;color:#3f3f46;">If anything is not right, you can request a return from your Asia Electronics account.</p>`,
      bodyText: `Order ${order.orderNumber || ''} has been delivered. If anything is not right, you can request a return from your Asia Electronics account.`,
    });
  },
};

module.exports = {
  SHIPMENT_DISPATCHED,
  ORDER_DELIVERED,
};
