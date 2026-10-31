'use strict';

const { NOTIFICATION_EVENT_CATEGORIES } = require('../notification.constants');
const {
  escapeHtml,
  formatMinorUnits,
  formatDateTime,
  variantLabel,
  fullAddress,
  emailButton,
  sectionLabel,
} = require('./helpers');

/**
 * Admin NEW ORDER email template (Phase 11, ADR-0019).
 *
 * Sent to the configured ADMIN_EMAIL whenever an order is placed (guests
 * included). This is the ADMIN channel: `render` receives `{ data }` (the
 * sanitized payload from OrderService.buildAdminEmailOrderNotificationData,
 * with `adminOrderUrl` appended by NotificationService.notifyAdminEmail) and
 * returns `{ subject, html, text }`.
 *
 * Shares the premium Taqwa email design system with the customer templates
 * (warm ivory canvas, dark charcoal type, muted-gold accents, white cards)
 * but stays information-dense and operational for the business. The email is
 * fully self-contained (table-based, Gmail-safe, inline styles). Every
 * user-controlled value is HTML-escaped. No Mongo ids appear in the visible
 * content — `data.entityRef` is only referenced inside the "View Order in
 * Admin Dashboard" button URL, which matches the admin UI's own deep link.
 */
const TEMPLATE_KEY = 'ADMIN_ORDER_PLACED_EMAIL';

function metaRow(label, value) {
  const text = escapeHtml(value);
  return `<tr>
    <td style="padding:7px 16px 7px 0;font-size:12px;color:#9a9184;vertical-align:top;white-space:nowrap;">${escapeHtml(label)}</td>
    <td style="padding:7px 0;font-size:13px;color:#2a2722;vertical-align:top;">${text || '<span style="color:#b4aa98;">—</span>'}</td>
  </tr>`;
}

