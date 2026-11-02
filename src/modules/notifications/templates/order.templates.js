'use strict';

const { buildEmail } = require('./base');
const {
  escapeHtml,
  formatMinorUnits,
  formatLongDate,
  variantLabel,
  emailButton,
  sectionLabel,
} = require('./helpers');
const { NOTIFICATION_EVENT_CATEGORIES } = require('../notification.constants');

/**
 * Order lifecycle templates (Phase 11, ADR-0019).
 *
 * Data shape (built by OrderService.buildOrderNotificationData):
 *   {
 *     entityRef: <order id>,       // correlation/dedup only — never in text
 *     customerEmail,
 *     trackOrderUrl,               // appended by NotificationService.notify
 *     order: {
 *       orderNumber, status, paymentMethod, createdAt, notes,
 *       grandTotalMinorUnits, deliveryFeeMinorUnits,
 *       totals: { itemsSubtotalMinorUnits, totalDiscountMinorUnits,
 *                 deliveryFeeMinorUnits, grandTotalMinorUnits },
 *       items: [{ productName, quantity, unitPriceMinorUnits,
 *                 lineTotalMinorUnits, variantAttributes, productImageUrl }],
 *       delivery: { address: { fullName, phone, email, line1, line2,
 *                              area, city, district, postalCode } },
 *     },
 *   }
 */

const category = NOTIFICATION_EVENT_CATEGORIES.ORDER;

function orderHeaderHtml(order) {
  const number = escapeHtml(order.orderNumber || '—');
  const date = escapeHtml(formatLongDate(order.createdAt)) || '&nbsp;';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;">
    <tr>
      <td style="padding:0;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#9a9184;">Order number</p>
        <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:18px;color:#2a2722;">${number}</p>
      </td>
      <td align="right" style="padding:0;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#9a9184;">Order date</p>
        <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:18px;color:#2a2722;">${date}</p>
      </td>
    </tr>
  </table>`;
}

function paymentHtml(order) {
  const isCod = order.paymentMethod === 'COD';
  const methodLabel = isCod
    ? 'Cash on Delivery'
    : order.paymentMethod
      ? escapeHtml(order.paymentMethod)
      : '—';
  const note = isCod
    ? 'You have chosen Cash on Delivery — please keep the order amount ready at delivery.'
    : 'We will contact you with bank transfer details shortly.';
  return `<td style="padding:18px 20px;background-color:#fbf8f1;border:1px solid #e7ddcb;border-radius:6px;">
    ${sectionLabel('Payment')}
    <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:#2a2722;">${methodLabel}</p>
    <p style="margin:0;font-size:13px;line-height:1.6;color:#6b6459;">${note}</p>
  </td>`;
}

function itemsHtml(order) {
  const items = (order && order.items) || [];
  if (items.length === 0) {
    return `<p style="margin:0;font-size:14px;color:#6b6459;">Order items were not captured.</p>`;
  }
  const rows = items
    .map((item) => {
      const size = variantLabel(item.variantAttributes);
      const image = item.productImageUrl
        ? `<img src="${escapeHtml(item.productImageUrl)}" alt="" width="56" height="56" style="display:block;width:56px;height:56px;border-radius:4px;border:1px solid #e7ddcb;">`
        : '';
      return `<tr>
        <td style="padding:12px 12px 12px 0;width:56px;vertical-align:top;">${image}</td>
        <td style="padding:12px 0;vertical-align:top;">
          <p style="margin:0 0 2px;font-size:14px;font-weight:700;color:#2a2722;">${escapeHtml(item.productName)}</p>
          ${size ? `<p style="margin:0;font-size:12px;color:#9a9184;">${escapeHtml(size)}</p>` : ''}
        </td>
        <td align="center" style="padding:12px 0;vertical-align:top;font-size:14px;color:#6b6459;">${Number(item.quantity) || 0}</td>
        <td align="right" style="padding:12px 0 12px 12px;vertical-align:top;font-size:14px;color:#6b6459;">${formatMinorUnits(item.unitPriceMinorUnits)}</td>
        <td align="right" style="padding:12px 0 12px 16px;vertical-align:top;font-size:14px;font-weight:700;color:#2a2722;">${formatMinorUnits(item.lineTotalMinorUnits)}</td>
      </tr>`;
    })
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
    <thead>
      <tr>
        <th align="left" style="padding:0 0 8px;width:56px;"></th>
        <th align="left" style="padding:0 0 8px;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#9a9184;border-bottom:1px solid #e7ddcb;">Item</th>
        <th align="center" style="padding:0 0 8px;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#9a9184;border-bottom:1px solid #e7ddcb;">Qty</th>
        <th align="right" style="padding:0 0 8px;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#9a9184;border-bottom:1px solid #e7ddcb;">Unit</th>
        <th align="right" style="padding:0 0 8px;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#9a9184;border-bottom:1px solid #e7ddcb;">Total</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function totalsHtml(order) {
  const totals = (order && order.totals) || {};
  const delivery =
    totals.deliveryFeeMinorUnits !== undefined && totals.deliveryFeeMinorUnits !== null
      ? totals.deliveryFeeMinorUnits
      : order.deliveryFeeMinorUnits;
  const deliveryRow =
    delivery !== undefined && delivery !== null
      ? `<tr>
        <td style="padding:6px 0;font-size:13px;color:#6b6459;">Delivery</td>
        <td align="right" style="padding:6px 0;font-size:13px;color:#6b6459;">${formatMinorUnits(delivery)}</td>
      </tr>`
      : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:4px;">
    <tr>
      <td style="padding:6px 0;font-size:13px;color:#6b6459;">Items subtotal</td>
      <td align="right" style="padding:6px 0;font-size:13px;color:#6b6459;">${formatMinorUnits(totals.itemsSubtotalMinorUnits)}</td>
    </tr>
    ${deliveryRow}
    <tr>
      <td style="padding:10px 0 0;font-size:14px;font-weight:700;color:#2a2722;border-top:1px solid #e7ddcb;">Grand total</td>
      <td align="right" style="padding:10px 0 0;font-size:14px;font-weight:700;color:#2a2722;border-top:1px solid #e7ddcb;">${formatMinorUnits(
        totals.grandTotalMinorUnits !== undefined && totals.grandTotalMinorUnits !== null
          ? totals.grandTotalMinorUnits
          : order.grandTotalMinorUnits
      )}</td>
    </tr>
  </table>`;
}

