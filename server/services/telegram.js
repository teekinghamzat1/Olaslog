'use strict';

/**
 * Telegram Notification Service
 * Sends real-time alerts to the admin's Telegram chat via Bot API.
 *
 * Required .env variables:
 *   TELEGRAM_BOT_TOKEN  — token from @BotFather
 *   TELEGRAM_CHAT_ID    — your personal/group chat id
 */

const https = require('https');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// ─── Core sender ──────────────────────────────────────────────────────────────

/**
 * Send a Telegram message using MarkdownV2 parse mode.
 * Returns a Promise — always resolves (never throws) so callers can fire-and-forget.
 */
function send(text) {
    return new Promise((resolve) => {
        if (!BOT_TOKEN || !CHAT_ID) {
            // Telegram not configured — silently skip
            return resolve({ ok: false, reason: 'not_configured' });
        }

        const body = JSON.stringify({
            chat_id:    CHAT_ID,
            text:       text,
            parse_mode: 'HTML',
            disable_web_page_preview: true
        });

        const options = {
            hostname: 'api.telegram.org',
            path:     `/bot${BOT_TOKEN}/sendMessage`,
            method:   'POST',
            headers: {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (!parsed.ok) {
                        console.warn('[Telegram] API error:', parsed.description);
                    }
                    resolve(parsed);
                } catch (_) {
                    resolve({ ok: false });
                }
            });
        });

        req.on('error', (err) => {
            console.warn('[Telegram] Request error:', err.message);
            resolve({ ok: false, reason: err.message });
        });

        req.setTimeout(8000, () => {
            req.destroy();
            resolve({ ok: false, reason: 'timeout' });
        });

        req.write(body);
        req.end();
    });
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function currency(amount) {
    return `₦${Number(amount).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;
}

function esc(text) {
    // Escape HTML special chars for Telegram HTML parse mode
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function now() {
    return new Date().toLocaleString('en-NG', {
        timeZone: 'Africa/Lagos',
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: true
    });
}

// ─── Notification Templates ───────────────────────────────────────────────────

/**
 * 👤 New user registered
 */
function notifyNewRegistration({ fullName, email, id }) {
    const msg =
        `👤 <b>New Registration</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `Name:  <b>${esc(fullName)}</b>\n` +
        `Email: <code>${esc(email)}</code>\n` +
        `ID:    #${id}\n` +
        `Time:  ${now()}\n` +
        `\n🟢 <i>Olaslog Marketplace</i>`;
    return send(msg).catch(() => {});
}

/**
 * 💰 Wallet funded
 */
function notifyWalletFunded({ fullName, email, userId, amount, newBalance, reference }) {
    const msg =
        `💰 <b>Wallet Funded</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `User:      <b>${esc(fullName)}</b> (${esc(email)})\n` +
        `Amount:    <b>${currency(amount)}</b>\n` +
        `Balance:   ${currency(newBalance)}\n` +
        `Ref:       <code>${esc(reference || 'N/A')}</code>\n` +
        `User ID:   #${userId}\n` +
        `Time:      ${now()}\n` +
        `\n🟢 <i>Olaslog Marketplace</i>`;
    return send(msg).catch(() => {});
}

/**
 * 🛒 New order placed
 */
function notifyNewOrder({ fullName, email, userId, orderNumber, totalAmount, itemCount, orderId }) {
    const msg =
        `🛒 <b>New Order</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `Order:   <b>#${esc(orderNumber)}</b>\n` +
        `User:    <b>${esc(fullName)}</b> (${esc(email)})\n` +
        `Total:   <b>${currency(totalAmount)}</b>\n` +
        `Items:   ${itemCount}\n` +
        `User ID: #${userId}\n` +
        `Time:    ${now()}\n` +
        `\n🟢 <i>Olaslog Marketplace</i>`;
    return send(msg).catch(() => {});
}

/**
 * ⚠️ Dispute filed
 */
function notifyDispute({ fullName, email, userId, orderNumber, orderId, reason }) {
    const shortReason = String(reason || '').slice(0, 200);
    const msg =
        `⚠️ <b>Dispute Filed</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `Order:   <b>#${esc(orderNumber)}</b>\n` +
        `User:    <b>${esc(fullName)}</b> (${esc(email)})\n` +
        `Reason:  <i>${esc(shortReason)}</i>\n` +
        `User ID: #${userId}\n` +
        `Time:    ${now()}\n` +
        `\n🔴 <i>Olaslog Marketplace — Action Required</i>`;
    return send(msg).catch(() => {});
}

/**
 * 📦 Low stock alert
 */
function notifyLowStock({ productName, productId, remaining }) {
    const msg =
        `📦 <b>Low Stock Alert</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `Product: <b>${esc(productName)}</b>\n` +
        `ID:      #${productId}\n` +
        `Left:    <b>${remaining} unit${remaining === 1 ? '' : 's'}</b>\n` +
        `Time:    ${now()}\n` +
        `\n🟠 <i>Olaslog Marketplace — Restock Soon</i>`;
    return send(msg).catch(() => {});
}

/**
 * 🧪 Test ping (used from admin panel)
 */
function sendTestMessage() {
    const msg =
        `🧪 <b>Telegram Test</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `✅ Your Telegram notifications are working!\n` +
        `Time: ${now()}\n` +
        `\n🟢 <i>Olaslog Marketplace</i>`;
    return send(msg);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    notifyNewRegistration,
    notifyWalletFunded,
    notifyNewOrder,
    notifyDispute,
    notifyLowStock,
    sendTestMessage,
    isConfigured: () => Boolean(BOT_TOKEN && CHAT_ID)
};
