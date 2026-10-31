'use strict';

const { escapeHtml } = require('./helpers');

/**
 * Email shell builder (Phase 11, ADR-0019).
 *
 * Every customer template produces `{ subject, html, text }` through this
 * shared shell so the transactional emails share one premium Taqwa brand voice
 * (warm ivory canvas, dark charcoal type, muted-gold accents, white content
 * cards) and one plain-text fallback. `bodyHtml`/`bodyText` are
 * template-specific fragments; all user-controlled values must already be
 * escaped by the caller.
 *
 * Gmail/mobile-safe: table-based, fully inline-styled, no JavaScript, no
 * external assets, no gradients/shadows/animations.
 */
function buildEmail({ customer, subject, title, overline = null, bodyHtml, bodyText }) {
  const name = customer && customer.name ? customer.name : 'there';
  const greeting = `Assalamu alaikum ${escapeHtml(name)},`;

  const overlineHtml = overline
    ? `<p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;color:#a8854c;">${escapeHtml(overline)}</p>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(subject)}</title>
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
                    ${overlineHtml}
                    <h1 style="margin:0 0 14px;font-family:Georgia,'Times New Roman',serif;font-size:24px;line-height:1.3;color:#2a2722;">${escapeHtml(title)}</h1>
                    <p style="margin:0 0 22px;font-size:14px;line-height:1.7;color:#6b6459;">${greeting}</p>
                    ${bodyHtml}
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
                      You are receiving this email because of your recent activity at Taqwa (taqwactg.com).<br>
                      If you believe this was sent in error, please ignore it.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:20px 0 0;">
              <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:14px;letter-spacing:3px;color:#9a9184;text-transform:uppercase;">Taqwa</p>
              <p style="margin:6px 0 0;font-size:11px;letter-spacing:1.5px;color:#9a9184;text-transform:uppercase;">taqwactg.com</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = `${subject}

${greeting}

${bodyText}

Taqwa (taqwactg.com)`;

  return { subject, html, text };
}

module.exports = { buildEmail };
