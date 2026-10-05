'use strict';

let nodemailer = null;
try {
    nodemailer = require('nodemailer');
} catch (e) {
    console.warn('[Email] Warning: "nodemailer" package not found. Run "npm install" on the server to enable email delivery.');
}
const db = require('../db');
require('dotenv').config();

// ─── Settings Accessor ────────────────────────────────────────────────────────

function getEmailSettings() {
    try {
        const rows = db.prepare('SELECT key, value FROM email_settings').all();
        const settings = {};
        for (const row of rows) {
            settings[row.key] = row.value;
        }
        return {
            host: settings.smtp_host || process.env.SMTP_HOST || '',
            port: parseInt(settings.smtp_port || process.env.SMTP_PORT || '587', 10),
            secure: settings.smtp_secure !== undefined
                ? (settings.smtp_secure === 'true' || settings.smtp_secure === '1')
                : (process.env.SMTP_SECURE === 'true'),
            user: settings.smtp_user || process.env.SMTP_USER || '',
            pass: settings.smtp_pass !== undefined ? settings.smtp_pass : (process.env.SMTP_PASS || ''),
            from: settings.email_from || process.env.EMAIL_FROM || settings.smtp_user || process.env.SMTP_USER || 'noreply@olaslog.com',
            fromName: settings.email_from_name || process.env.EMAIL_FROM_NAME || 'Olaslog',
            appUrl: process.env.APP_URL || 'https://olaslog.com'
        };
    } catch (e) {
        return {
            host: process.env.SMTP_HOST || '',
            port: parseInt(process.env.SMTP_PORT || '587', 10),
            secure: process.env.SMTP_SECURE === 'true',
            user: process.env.SMTP_USER || '',
            pass: process.env.SMTP_PASS || '',
            from: process.env.EMAIL_FROM || process.env.SMTP_USER || 'noreply@olaslog.com',
            fromName: process.env.EMAIL_FROM_NAME || 'Olaslog',
            appUrl: process.env.APP_URL || 'https://olaslog.com'
        };
    }
}

function saveEmailSettings(settings) {
    const upsert = db.prepare(`
        INSERT INTO email_settings (key, value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `);

    const updateTx = db.transaction(() => {
        if (settings.smtp_host !== undefined) upsert.run('smtp_host', String(settings.smtp_host || '').trim());
        if (settings.smtp_port !== undefined) upsert.run('smtp_port', String(settings.smtp_port || '587').trim());
        if (settings.smtp_secure !== undefined) upsert.run('smtp_secure', settings.smtp_secure ? 'true' : 'false');
        if (settings.smtp_user !== undefined) upsert.run('smtp_user', String(settings.smtp_user || '').trim());
        if (settings.smtp_pass !== undefined && settings.smtp_pass !== '••••••••' && settings.smtp_pass !== '') {
            upsert.run('smtp_pass', String(settings.smtp_pass));
        }
        if (settings.email_from !== undefined) upsert.run('email_from', String(settings.email_from || '').trim());
        if (settings.email_from_name !== undefined) upsert.run('email_from_name', String(settings.email_from_name || '').trim());
    });

    updateTx();
    return getEmailSettings();
}

// ─── Templates Accessor ───────────────────────────────────────────────────────

function getTemplate(key) {
    try {
        const row = db.prepare('SELECT * FROM email_templates WHERE template_key = ?').get(key);
        if (row) {
            let extra = {};
            try { extra = JSON.parse(row.extra_data || '{}'); } catch (e) {}
            return {
                key: row.template_key,
                name: row.name,
                subject: row.subject,
                headline: row.headline,
                body: row.body,
                extra,
                updatedAt: row.updated_at
            };
        }
    } catch (e) {
        console.warn('[Email] Error reading template:', e.message);
    }
    return null;
}

function getAllTemplates() {
    try {
        const rows = db.prepare('SELECT * FROM email_templates ORDER BY template_key ASC').all();
        return rows.map(r => {
            let extra = {};
            try { extra = JSON.parse(r.extra_data || '{}'); } catch (e) {}
            return {
                key: r.template_key,
                name: r.name,
                subject: r.subject,
                headline: r.headline,
                body: r.body,
                extra,
                updatedAt: r.updated_at
            };
        });
    } catch (e) {
        return [];
    }
}