function itemsHtml(items) {
  const rows = (items || [])
    .map((item) => {
      const size = variantLabel(item.variantAttributes);
      return `<tr>
        <td style="padding:11px 0;font-size:14px;font-weight:700;color:#2a2722;">${escapeHtml(item.productName)}${size ? `<span style="display:block;margin-top:2px;font-size:12px;font-weight:400;color:#9a9184;">Size: ${escapeHtml(size)}</span>` : ''}</td>
        <td align="center" style="padding:11px 0;font-size:14px;color:#6b6459;">${Number(item.quantity) || 0}</td>
        <td align="right" style="padding:11px 0;font-size:14px;color:#6b6459;">${formatMinorUnits(item.unitPriceMinorUnits)}</td>
        <td align="right" style="padding:11px 0;font-size:14px;font-weight:700;color:#2a2722;">${formatMinorUnits(item.lineTotalMinorUnits)}</td>
      </tr>`;
    })
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
    <thead>
      <tr>
        <th align="left" style="padding:0 0 8px;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#9a9184;border-bottom:1px solid #e7ddcb;">Item</th>
        <th align="center" style="padding:0 0 8px;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#9a9184;border-bottom:1px solid #e7ddcb;">Qty</th>
        <th align="right" style="padding:0 0 8px;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#9a9184;border-bottom:1px solid #e7ddcb;">Unit</th>
        <th align="right" style="padding:0 0 8px;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#9a9184;border-bottom:1px solid #e7ddcb;">Total</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function itemsText(items) {
  return (items || []).map((item) => {
    const size = variantLabel(item.variantAttributes);
    const sizeLabel = size ? ` (${size})` : '';
    return `${item.productName}${sizeLabel} × ${Number(item.quantity) || 0} — ${formatMinorUnits(item.unitPriceMinorUnits)} each — ${formatMinorUnits(item.lineTotalMinorUnits)}`;
  });
}

function buildAdminOrderEmailHtml({ data }) {
  const totals = data.totals || {};
  const discountRow =
    Number(totals.totalDiscountMinorUnits) > 0
      ? `<tr>
        <td style="padding:6px 0;font-size:13px;color:#6b6459;">Discount</td>
        <td align="right" style="padding:6px 0;font-size:13px;color:#6b6459;">-${formatMinorUnits(totals.totalDiscountMinorUnits)}</td>
      </tr>`
      : '';
  const notesBlock = data.notes
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;">
        <tr>
          <td style="padding:18px 20px;background-color:#fbf8f1;border:1px solid #e7ddcb;border-radius:6px;">
            ${sectionLabel('Customer notes')}
            <p style="margin:0;font-size:14px;line-height:1.7;color:#2a2722;">${escapeHtml(data.notes)}</p>
          </td>
        </tr>
      </table>`
    : '';

  const customerEmailLine = data.customerEmail
    ? `<br>${escapeHtml(data.customerEmail)}`
    : '';
  const customerLines = [
    data.customerName ? escapeHtml(data.customerName) : null,
    data.customerPhone ? escapeHtml(data.customerPhone) : null,
    fullAddress(data.address) ? escapeHtml(fullAddress(data.address)) : null,
  ].filter(Boolean);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(`New order ${data.orderNumber || ''} received`)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f6f1e6;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f6f1e6;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
          <tr>
            <td align="center" style="padding:0 0 22px;">
              <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:26px;letter-spacing:6px;color:#2a2722;text-transform:uppercase;">Taqwa</p>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:10px auto 0;">
                <tr>
                  <td style="width:40px;border-top:1px solid #a8854c;font-size:0;line-height:1px;height:1px;">&nbsp;</td>
                </tr>
              </table>
              <p style="margin:8px 0 0;font-size:11px;letter-spacing:2.5px;color:#9a9184;text-transform:uppercase;">taqwactg.com</p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#ffffff;border:1px solid #e7ddcb;border-radius:8px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding:36px 40px 32px;">
                    <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;color:#a8854c;">Admin notification</p>
                    <h1 style="margin:0 0 24px;font-family:Georgia,'Times New Roman',serif;font-size:24px;line-height:1.3;letter-spacing:2px;text-transform:uppercase;color:#2a2722;">New Order Received</h1>

                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 26px;">
                      <tr>
                        <td style="padding:16px 20px;background-color:#fbf8f1;border:1px solid #e7ddcb;border-radius:6px;">
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                            ${metaRow('Order number', data.orderNumber)}
                            ${metaRow('Order date', formatDateTime(data.createdAt))}
                            ${metaRow('Order status', data.status)}
                            ${metaRow('Payment method', data.paymentMethod)}
                            ${metaRow('Payment status', data.paymentStatus)}
                          </table>
                        </td>
                      </tr>
                    </table>

                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 26px;">
                      <tr>
                        <td style="padding:0;">
                          ${sectionLabel('Customer')}
                          <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:#2a2722;">${customerLines[0] || '<span style="color:#b4aa98;">—</span>'}</p>
                          <p style="margin:0;font-size:13px;line-height:1.7;color:#6b6459;">
                            ${customerLines.slice(1).join('<br>')}${customerEmailLine}
                          </p>
                        </td>
                      </tr>
                    </table>

                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 26px;">
                      <tr>
                        <td style="padding:0;">
                          ${sectionLabel('Items')}
                          ${itemsHtml(data.items)}
                        </td>
                      </tr>
                    </table>

                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td style="padding:0;">
                          ${sectionLabel('Order totals')}
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                            <tr>
                              <td style="padding:6px 0;font-size:13px;color:#6b6459;">Items subtotal</td>
                              <td align="right" style="padding:6px 0;font-size:13px;color:#6b6459;">${formatMinorUnits(totals.itemsSubtotalMinorUnits)}</td>
                            </tr>
                            ${discountRow}
                            <tr>
                              <td style="padding:6px 0;font-size:13px;color:#6b6459;">Delivery</td>
                              <td align="right" style="padding:6px 0;font-size:13px;color:#6b6459;">${formatMinorUnits(totals.deliveryFeeMinorUnits)}</td>
                            </tr>
                            <tr>
                              <td style="padding:10px 0 0;font-size:14px;font-weight:700;color:#2a2722;border-top:1px solid #e7ddcb;">Grand total</td>
                              <td align="right" style="padding:10px 0 0;font-size:14px;font-weight:700;color:#2a2722;border-top:1px solid #e7ddcb;">${formatMinorUnits(totals.grandTotalMinorUnits)}</td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>

                    ${notesBlock ? `${notesBlock}` : ''}

                    ${data.adminOrderUrl
                      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 0;">
                          <tr><td>${emailButton(data.adminOrderUrl, 'View Order in Admin Dashboard')}</td></tr>
                        </table>`
                      : ''}
                  </td>
                </tr>
                <tr>
                  <td style="padding:0 40px 30px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td style="padding:0;border-top:1px solid #e7ddcb;font-size:0;line-height:1px;height:1px;">&nbsp;</td>
                      </tr>
                    </table>
                    <p style="margin:18px 0 0;font-size:12px;line-height:1.7;color:#9a9184;">
                      This is an automated notification from the Taqwa admin system (taqwactg.com).
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildAdminOrderEmailText({ data }) {
  const totals = data.totals || {};
  const lines = [
    'NEW ORDER RECEIVED',
    '',
    `Order number: ${data.orderNumber || '-'}`,
    `Order date: ${formatDateTime(data.createdAt) || '-'}`,
    `Order status: ${data.status || '-'}`,
    `Payment method: ${data.paymentMethod || '-'}`,
    `Payment status: ${data.paymentStatus || '-'}`,
    '',
    'Customer:',
    data.customerName || '-',
    data.customerPhone,
    data.customerEmail,
    fullAddress(data.address),
    '',
    'Items:',
    ...itemsText(data.items),
    '',
    `Items subtotal: ${formatMinorUnits(totals.itemsSubtotalMinorUnits)}`,
  ];
  if (Number(totals.totalDiscountMinorUnits) > 0) {
    lines.push(`Discount: -${formatMinorUnits(totals.totalDiscountMinorUnits)}`);
  }
  lines.push(`Delivery: ${formatMinorUnits(totals.deliveryFeeMinorUnits)}`);
  lines.push(`Grand total: ${formatMinorUnits(totals.grandTotalMinorUnits)}`);
  if (data.notes) {
    lines.push('', 'Customer notes:', data.notes);
  }
  if (data.adminOrderUrl) {
    lines.push('', `View in admin dashboard: ${data.adminOrderUrl}`);
  }
  lines.push('', 'Taqwa (taqwactg.com)');
  return lines.join('\n');
}

const template = {
  key: TEMPLATE_KEY,
  category: NOTIFICATION_EVENT_CATEGORIES.ADMIN,
  render({ data = {} }) {
    return {
      subject: `New order ${data.orderNumber || ''} received`,
      html: buildAdminOrderEmailHtml({ data }),
      text: buildAdminOrderEmailText({ data }),
    };
  },
};

module.exports = {
  [TEMPLATE_KEY]: template,
};
