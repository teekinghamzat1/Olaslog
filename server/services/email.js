'use strict';

const nodemailer = require('nodemailer');
require('dotenv').config();

// ─── Transport ───────────────────────────────────────────────────────────────

function createTransport() {
    return nodemailer.createTransport({
        host:   process.env.SMTP_HOST,
        port:   parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_SECURE === 'true', // true = 465, false = STARTTLS
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        },
        tls: { rejectUnauthorized: false }
    });
}

const FROM_NAME    = process.env.EMAIL_FROM_NAME  || 'Olaslog';
const FROM_ADDRESS = process.env.EMAIL_FROM       || process.env.SMTP_USER;
const APP_URL      = process.env.APP_URL          || 'https://olaslog.com';
const LOGO_URL     = `${APP_URL}/assets/olaslog-logo-primary.png`;

// ─── Shared layout ───────────────────────────────────────────────────────────

function layout(content) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Olaslog</title>
</head>
<body style="margin:0;padding:0;background:#0f1117;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f1117;padding:40px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#161b27;border-radius:16px;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,0.5);">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#1a2236 0%,#0f1117 100%);padding:32px 40px;border-bottom:1px solid rgba(99,211,138,0.15);">
            <img src="${LOGO_URL}" alt="Olaslog" width="140" style="display:block;"/>
          </td>
        </tr>

        <!-- Body -->
        <tr><td style="padding:40px;">
          ${content}
        </td></tr>

        <!-- Footer -->
        <tr>
          <td style="background:#0f1117;padding:28px 40px;border-top:1px solid rgba(255,255,255,0.06);">
            <p style="margin:0 0 8px;font-size:12px;color:#6b7280;">
              Questions? Reply to this email or visit
              <a href="${APP_URL}/support" style="color:#63d38a;text-decoration:none;">${APP_URL}/support</a>
            </p>
            <p style="margin:0;font-size:11px;color:#374151;">
              © ${new Date().getFullYear()} Olaslog · Digital Accounts &amp; Subscriptions Marketplace ·
              <a href="${APP_URL}" style="color:#63d38a;text-decoration:none;">olaslog.com</a>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function greeting(name) {
    const first = (name || 'there').trim().split(/\s+/)[0];
    return `<p style="margin:0 0 20px;font-size:16px;color:#d1d5db;">Hi <strong style="color:#f9fafb;">${first}</strong>,</p>`;
}

function primaryBtn(label, url) {
    return `
    <table cellpadding="0" cellspacing="0" style="margin:28px 0;">
      <tr>
        <td style="background:linear-gradient(135deg,#63d38a,#3fbf6a);border-radius:10px;">
          <a href="${url}" style="display:block;padding:14px 32px;font-size:15px;font-weight:700;color:#0f1117;text-decoration:none;letter-spacing:0.3px;">${label}</a>
        </td>
      </tr>
    </table>`;
}

function amountBadge(label, value) {
    return `
    <table cellpadding="0" cellspacing="0" width="100%" style="margin:20px 0;background:#0f1117;border-radius:12px;border:1px solid rgba(99,211,138,0.15);">
      <tr>
        <td style="padding:20px 24px;">
          <p style="margin:0 0 4px;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;">${label}</p>
          <p style="margin:0;font-size:28px;font-weight:800;color:#63d38a;">${value}</p>
        </td>
      </tr>
    </table>`;
}

function divider() {
    return `<hr style="border:none;border-top:1px solid rgba(255,255,255,0.06);margin:28px 0;"/>`;
}

// ─── Template: Welcome ────────────────────────────────────────────────────────