function saveTemplate(key, data) {
    const existing = db.prepare('SELECT * FROM email_templates WHERE template_key = ?').get(key);
    if (!existing) {
        throw new Error(`Template "${key}" does not exist`);
    }

    const subject = data.subject !== undefined ? String(data.subject).trim() : existing.subject;
    const headline = data.headline !== undefined ? String(data.headline).trim() : existing.headline;
    const body = data.body !== undefined ? String(data.body).trim() : existing.body;

    let extra = {};
    try { extra = JSON.parse(existing.extra_data || '{}'); } catch (e) {}
    if (data.extra && typeof data.extra === 'object') {
        extra = { ...extra, ...data.extra };
    }

    db.prepare(`
        UPDATE email_templates
        SET subject = ?, headline = ?, body = ?, extra_data = ?, updated_at = CURRENT_TIMESTAMP
        WHERE template_key = ?
    `).run(subject, headline, body, JSON.stringify(extra), key);

    return getTemplate(key);
}

const DEFAULT_TEMPLATES = {
    welcome: {
        name: 'Registration Successful (Welcome Email)',
        subject: 'Welcome to Olaslog, {first_name}! 🎉',
        headline: 'Welcome to Olaslog! 🎉',
        body: "Your account has been created successfully. You now have access to Nigeria's fastest digital accounts & subscriptions marketplace — Google Voice, TextPlus, VPN keys, and more, delivered instantly.",
        extra: {
            step1: 'Fund your wallet via your dedicated virtual bank account',
            step2: 'Browse our catalogue of verified digital products',
            step3: 'Checkout instantly — credentials delivered in seconds',
            buttonText: 'Go to My Wallet →',
            footerNote: 'If you did not create this account, you can safely ignore this email.'
        }
    },
    wallet_funded: {
        name: 'Wallet Funding Successful',
        subject: 'Your wallet has been credited with {amount} 💚',
        headline: 'Wallet Funded Successfully 💚',
        body: 'Your Olaslog wallet has been credited. You can now use your balance to purchase any digital product on our marketplace.',
        extra: {
            buttonText: 'Shop Now →',
            footerNote: "Didn't make this deposit? Contact our support team immediately."
        }
    },
    purchase: {
        name: 'Order Delivery & Credentials Confirmation',
        subject: 'Order {order_number} delivered — Your credentials are ready ✅',
        headline: 'Order Delivered! ✅',
        body: 'Your purchase was successful and your digital credentials are ready below. Please save them safely.',
        extra: {
            sectionTitle: '📦 Delivered Credentials',
            buttonText: 'View My Orders →',
            footerNote: 'Issue with your order? Open a dispute and our team will assist you within 24 hours.'
        }
    }
};

function resetTemplateToDefault(key) {
    const def = DEFAULT_TEMPLATES[key];
    if (!def) {
        throw new Error(`Unknown template key: ${key}`);
    }
    db.prepare(`
        INSERT INTO email_templates (template_key, name, subject, headline, body, extra_data, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(template_key) DO UPDATE SET
            name = excluded.name,
            subject = excluded.subject,
            headline = excluded.headline,
            body = excluded.body,
            extra_data = excluded.extra_data,
            updated_at = CURRENT_TIMESTAMP
    `).run(key, def.name, def.subject, def.headline, def.body, JSON.stringify(def.extra));

    return getTemplate(key);
}

// ─── Transport Factory ────────────────────────────────────────────────────────

function createTransport() {
    if (!nodemailer) {
        console.warn('[Email] nodemailer is not installed. Run "npm install" on the server.');
        return null;
    }
    const cfg = getEmailSettings();
    if (!cfg.host || !cfg.user || !cfg.pass) {
        return null;
    }
    return nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        auth: {
            user: cfg.user,
            pass: cfg.pass
        },
        tls: { rejectUnauthorized: false }
    });
}

// ─── Shared Layout ────────────────────────────────────────────────────────────

