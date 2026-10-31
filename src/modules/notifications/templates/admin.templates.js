'use strict';

const { escapeHtml, formatMinorUnits } = require('./helpers');
const { NOTIFICATION_EVENT_CATEGORIES } = require('../notification.constants');

/**
 * Admin dashboard templates (ADMIN channel).
 *
 * Unlike the EMAIL templates these render to a short in-app notification, not
 * an email, so `render` returns `{ title, message }` (no subject/html/text).
 * `message` is plain text (the admin UI renders it) and is HTML-escaped here
 * so it is safe whether the UI treats it as text or markup.
 *
 * Data shapes (built by the business services):
 *   ADMIN_ORDER_PLACED:
 *     {
 *       entityRef: <order id>,          // correlation/dedup only — never in text
 *       orderNumber, customerName,
 *       itemCount, grandTotalMinorUnits, paymentMethod,
 *     }
 *   ADMIN_REVIEW_SUBMITTED:
 *     {
 *       entityRef: <review id>,         // correlation/dedup only — never in text
 *       customerName, productName, rating, comment,
 *     }
 */

const category = NOTIFICATION_EVENT_CATEGORIES.ADMIN;

const ADMIN_ORDER_PLACED = {
  key: 'ADMIN_ORDER_PLACED',
  category,
  render: ({ data }) => {
    const itemCount = Number(data.itemCount) || 0;
    const grandTotalMinorUnits = Number(data.grandTotalMinorUnits) || 0;
    const title = `New order ${escapeHtml(String(data.orderNumber || '—'))}`;
    const message =
      `${escapeHtml(String(data.customerName || 'Customer'))} placed an order ` +
      `${escapeHtml(String(data.orderNumber || ''))} with ${itemCount} item${itemCount === 1 ? '' : 's'} ` +
      `(total ${formatMinorUnits(grandTotalMinorUnits)}, payment: ${escapeHtml(
        String(data.paymentMethod || '—')
      )}).`;
    return { title, message };
  },
};

const ADMIN_REVIEW_SUBMITTED = {
  key: 'ADMIN_REVIEW_SUBMITTED',
  category,
  render: ({ data }) => {
    const rating = Number(data.rating) || 0;
    const comment = data.comment && String(data.comment).trim() ? String(data.comment).trim() : null;
    const title = `New review: ${escapeHtml(String(data.productName || 'Product'))}`;
    let message =
      `${escapeHtml(String(data.customerName || 'Customer'))} rated ` +
      `${escapeHtml(String(data.productName || 'the product'))} ${rating}/5.`;
    if (comment) {
      message += ` "${escapeHtml(comment)}"`;
    }
    return { title, message };
  },
};

module.exports = {
  ADMIN_ORDER_PLACED,
  ADMIN_REVIEW_SUBMITTED,
};