function deliveryAddressHtml(order) {
  const address = (order && order.delivery && order.delivery.address) || {};
  const lines = [
    [address.line1, address.line2].filter(Boolean).join(', '),
    [address.area, address.city].filter(Boolean).join(', '),
    address.district,
    address.postalCode,
  ].filter(Boolean);
  const parts = [address.fullName, address.phone, ...lines].filter(Boolean);
  if (parts.length === 0) {
    return '';
  }
  return `<td style="padding:18px 20px;background-color:#fbf8f1;border:1px solid #e7ddcb;border-radius:6px;">
    ${sectionLabel('Delivering to')}
    <p style="margin:0;font-size:14px;line-height:1.7;color:#2a2722;">${parts
      .map(escapeHtml)
      .join('<br>')}</p>
  </td>`;
}

function notesHtml(order) {
  if (!order.notes) {
    return '';
  }
  return `<td style="padding:18px 20px;background-color:#fbf8f1;border:1px solid #e7ddcb;border-radius:6px;">
    ${sectionLabel('Order notes')}
    <p style="margin:0;font-size:14px;line-height:1.7;color:#2a2722;">${escapeHtml(order.notes)}</p>
  </td>`;
}

function itemsText(order) {
  const items = (order && order.items) || [];
  return items.map((item) => {
    const size = variantLabel(item.variantAttributes);
    const sizeLabel = size ? ` (${size})` : '';
    return `${item.productName}${sizeLabel} — ${Number(item.quantity) || 0} × ${formatMinorUnits(
      item.unitPriceMinorUnits
    )} = ${formatMinorUnits(item.lineTotalMinorUnits)}`;
  });
}

function addressText(order) {
  const address = (order && order.delivery && order.delivery.address) || {};
  return [
    address.fullName,
    address.phone,
    [address.line1, address.line2].filter(Boolean).join(', '),
    [address.area, address.city].filter(Boolean).join(', '),
    address.district,
    address.postalCode,
  ].filter(Boolean);
}

function orderConfirmedText(data) {
  const order = data.order || {};
  const totals = order.totals || {};
  const lines = [
    `Your order ${order.orderNumber || ''} has been placed successfully.`,
    '',
    `Order number: ${order.orderNumber || '-'}`,
    `Order date: ${formatLongDate(order.createdAt) || '-'}`,
    '',
    `Payment: ${order.paymentMethod === 'COD' ? 'Cash on Delivery' : order.paymentMethod || '-'}`,
    order.paymentMethod === 'COD'
      ? 'You have chosen Cash on Delivery — please keep the order amount ready at delivery.'
      : 'We will contact you with bank transfer details shortly.',
    '',
    'Items:',
    ...itemsText(order),
    '',
    `Items subtotal: ${formatMinorUnits(totals.itemsSubtotalMinorUnits)}`,
  ];
  if (
    totals.deliveryFeeMinorUnits !== undefined &&
    totals.deliveryFeeMinorUnits !== null
  ) {
    lines.push(`Delivery: ${formatMinorUnits(totals.deliveryFeeMinorUnits)}`);
  } else if (order.deliveryFeeMinorUnits !== undefined && order.deliveryFeeMinorUnits !== null) {
    lines.push(`Delivery: ${formatMinorUnits(order.deliveryFeeMinorUnits)}`);
  }
  lines.push(`Grand total: ${formatMinorUnits(
    totals.grandTotalMinorUnits !== undefined && totals.grandTotalMinorUnits !== null
      ? totals.grandTotalMinorUnits
      : order.grandTotalMinorUnits
  )}`);
  const address = addressText(order);
  if (address.length > 0) {
    lines.push('', 'Delivering to:', ...address);
  }
  if (order.notes) {
    lines.push('', 'Order notes:', order.notes);
  }
  if (data.trackOrderUrl) {
    lines.push('', `Track your order: ${"https://www.asiaelectronicsonline.com/track-order"}`);
  }
  lines.push('', 'Our team will confirm your order shortly.');
  return lines.join('\n');
}