function layout(content, appUrl) {
    const url = appUrl || process.env.APP_URL || 'https://olaslog.com';
    const logoUrl = `${url}/assets/olaslog-logo-primary.png`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Olaslog</title>
</head>
<body style="margin:0;padding:0;background:#0f1117;font-family:'Segoe UI',Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f1117;padding:40px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#161b27;border-radius:16px;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,0.5);">

        <!-- Header with Logo -->
        <tr>
          <td style="background:linear-gradient(135deg,#1a2236 0%,#0f1117 100%);padding:32px 40px;border-bottom:1px solid rgba(99,211,138,0.15);">
            <img src="${logoUrl}" alt="Olaslog" width="140" style="display:block;height:auto;max-height:48px;"/>
          </td>
        </tr>

        <!-- Content Body -->
        <tr><td style="padding:40px 36px;">
          ${content}
        </td></tr>

        <!-- Footer -->
        <tr>
          <td style="background:#0f1117;padding:28px 36px;border-top:1px solid rgba(255,255,255,0.06);">
            <p style="margin:0 0 8px;font-size:12px;color:#6b7280;line-height:1.5;">
              Questions? Reply directly to this email or visit our support desk at
              <a href="${url}/#support" style="color:#63d38a;text-decoration:none;">${url}</a>
            </p>
            <p style="margin:0;font-size:11px;color:#4b5563;">
              © ${new Date().getFullYear()} Olaslog · Digital Accounts &amp; Subscriptions Marketplace ·
              <a href="${url}" style="color:#63d38a;text-decoration:none;">olaslog.com</a>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

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
    <table cellpadding="0" cellspacing="0" width="100%" style="margin:20px 0;background:#0f1117;border-radius:12px;border:1px solid rgba(99,211,138,0.2);">
      <tr>
        <td style="padding:20px 24px;">
          <p style="margin:0 0 4px;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;font-weight:600;">${label}</p>
          <p style="margin:0;font-size:28px;font-weight:800;color:#63d38a;">${value}</p>
        </td>
      </tr>
    </table>`;
}

function divider() {
    return `<hr style="border:none;border-top:1px solid rgba(255,255,255,0.06);margin:28px 0;"/>`;
}

function replaceTokens(text, tokens) {
    if (!text) return '';
    let result = text;
    for (const [key, val] of Object.entries(tokens)) {
        const regex = new RegExp(`\\{${key}\\}`, 'gi');
        result = result.replace(regex, val !== undefined && val !== null ? String(val) : '');
    }
    return result;
}

// ─── Template Builders ────────────────────────────────────────────────────────

function buildWelcomeEmail(user) {
    const cfg = getEmailSettings();
    const tpl = getTemplate('welcome') || DEFAULT_TEMPLATES.welcome;
    const extra = tpl.extra || {};

    const firstName = (user.fullName || 'there').trim().split(/\s+/)[0];
    const tokens = {
        first_name: firstName,
        full_name: user.fullName || 'Valued User',
        email: user.email || ''
    };

    const subject = replaceTokens(tpl.subject, tokens);
    const headline = replaceTokens(tpl.headline, tokens);
    const body = replaceTokens(tpl.body, tokens);
    const step1 = replaceTokens(extra.step1 || DEFAULT_TEMPLATES.welcome.extra.step1, tokens);
    const step2 = replaceTokens(extra.step2 || DEFAULT_TEMPLATES.welcome.extra.step2, tokens);
    const step3 = replaceTokens(extra.step3 || DEFAULT_TEMPLATES.welcome.extra.step3, tokens);
    const btnText = replaceTokens(extra.buttonText || DEFAULT_TEMPLATES.welcome.extra.buttonText, tokens);
    const footerNote = replaceTokens(extra.footerNote || DEFAULT_TEMPLATES.welcome.extra.footerNote, tokens);

    const steps = [step1, step2, step3].filter(Boolean);

    const stepsHtml = steps.length ? `
      ${divider()}
      <p style="margin:0 0 12px;font-size:14px;font-weight:600;color:#d1d5db;">🚀 Get started in 3 steps:</p>
      <table cellpadding="0" cellspacing="0" width="100%">
        ${steps.map((step, i) => `
        <tr>
          <td width="32" valign="top" style="padding:8px 12px 8px 0;">
            <span style="display:inline-block;width:28px;height:28px;line-height:28px;text-align:center;background:rgba(99,211,138,0.12);border-radius:50%;font-size:13px;font-weight:700;color:#63d38a;">${i + 1}</span>
          </td>
          <td style="padding:8px 0;font-size:14px;color:#9ca3af;line-height:1.6;">${step}</td>
        </tr>`).join('')}
      </table>
    ` : '';

    const content = `
      ${greeting(user.fullName)}
      <h1 style="margin:0 0 16px;font-size:24px;font-weight:800;color:#f9fafb;line-height:1.3;">
        ${headline}
      </h1>
      <p style="margin:0 0 16px;font-size:15px;color:#9ca3af;line-height:1.7;">
        ${body}
      </p>

      ${stepsHtml}

      ${primaryBtn(btnText, `${cfg.appUrl}/#wallet`)}

      ${footerNote ? `<p style="margin:0;font-size:13px;color:#6b7280;">${footerNote}</p>` : ''}
    `;

    return {
        subject,
        html: layout(content, cfg.appUrl)
    };
}

function buildWalletFundedEmail(user, { amount, newBalance, reference, channel }) {
    const cfg = getEmailSettings();
    const tpl = getTemplate('wallet_funded') || DEFAULT_TEMPLATES.wallet_funded;
    const extra = tpl.extra || {};

    const firstName = (user.fullName || 'there').trim().split(/\s+/)[0];
    const fmt = (n) => `₦${Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    const tokens = {
        first_name: firstName,
        full_name: user.fullName || 'Valued User',
        amount: fmt(amount),
        new_balance: fmt(newBalance),
        reference: reference || 'N/A'
    };

    const subject = replaceTokens(tpl.subject, tokens);
    const headline = replaceTokens(tpl.headline, tokens);
    const body = replaceTokens(tpl.body, tokens);
    const btnText = replaceTokens(extra.buttonText || DEFAULT_TEMPLATES.wallet_funded.extra.buttonText, tokens);
    const footerNote = replaceTokens(extra.footerNote || DEFAULT_TEMPLATES.wallet_funded.extra.footerNote, tokens);

    const channelLabel = channel === 'virtual_bank_account' ? 'Virtual Bank Account Transfer' : channel || 'Bank Transfer';

    const content = `
      ${greeting(user.fullName)}
      <h1 style="margin:0 0 16px;font-size:24px;font-weight:800;color:#f9fafb;line-height:1.3;">
        ${headline}
      </h1>
      <p style="margin:0 0 24px;font-size:15px;color:#9ca3af;line-height:1.7;">
        ${body}
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

      ${primaryBtn(btnText, `${cfg.appUrl}/#products`)}

      ${footerNote ? `<p style="margin:0;font-size:13px;color:#6b7280;">${footerNote}</p>` : ''}
    `;

    return {
        subject,
        html: layout(content, cfg.appUrl)
    };
}

function buildPurchaseEmail(user, { orderNumber, totalAmount, remainingBalance, items }) {
    const cfg = getEmailSettings();
    const tpl = getTemplate('purchase') || DEFAULT_TEMPLATES.purchase;
    const extra = tpl.extra || {};

    const firstName = (user.fullName || 'there').trim().split(/\s+/)[0];
    const fmt = (n) => `₦${Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    const tokens = {
        first_name: firstName,
        full_name: user.fullName || 'Valued User',
        order_number: orderNumber || 'N/A',
        total_amount: fmt(totalAmount),
        remaining_balance: fmt(remainingBalance)
    };

    const subject = replaceTokens(tpl.subject, tokens);
    const headline = replaceTokens(tpl.headline, tokens);
    const body = replaceTokens(tpl.body, tokens);
    const sectionTitle = replaceTokens(extra.sectionTitle || DEFAULT_TEMPLATES.purchase.extra.sectionTitle, tokens);
    const btnText = replaceTokens(extra.buttonText || DEFAULT_TEMPLATES.purchase.extra.buttonText, tokens);
    const footerNote = replaceTokens(extra.footerNote || DEFAULT_TEMPLATES.purchase.extra.footerNote, tokens);

    const itemRows = (items || []).map(item => `
      <tr>
        <td style="padding:14px 18px;font-size:13px;color:#d1d5db;border-bottom:1px solid rgba(255,255,255,0.04);">
          <div style="font-weight:700;color:#f9fafb;margin-bottom:4px;">${item.productName || 'Digital Product'}</div>
          ${item.credentialText ? `<div style="margin:6px 0;"><code style="display:inline-block;padding:6px 10px;background:rgba(0,0,0,0.4);border-radius:6px;border:1px solid rgba(99,211,138,0.25);font-size:12.5px;color:#63d38a;word-break:break-all;font-family:monospace;">${item.credentialText}</code></div>` : ''}
          ${item.publicData && item.publicData !== item.credentialText ? `<div style="font-size:11px;color:#6b7280;">${item.publicData}</div>` : ''}
        </td>
      </tr>
    `).join('');

    const content = `
      ${greeting(user.fullName)}
      <h1 style="margin:0 0 16px;font-size:24px;font-weight:800;color:#f9fafb;line-height:1.3;">
        ${headline}
      </h1>
      <p style="margin:0 0 24px;font-size:15px;color:#9ca3af;line-height:1.7;">
        ${body}
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

      <p style="margin:0 0 12px;font-size:14px;font-weight:700;color:#f9fafb;">${sectionTitle}</p>
      <table cellpadding="0" cellspacing="0" width="100%" style="background:#0f1117;border-radius:10px;border:1px solid rgba(255,255,255,0.06);overflow:hidden;">
        ${itemRows || `<tr><td style="padding:16px;font-size:13px;color:#6b7280;">No credentials to display.</td></tr>`}
      </table>

      ${primaryBtn(btnText, `${cfg.appUrl}/#orders`)}

      ${footerNote ? `<p style="margin:0;font-size:13px;color:#6b7280;">${footerNote}</p>` : ''}
    `;

    return {
        subject,
        html: layout(content, cfg.appUrl)
    };
}

// ─── Send Core ────────────────────────────────────────────────────────────────

async function sendMail({ to, subject, html }) {
    const cfg = getEmailSettings();
    if (!cfg.host || !cfg.user || !cfg.pass) {
        console.warn('[Email] SMTP not configured — skipping email to', to);
        return { skipped: true, reason: 'SMTP not configured' };
    }

    const transporter = createTransport();
    if (!transporter) {
        return { skipped: true, reason: 'Could not create SMTP transport' };
    }

    try {
        const info = await transporter.sendMail({
            from: `"${cfg.fromName}" <${cfg.from}>`,
            to,
            subject,
            html
        });
        console.log(`[Email] Sent "${subject}" to ${to} — messageId: ${info.messageId}`);
        return { success: true, messageId: info.messageId, to };
    } catch (err) {
        console.error(`[Email] Failed to send "${subject}" to ${to}:`, err.message);
        throw err;
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function sendWelcomeEmail(user) {
    try {
        const { subject, html } = buildWelcomeEmail(user);
        return await sendMail({ to: user.email, subject, html });
    } catch (err) {
        console.error('[Email] sendWelcomeEmail error:', err.message);
    }
}

async function sendWalletFundedEmail(user, details) {
    try {
        const { subject, html } = buildWalletFundedEmail(user, details);
        return await sendMail({ to: user.email, subject, html });
    } catch (err) {
        console.error('[Email] sendWalletFundedEmail error:', err.message);
    }
}

async function sendPurchaseEmail(user, details) {
    try {
        const { subject, html } = buildPurchaseEmail(user, details);
        return await sendMail({ to: user.email, subject, html });
    } catch (err) {
        console.error('[Email] sendPurchaseEmail error:', err.message);
    }
}

/**
 * Send a test email to verify SMTP and template appearance.
 * @param {string} templateKey - 'welcome' | 'wallet_funded' | 'purchase'
 * @param {string} recipientEmail
 */
async function sendTestEmail(templateKey, recipientEmail) {
    if (!recipientEmail || !recipientEmail.includes('@')) {
        throw new Error('A valid recipient email address is required for test send');
    }

    const cfg = getEmailSettings();
    if (!cfg.host || !cfg.user || !cfg.pass) {
        throw new Error('SMTP is not configured. Please save your SMTP Host, User, and Password first.');
    }

    const mockUser = {
        email: recipientEmail,
        fullName: 'Test Customer'
    };

    let emailData;
    if (templateKey === 'welcome') {
        emailData = buildWelcomeEmail(mockUser);
    } else if (templateKey === 'wallet_funded') {
        emailData = buildWalletFundedEmail(mockUser, {
            amount: 5000,
            newBalance: 12500,
            reference: 'TEST-WIAXY-' + Math.floor(100000 + Math.random() * 900000),
            channel: 'virtual_bank_account'
        });
    } else if (templateKey === 'purchase') {
        emailData = buildPurchaseEmail(mockUser, {
            orderNumber: 'ORD-TEST-' + Date.now(),
            totalAmount: 3500,
            remainingBalance: 9000,
            items: [
                {
                    productName: 'Google Voice US (Aged 2023)',
                    credentialText: 'olaslog_buyer@gmail.com:StrongPassword123:recovery@olaslog.com',
                    publicData: 'Account #10928'
                }
            ]
        });
    } else {
        throw new Error(`Unsupported template key: ${templateKey}`);
    }

    const transporter = createTransport();
    if (!transporter) {
        throw new Error('SMTP transport could not be initialized. Ensure nodemailer is installed ("npm install") and SMTP settings are saved.');
    }
    const info = await transporter.sendMail({
        from: `"${cfg.fromName}" <${cfg.from}>`,
        to: recipientEmail,
        subject: `[TEST] ${emailData.subject}`,
        html: emailData.html
    });

    return {
        success: true,
        messageId: info.messageId,
        to: recipientEmail,
        template: templateKey
    };
}

module.exports = {
    getEmailSettings,
    saveEmailSettings,
    getTemplate,
    getAllTemplates,
    saveTemplate,
    resetTemplateToDefault,
    buildWelcomeEmail,
    buildWalletFundedEmail,
    buildPurchaseEmail,
    sendWelcomeEmail,
    sendWalletFundedEmail,
    sendPurchaseEmail,
    sendTestEmail
};