function welcomeTemplate(user) {
    return layout(`
      ${greeting(user.fullName)}
      <h1 style="margin:0 0 16px;font-size:24px;font-weight:800;color:#f9fafb;line-height:1.3;">
        Welcome to Olaslog! 🎉
      </h1>
      <p style="margin:0 0 16px;font-size:15px;color:#9ca3af;line-height:1.7;">
        Your account has been created successfully. You now have access to Nigeria's fastest digital accounts &amp; subscriptions marketplace — Google Voice, TextPlus, VPN keys, and more, delivered instantly.
      </p>

      ${divider()}

      <p style="margin:0 0 12px;font-size:14px;font-weight:600;color:#d1d5db;">🚀 Get started in 3 steps:</p>
      <table cellpadding="0" cellspacing="0" width="100%">
        ${['Fund your wallet via your dedicated virtual bank account', 'Browse our catalogue of verified digital products', 'Checkout instantly — credentials delivered in seconds'].map((step, i) => `
        <tr>
          <td width="32" valign="top" style="padding:8px 12px 8px 0;">
            <span style="display:inline-block;width:28px;height:28px;line-height:28px;text-align:center;background:rgba(99,211,138,0.12);border-radius:50%;font-size:13px;font-weight:700;color:#63d38a;">${i + 1}</span>
          </td>
          <td style="padding:8px 0;font-size:14px;color:#9ca3af;line-height:1.6;">${step}</td>
        </tr>`).join('')}
      </table>

      ${primaryBtn('Go to My Wallet →', `${APP_URL}/#wallet`)}

      <p style="margin:0;font-size:13px;color:#6b7280;">
        If you did not create this account, you can safely ignore this email.
      </p>
    `);
}

// ─── Template: Wallet Funded ──────────────────────────────────────────────────

function walletFundedTemplate(user, { amount, newBalance, reference, channel }) {
    const fmt = (n) => `₦${Number(n).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const channelLabel = channel === 'virtual_bank_account' ? 'Virtual Bank Account Transfer' : channel || 'Bank Transfer';

    return layout(`
      ${greeting(user.fullName)}
      <h1 style="margin:0 0 16px;font-size:24px;font-weight:800;color:#f9fafb;line-height:1.3;">
        Wallet Funded Successfully 💚
      </h1>
      <p style="margin:0 0 24px;font-size:15px;color:#9ca3af;line-height:1.7;">
        Your Olaslog wallet has been credited. You can now use your balance to purchase any digital product on our marketplace.
      </p>

      ${amountBadge('Amount Credited', fmt(amount))}

      <table cellpadding="0" cellspacing="0" width="100%" style="margin:16px 0;">
        ${[
            ['New Balance', fmt(newBalance)],
            ['Payment Method', channelLabel],
            ['Reference', reference || 'N/A'],
            ['Date', new Date().toLocaleString('en-NG', { dateStyle: 'long', timeStyle: 'short' })]
        ].map(([label, value]) => `
        <tr>
          <td style="padding:10px 0;font-size:13px;color:#6b7280;border-bottom:1px solid rgba(255,255,255,0.04);">${label}</td>
          <td style="padding:10px 0;font-size:13px;color:#d1d5db;text-align:right;border-bottom:1px solid rgba(255,255,255,0.04);font-weight:600;">${value}</td>
        </tr>`).join('')}
      </table>

      ${primaryBtn('Shop Now →', `${APP_URL}/#products`)}

      <p style="margin:0;font-size:13px;color:#6b7280;">
        Didn't make this deposit? <a href="${APP_URL}/support" style="color:#63d38a;">Contact our support team</a> immediately.
      </p>
    `);
}

// ─── Template: Purchase Confirmation ─────────────────────────────────────────

function purchaseTemplate(user, { orderNumber, totalAmount, remainingBalance, items }) {
    const fmt = (n) => `₦${Number(n).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    const itemRows = (items || []).map(item => `
      <tr>
        <td style="padding:12px 16px;font-size:13px;color:#d1d5db;border-bottom:1px solid rgba(255,255,255,0.04);">
          <strong style="color:#f9fafb;">${item.productName || 'Digital Product'}</strong>
          ${item.credentialText ? `<br/><code style="font-size:12px;color:#63d38a;word-break:break-all;font-family:monospace;">${item.credentialText}</code>` : ''}
          ${item.publicData && item.publicData !== item.credentialText ? `<br/><span style="font-size:11px;color:#6b7280;">${item.publicData}</span>` : ''}
        </td>
      </tr>
    `).join('');

    return layout(`
      ${greeting(user.fullName)}
      <h1 style="margin:0 0 16px;font-size:24px;font-weight:800;color:#f9fafb;line-height:1.3;">
        Order Delivered! ✅
      </h1>
      <p style="margin:0 0 24px;font-size:15px;color:#9ca3af;line-height:1.7;">
        Your purchase was successful and your digital credentials are ready below. Please save them safely.
      </p>

      ${amountBadge('Total Charged', fmt(totalAmount))}

      <table cellpadding="0" cellspacing="0" width="100%" style="margin:16px 0;">
        ${[
            ['Order Number', orderNumber],
            ['Remaining Balance', fmt(remainingBalance)],
            ['Date', new Date().toLocaleString('en-NG', { dateStyle: 'long', timeStyle: 'short' })]
        ].map(([label, value]) => `
        <tr>
          <td style="padding:10px 0;font-size:13px;color:#6b7280;border-bottom:1px solid rgba(255,255,255,0.04);">${label}</td>
          <td style="padding:10px 0;font-size:13px;color:#d1d5db;text-align:right;border-bottom:1px solid rgba(255,255,255,0.04);font-weight:600;">${value}</td>
        </tr>`).join('')}
      </table>

      ${divider()}

      <p style="margin:0 0 12px;font-size:14px;font-weight:700;color:#f9fafb;">📦 Delivered Credentials</p>
      <table cellpadding="0" cellspacing="0" width="100%" style="background:#0f1117;border-radius:10px;border:1px solid rgba(255,255,255,0.06);overflow:hidden;">
        ${itemRows || `<tr><td style="padding:16px;font-size:13px;color:#6b7280;">No credentials to display.</td></tr>`}
      </table>

      ${primaryBtn('View My Orders →', `${APP_URL}/#orders`)}

      <p style="margin:0;font-size:13px;color:#6b7280;">
        Issue with your order? <a href="${APP_URL}/support" style="color:#63d38a;">Open a dispute</a> and our team will assist you within 24 hours.
      </p>
    `);
}

// ─── Send helpers ─────────────────────────────────────────────────────────────

async function sendMail({ to, subject, html }) {
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
        console.warn('[Email] SMTP not configured — skipping email to', to);
        return;
    }
    try {
        const transporter = createTransport();
        const info = await transporter.sendMail({
            from: `"${FROM_NAME}" <${FROM_ADDRESS}>`,
            to,
            subject,
            html
        });
        console.log(`[Email] Sent "${subject}" to ${to} — messageId: ${info.messageId}`);
        return info;
    } catch (err) {
        // Never crash the caller — email is non-critical
        console.error(`[Email] Failed to send "${subject}" to ${to}:`, err.message);
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send welcome email after successful registration.
 * @param {{ email: string, fullName: string }} user
 */
async function sendWelcomeEmail(user) {
    return sendMail({
        to: user.email,
        subject: `Welcome to Olaslog, ${user.fullName?.split(' ')[0] || 'there'}! 🎉`,
        html: welcomeTemplate(user)
    });
}

/**
 * Send wallet funded confirmation email.
 * @param {{ email: string, fullName: string }} user
 * @param {{ amount: number, newBalance: number, reference: string, channel: string }} details
 */
async function sendWalletFundedEmail(user, details) {
    const fmt = (n) => `₦${Number(n).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;
    return sendMail({
        to: user.email,
        subject: `Your wallet has been credited with ${fmt(details.amount)} 💚`,
        html: walletFundedTemplate(user, details)
    });
}

/**
 * Send purchase confirmation email with delivered credentials.
 * @param {{ email: string, fullName: string }} user
 * @param {{ orderNumber: string, totalAmount: number, remainingBalance: number, items: Array }} details
 */
async function sendPurchaseEmail(user, details) {
    return sendMail({
        to: user.email,
        subject: `Order ${details.orderNumber} delivered — Your credentials are ready ✅`,
        html: purchaseTemplate(user, details)
    });
}

module.exports = {
    sendWelcomeEmail,
    sendWalletFundedEmail,
    sendPurchaseEmail
};