const ORDER_PLACED = {
  key: 'ORDER_PLACED',
  category,
  render: ({ customer, data }) => {
    const order = data.order || {};
    const subject = `Order ${order.orderNumber || ''} received`;
    return buildEmail({
      customer,
      subject,
      overline: 'Order Confirmation',
      title: 'Order confirmed',
      bodyHtml: `
        ${orderHeaderHtml(order)}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;">
          <tr>${paymentHtml(order)}</tr>
        </table>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;">
          <tr>
            <td style="padding:0;">
              ${sectionLabel('Your items')}
              ${itemsHtml(order)}
              ${totalsHtml(order)}
            </td>
          </tr>
        </table>
        ${deliveryAddressHtml(order) ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;"><tr>${deliveryAddressHtml(order)}</tr></table>` : ''}
        ${notesHtml(order) ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;"><tr>${notesHtml(order)}</tr></table>` : ''}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;"><tr><td>${emailButton('https://www.asiaelectronicsonline.com/track-order', 'Track Your Order')}</td></tr></table>
        <p style="margin:0;font-size:14px;line-height:1.7;color:#6b6459;">Our team will confirm your order shortly.</p>`,
      bodyText: orderConfirmedText(data),
    });
  },
};

const ORDER_CONFIRMED = {
  key: 'ORDER_CONFIRMED',
  category,
  render: ({ customer, data }) => {
    const order = data.order || {};
    const subject = `Order ${order.orderNumber || ''} confirmed`;
    return buildEmail({
      customer,
      subject,
      title: 'Your order is confirmed',
      bodyHtml: `<p style="margin:0 0 16px;font-size:14px;color:#6b6459;">Great news — order ${escapeHtml(
        order.orderNumber || ''
      )} has been confirmed and is being prepared for delivery.</p>
        <p style="margin:0;font-size:14px;color:#6b6459;">We will notify you when it is dispatched.</p>`,
      bodyText: `Order ${order.orderNumber || ''} has been confirmed and is being prepared for delivery.`,
    });
  },
};

const ORDER_PROCESSING = {
  key: 'ORDER_PROCESSING',
  category,
  render: ({ customer, data }) => {
    const order = data.order || {};
    const subject = `Order ${order.orderNumber || ''} is being processed`;
    return buildEmail({
      customer,
      subject,
      title: 'Your order is being processed',
      bodyHtml: `<p style="margin:0;font-size:14px;color:#6b6459;">We are working on order ${escapeHtml(
        order.orderNumber || ''
      )}. You will receive a notification once it is handed to our courier.</p>`,
      bodyText: `Order ${order.orderNumber || ''} is being processed.`,
    });
  },
};

const ORDER_REJECTED = {
  key: 'ORDER_REJECTED',
  category,
  render: ({ customer, data }) => {
    const order = data.order || {};
    const subject = `Order ${order.orderNumber || ''} could not be confirmed`;
    return buildEmail({
      customer,
      subject,
      title: 'We could not confirm your order',
      bodyHtml: `<p style="margin:0 0 16px;font-size:14px;color:#6b6459;">Unfortunately order ${escapeHtml(
        order.orderNumber || ''
      )} could not be confirmed. Any stock held for it has been released, and no payment has been taken.</p>
        <p style="margin:0;font-size:14px;color:#6b6459;">If you believe this is a mistake, please contact our support team.</p>`,
      bodyText: `Order ${order.orderNumber || ''} could not be confirmed. No payment has been taken.`,
    });
  },
};

const ORDER_CANCELLED = {
  key: 'ORDER_CANCELLED',
  category,
  render: ({ customer, data }) => {
    const order = data.order || {};
    const subject = `Order ${order.orderNumber || ''} cancelled`;
    return buildEmail({
      customer,
      subject,
      title: 'Your order has been cancelled',
      bodyHtml: `<p style="margin:0 0 16px;font-size:14px;color:#6b6459;">Order ${escapeHtml(
        order.orderNumber || ''
      )} has been cancelled. Any stock reserved for it has been released.</p>
        <p style="margin:0;font-size:14px;color:#6b6459;">If you already sent a payment, our team will follow up with a refund.</p>`,
      bodyText: `Order ${order.orderNumber || ''} has been cancelled.`,
    });
  },
};

module.exports = {
  ORDER_PLACED,
  ORDER_CONFIRMED,
  ORDER_PROCESSING,
  ORDER_REJECTED,
  ORDER_CANCELLED,
};
