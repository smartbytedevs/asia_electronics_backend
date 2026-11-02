'use strict';

/**
 * Shared template helpers (Phase 11, ADR-0019).
 *
 * All templates escape user-controlled values before interpolating into HTML.
 * Money is integer minor units (paisa) everywhere; `formatMinorUnits` renders
 * the BDT taka symbol (৳) with two decimal places.
 *
 * Design tokens (premium Asia Electronics e-commerce email system):
 *   background  #f6f1e6  (warm ivory)
 *   card        #ffffff
 *   ink         #2a2722  (dark charcoal)
 *   body        #6b6459  (warm stone)
 *   muted       #9a9184  (warm muted)
 *   gold        #a8854c  (muted gold accent)
 *   border      #e7ddcb  (thin warm border)
 */

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMinorUnits(value) {
  const minor = Number(value) || 0;
  const taka = (minor / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `\u09F3${taka}`;
}

function formatDate(value) {
  if (!value) {
    return '';
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toISOString();
}

/**
 * Readable date + time (e.g. "15 Aug 2026, 10:24 AM") for the admin NEW ORDER
 * email. Invalid/missing values render as '' — never "Invalid Date".
 */
function formatDateTime(value) {
  if (!value) {
    return '';
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Long date (e.g. "15 August 2026") for the customer order confirmation.
 * Invalid/missing values render as '' — never "Invalid Date".
 */
function formatLongDate(value) {
  if (!value) {
    return '';
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/**
 * Human-readable variant summary (e.g. "52" or "Black, S") from the packed
 * variant attributes. Never exposes internal ids.
 */
function variantLabel(attributes) {
  if (!attributes || typeof attributes !== 'object') {
    return '';
  }
  const values = Object.values(attributes)
    .filter((v) => v !== null && v !== undefined && String(v).trim() !== '')
    .map((v) => String(v).trim());
  return values.join(', ');
}

/**
 * One-line delivery address for the admin NEW ORDER email.
 */
function fullAddress(address) {
  if (!address) {
    return '';
  }
  const parts = [
    address.line1,
    address.line2,
    [address.area, address.city].filter(Boolean).join(', '),
    address.district,
    address.postalCode,
  ].filter(Boolean);
  return parts.join(', ');
}

/**
 * Bulletproof, Gmail-safe CTA button. The `bgcolor` cell renders the pill in
 * clients that strip anchor backgrounds; the anchored, inline-styled link is
 * the fallback. Centered, content-width — safe on narrow mobile viewports.
 */
function emailButton(href, label) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0;">
    <tr>
      <td align="center" style="padding:0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
          <tr>
            <td align="center" bgcolor="#a8854c" style="border-radius:4px;">
              <a href="${escapeHtml(href)}" target="_blank" style="display:inline-block;padding:13px 34px;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#ffffff;text-decoration:none;border-radius:4px;">${escapeHtml(label)}</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>`;
}

/**
 * Uppercase section label (e.g. "ITEMS", "DELIVERING TO").
 */
function sectionLabel(label) {
  return `<p style="margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#a8854c;">${escapeHtml(label)}</p>`;
}

module.exports = {
  escapeHtml,
  formatMinorUnits,
  formatDate,
  formatDateTime,
  formatLongDate,
  variantLabel,
  fullAddress,
  emailButton,
  sectionLabel,
};
