'use strict';

const https = require('https');
const db = require('../db');
const { getWalletBalance } = require('./wallet');
const billstack = require('./billstack');
const telegramAuth = require('./telegramAuth');
const phoneVerify = require('./phoneVerify');
// NOTE: order.js is required lazily inside handleBuyExecute to avoid circular dependency
// (order.js also requires telegramBot for DM delivery notifications)

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const APP_URL   = (process.env.APP_URL || 'https://olaslog.com').replace(/\/+$/, '');

let isPolling = false;
let lastUpdateId = 0;

// In-memory cart: { [chatId]: { productId, productName, price, qty } }
const pendingOrders = new Map();

// ─── Telegram API ──────────────────────────────────────────────────────────────

function apiCall(method, body = {}) {
    return new Promise((resolve) => {
        if (!BOT_TOKEN) {
            return resolve({ ok: false, error: 'Telegram BOT_TOKEN not configured' });
        }

        const payload = JSON.stringify(body);
        const options = {
            hostname: 'api.telegram.org',
            path: `/bot${BOT_TOKEN}/${method}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { resolve({ ok: false, error: 'Invalid JSON from Telegram' }); }
            });
        });

        req.on('error', (err) => resolve({ ok: false, error: err.message }));
        req.setTimeout(35000, () => { req.destroy(); resolve({ ok: false, error: 'Timeout' }); });
        req.write(payload);
        req.end();
    });
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function esc(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function currency(amount) {
    return `₦${Number(amount || 0).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;
}

async function sendMessage(chatId, text, options = {}) {
    return apiCall('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...options
    });
}

async function editMessage(chatId, messageId, text, options = {}) {
    return apiCall('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...options
    });
}

function resolveUser(from) {
    if (!from || !from.id) return null;
    return telegramAuth.findOrCreateTelegramUser(from);
}

// ─── /start ────────────────────────────────────────────────────────────────────

// Persistent reply keyboard — always visible below the text input
const MAIN_REPLY_KEYBOARD = {
    keyboard: [
        [{ text: '🛍️ Browse Products' }, { text: '💰 My Balance' }],
        [{ text: '💳 Fund Wallet' },      { text: '⚡ SMS Verify' }],
        [{ text: '📦 My Orders' },        { text: '❓ Help & Support' }]
    ],
    resize_keyboard: true,
    persistent: true,
    input_field_placeholder: 'Choose an option or type a command…'
};

async function handleStart(msg) {
    const { from } = msg;
    const user = resolveUser(from);
    const firstName = from.first_name || 'there';

    const welcomeText =
        `👋 <b>Welcome to Olaslog, ${esc(firstName)}!</b>\n\n` +
        `Nigeria's fastest digital products marketplace.\n` +
        `Get verified accounts, streaming, VPNs & software delivered <b>instantly</b> — right here in Telegram.\n\n` +
        `📱 <b>New:</b> US SMS Verification — receive OTP codes for WhatsApp, Google, ChatGPT, TikTok & 500+ services, paid from your wallet!\n\n` +
        `🛒 <b>Tap the buttons below to get started!</b>`;

    const inlineKeyboard = {
        inline_keyboard: [
            [{ text: '🛍️ Browse & Buy Products', callback_data: 'shop_home' }],
            [{ text: '⚡ SMS Verification Hub', callback_data: 'verify_home' }],
            [
                { text: '💰 Balance', callback_data: 'cmd_balance' },
                { text: '💳 Fund Wallet', callback_data: 'cmd_fund' }
            ],
            [
                { text: '📦 My Orders', callback_data: 'cmd_orders' },
                { text: '❓ Help', callback_data: 'cmd_help' }
            ],
            [{ text: '🌐 Open Mini App', web_app: { url: APP_URL } }]
        ]
    };

    // First, set the persistent reply keyboard so buttons appear below the input field
    await sendMessage(
        msg.chat.id,
        `✅ Keyboard activated! Use the buttons at the bottom or tap the options below.`,
        { reply_markup: MAIN_REPLY_KEYBOARD }
    );

    // Then send the rich welcome card with inline buttons
    await sendMessage(msg.chat.id, welcomeText, { reply_markup: inlineKeyboard });
}

// ─── /balance ──────────────────────────────────────────────────────────────────

async function handleBalance(chatId, from, messageId = null) {
    const user = resolveUser(from);
    if (!user) {
        return sendMessage(chatId, `⚠️ Could not locate your account. Type /start to initialize.`);
    }

    const bal = getWalletBalance(user.id);

    const text =
        `💰 <b>Your Olaslog Wallet</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `Balance:      <b>${currency(bal)}</b>\n` +
        `Account Name: <b>${esc(user.full_name)}</b>\n` +
        `User ID:      #${user.id}\n\n` +
        `Need to top up? Tap <b>Fund Wallet</b> below.`;

    const keyboard = {
        inline_keyboard: [
            [
                { text: '🛍️ Shop Now', callback_data: 'shop_home' },
                { text: '💳 Fund Wallet', callback_data: 'cmd_fund' }
            ]
        ]
    };

    if (messageId) {
        return editMessage(chatId, messageId, text, { reply_markup: keyboard });
    }
    return sendMessage(chatId, text, { reply_markup: keyboard });
}

// ─── /fund ─────────────────────────────────────────────────────────────────────

async function handleFund(chatId, from, messageId = null) {
    const user = resolveUser(from);
    if (!user) {
        return sendMessage(chatId, `⚠️ Could not locate your account. Type /start to initialize.`);
    }

    let va = billstack.getVirtualAccount(user.id);
    if (!va) {
        try { va = await billstack.createVirtualAccount(user, '9PSB'); } catch (e) { /* ignore */ }
    }

    let text, keyboard;

    if (va && va.account_number) {
        text =
            `💳 <b>Instant Wallet Top-Up</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n` +
            `Transfer from <b>any Nigerian bank app</b> to:\n\n` +
            `🏦 Bank: <b>${esc(va.bank_name || '9PSB')}</b>\n` +
            `🔢 Account: <code>${esc(va.account_number)}</code>\n` +
            `👤 Name: <b>${esc(va.account_name)}</b>\n\n` +
            `⚡ <i>Wallet credited automatically within 10 seconds!</i>`;

        keyboard = {
            inline_keyboard: [
                [
                    { text: '🔄 Check Balance', callback_data: 'cmd_balance' },
                    { text: '🛍️ Shop Now', callback_data: 'shop_home' }
                ]
            ]
        };
    } else {
        text =
            `💳 <b>Fund Your Wallet</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n` +
            `Open the Mini App to generate your dedicated bank account.`;
        keyboard = {
            inline_keyboard: [[{ text: '⚡ Fund in Mini App', web_app: { url: `${APP_URL}/#wallet` } }]]
        };
    }

    if (messageId) {
        return editMessage(chatId, messageId, text, { reply_markup: keyboard });
    }
    return sendMessage(chatId, text, { reply_markup: keyboard });
}

// ─── /orders ───────────────────────────────────────────────────────────────────

async function handleOrders(chatId, from, messageId = null) {
    const user = resolveUser(from);
    if (!user) {
        return sendMessage(chatId, `⚠️ Could not locate your account. Type /start to initialize.`);
    }

    const recentOrders = db.prepare(`
        SELECT id, order_number, total_amount, status, created_at
        FROM orders
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT 5
    `).all(user.id);

    let text, keyboard;

    if (!recentOrders || recentOrders.length === 0) {
        text =
            `📦 <b>Your Order History</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n` +
            `You haven't placed any orders yet!\n\n` +
            `Tap below to browse our catalog:`;
        keyboard = { inline_keyboard: [[{ text: '🛍️ Browse Products', callback_data: 'shop_home' }]] };
    } else {
        text = `📦 <b>Recent Orders (Last 5)</b>\n━━━━━━━━━━━━━━━━━━━━━\n`;
        for (const ord of recentOrders) {
            const d = new Date(ord.created_at).toLocaleDateString('en-NG', {
                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
            });
            text += `• <b>#${esc(ord.order_number)}</b> — ${currency(ord.total_amount)} <i>(${esc(ord.status.toUpperCase())})</i>\n  <i>${d}</i>\n`;
        }
        text += `\nCredentials are delivered directly in this chat.`;
        keyboard = {
            inline_keyboard: [[
                { text: '🛍️ Shop Again', callback_data: 'shop_home' },
                { text: '📱 View in Mini App', web_app: { url: `${APP_URL}/#orders` } }
            ]]
        };
    }

    if (messageId) {
        return editMessage(chatId, messageId, text, { reply_markup: keyboard });
    }
    return sendMessage(chatId, text, { reply_markup: keyboard });
}

// ─── /help ─────────────────────────────────────────────────────────────────────

async function handleHelp(chatId, messageId = null) {
    const text =
        `❓ <b>Olaslog Help & Support</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `• <b>How to buy?</b>\n` +
        `  Tap <b>Browse Products</b> → choose a category → pick a product → confirm purchase. Done!\n\n` +
        `• <b>How to fund my wallet?</b>\n` +
        `  Type /fund to get your personal 9PSB account. Transfer reflects in seconds.\n\n` +
        `• <b>Where are my credentials?</b>\n` +
        `  Delivered instantly in <b>this chat</b> and saved under /orders.\n\n` +
        `💬 Need 1-on-1 help? Reach us at: @olaslogsupport`;

    const keyboard = {
        inline_keyboard: [
            [
                { text: '🛍️ Browse Products', callback_data: 'shop_home' },
                { text: '💬 Contact Support', url: 'https://t.me/olaslogsupport' }
            ]
        ]
    };

    if (messageId) {
        return editMessage(chatId, messageId, text, { reply_markup: keyboard });
    }
    return sendMessage(chatId, text, { reply_markup: keyboard });
}

// ─── VERIFICATION: Home — Popular Services Grid ─────────────────────────────────

async function handleVerifyHome(chatId, from, messageId = null) {
    const user = resolveUser(from);
    const bal = user ? getWalletBalance(user.id) : 0;

    let services;
    try {
        services = await phoneVerify.listServices();
    } catch (e) {
        const errText = `⚠️ <b>Verification Unavailable</b>\n\nCould not load services right now. Please try again shortly.`;
        if (messageId) return editMessage(chatId, messageId, errText);
        return sendMessage(chatId, errText);
    }

    // Show top-12 popular services
    const popular = services.filter(s => s.popular).slice(0, 12);
    const displayList = popular.length > 0 ? popular : services.slice(0, 12);

    const text =
        `⚡ <b>US SMS Verification Hub</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `Receive instant US OTP codes for 500+ services.\n` +
        `Deducted from wallet • 100% refund if no SMS!\n\n` +
        `💰 Your Balance: <b>${currency(bal)}</b>\n\n` +
        `Tap a service to view price and request a number:`;

    // Build 2-column grid of popular services
    const rows = [];
    for (let i = 0; i < displayList.length; i += 2) {
        const row = [];
        const sA = displayList[i];
        row.push({ text: `${sA.icon} ${sA.name} — ${sA.priceFormatted}`, callback_data: `verify_svc_${sA.name}` });
        if (displayList[i + 1]) {
            const sB = displayList[i + 1];
            row.push({ text: `${sB.icon} ${sB.name} — ${sB.priceFormatted}`, callback_data: `verify_svc_${sB.name}` });
        }
        rows.push(row);
    }

    rows.push([{ text: '🔍 Browse All 500+ Services', callback_data: 'verify_browse' }]);
    rows.push([
        { text: '📜 My Verifications', callback_data: 'verify_history' },
        { text: '💳 Fund Wallet', callback_data: 'cmd_fund' }
    ]);
    rows.push([{ text: '← Main Menu', callback_data: 'main_menu' }]);

    if (messageId) return editMessage(chatId, messageId, text, { reply_markup: { inline_keyboard: rows } });
    return sendMessage(chatId, text, { reply_markup: { inline_keyboard: rows } });
}

// ─── VERIFICATION: Browse All Services (paginated A-Z) ──────────────────────────

async function handleVerifyBrowse(chatId, from, page = 0, messageId = null) {
    let services;
    try {
        services = await phoneVerify.listServices();
    } catch (e) {
        return sendMessage(chatId, `⚠️ Could not load services. Please try again.`);
    }

    const PAGE_SIZE = 10;
    const start = page * PAGE_SIZE;
    const pageItems = services.slice(start, start + PAGE_SIZE);
    const totalPages = Math.ceil(services.length / PAGE_SIZE);

    const text =
        `📱 <b>All Verification Services</b> (Page ${page + 1}/${totalPages})\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `Tap any service to select it:`;

    const rows = pageItems.map(s => ([{
        text: `${s.icon} ${s.name} — ${s.priceFormatted} ${s.available ? '✅' : '⏳'}`,
        callback_data: `verify_svc_${s.name}`
    }]));

    const navRow = [];
    if (page > 0) navRow.push({ text: '◀ Prev', callback_data: `verify_page_${page - 1}` });
    if (page < totalPages - 1) navRow.push({ text: 'Next ▶', callback_data: `verify_page_${page + 1}` });
    if (navRow.length > 0) rows.push(navRow);
    rows.push([{ text: '← Back to Hub', callback_data: 'verify_home' }]);

    if (messageId) return editMessage(chatId, messageId, text, { reply_markup: { inline_keyboard: rows } });
    return sendMessage(chatId, text, { reply_markup: { inline_keyboard: rows } });
}

// ─── VERIFICATION: Service Detail + Buy Button ───────────────────────────────────

async function handleVerifyService(chatId, from, serviceName, messageId = null) {
    const user = resolveUser(from);
    const bal = user ? getWalletBalance(user.id) : 0;

    let services;
    try {
        services = await phoneVerify.listServices();
    } catch (e) {
        return sendMessage(chatId, `⚠️ Could not load service info. Please try again.`);
    }

    const svc = services.find(s => s.name.toLowerCase() === serviceName.toLowerCase());
    if (!svc) {
        return sendMessage(chatId, `⚠️ Service "${esc(serviceName)}" not found.`);
    }

    const canAfford = bal >= svc.priceNgn;
    const shortfall = svc.priceNgn - bal;

    const text =
        `${svc.icon} <b>${esc(svc.name)} Verification</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `${svc.desc ? esc(svc.desc) + '\n\n' : ''}` +
        `💵 Cost:         <b>${svc.priceFormatted}</b>\n` +
        `🇺🇸 Country:     <b>United States (+1)</b>\n` +
        `⏱️ Window:       <b>15 Minutes</b>\n` +
        `📶 Availability: <b>${svc.available ? `✅ In Stock (${svc.availableCount} numbers)` : '⚠️ Limited — may retry'}</b>\n\n` +
        `💰 Your Balance: <b>${currency(bal)}</b>\n` +
        (canAfford
            ? `✅ You can afford this. Tap below to request a number!`
            : `⚠️ You need <b>${currency(shortfall)}</b> more. Fund your wallet first.`) +
        `\n\n🛡️ <i>100% automatic wallet refund if no SMS arrives within 15 min.</i>`;

    const rows = [];
    if (canAfford) {
        rows.push([{ text: `⚡ Request Number — ${svc.priceFormatted}`, callback_data: `verify_buy_${svc.name}` }]);
    } else {
        rows.push([{ text: `💳 Fund Wallet (Need ${currency(shortfall)} more)`, callback_data: 'cmd_fund' }]);
    }
    rows.push([
        { text: '← Back to Hub', callback_data: 'verify_home' },
        { text: '📜 History', callback_data: 'verify_history' }
    ]);

    if (messageId) return editMessage(chatId, messageId, text, { reply_markup: { inline_keyboard: rows } });
    return sendMessage(chatId, text, { reply_markup: { inline_keyboard: rows } });
}

// ─── VERIFICATION: Confirm Purchase ─────────────────────────────────────────────

async function handleVerifyBuy(chatId, from, serviceName, messageId = null) {
    const user = resolveUser(from);
    if (!user) {
        return sendMessage(chatId, `⚠️ Could not locate your account. Type /start to initialize.`);
    }

    const bal = getWalletBalance(user.id);
    let services;
    try {
        services = await phoneVerify.listServices();
    } catch (e) {
        return sendMessage(chatId, `⚠️ Could not load service. Please try again.`);
    }

    const svc = services.find(s => s.name.toLowerCase() === serviceName.toLowerCase());
    if (!svc) {
        return sendMessage(chatId, `⚠️ Service not found. Please try again from the hub.`);
    }

    if (bal < svc.priceNgn) {
        const shortfall = svc.priceNgn - bal;
        const text =
            `❌ <b>Insufficient Balance</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n` +
            `Service: <b>${esc(svc.name)}</b>\n` +
            `Cost:    <b>${svc.priceFormatted}</b>\n` +
            `Balance: <b>${currency(bal)}</b>\n` +
            `Needed:  <b>${currency(shortfall)}</b> more\n\n` +
            `Please fund your wallet and try again.`;
        const keyboard = { inline_keyboard: [
            [{ text: '💳 Fund Wallet Now', callback_data: 'cmd_fund' }],
            [{ text: '← Back', callback_data: `verify_svc_${svc.name}` }]
        ]};
        if (messageId) return editMessage(chatId, messageId, text, { reply_markup: keyboard });
        return sendMessage(chatId, text, { reply_markup: keyboard });
    }

    const balAfter = bal - svc.priceNgn;
    const text =
        `🔔 <b>Confirm Verification Order</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `Service:       <b>${svc.icon} ${esc(svc.name)}</b>\n` +
        `Cost:          <b>${svc.priceFormatted}</b>\n` +
        `Balance Now:   <b>${currency(bal)}</b>\n` +
        `Balance After: <b>${currency(balAfter)}</b>\n\n` +
        `A <b>US phone number</b> will be assigned to you instantly.\n` +
        `You'll receive the OTP code <b>right here in this chat</b> the moment it arrives!\n\n` +
        `🛡️ <i>100% refund if no SMS arrives within 15 min.</i>`;

    const keyboard = { inline_keyboard: [
        [{ text: `✅ Confirm & Pay ${svc.priceFormatted}`, callback_data: `verify_exec_${svc.name}` }],
        [{ text: '❌ Cancel', callback_data: `verify_svc_${svc.name}` }]
    ]};

    if (messageId) return editMessage(chatId, messageId, text, { reply_markup: keyboard });
    return sendMessage(chatId, text, { reply_markup: keyboard });
}

// ─── VERIFICATION: Execute Order ─────────────────────────────────────────────────

async function handleVerifyExecute(chatId, from, serviceName, messageId = null) {
    const user = resolveUser(from);
    if (!user) {
        return sendMessage(chatId, `⚠️ Could not locate your account. Type /start to initialize.`);
    }

    // Show processing state immediately
    const processingText = `⏳ <b>Requesting your US number...</b>\n\nPlease wait while we assign a dedicated US phone number for <b>${esc(serviceName)}</b>.`;
    let processingMsgId = messageId;
    if (messageId) {
        await editMessage(chatId, messageId, processingText, { reply_markup: { inline_keyboard: [] } });
    } else {
        const sent = await sendMessage(chatId, processingText);
        if (sent && sent.result) processingMsgId = sent.result.message_id;
    }

    try {
        const result = await phoneVerify.requestNumber({ userId: user.id, service: serviceName });

        // Update balance on user object for subsequent displays
        const newBal = result.newBalance;
        const phoneDisplay = result.formattedNumber || result.phoneNumber || 'Assigning…';
        const tillMin = Math.ceil((result.tillExpiration || 900) / 60);

        const successText = `✅ <b>Number Assigned!</b>
━━━━━━━━━━━━━━━━━━━━━
Service:      <b>${esc(serviceName)}</b>
📱 Your Number: <code>${esc(phoneDisplay)}</code>
💰 Cost Charged: <b>${result.costFormatted}</b>
⏳ Expires In:  <b>${tillMin} minutes</b>
New Balance:  <b>${currency(newBal)}</b>

<b>Next steps:</b>
1️⃣ Copy the number above (tap to copy)
2️⃣ Enter it in <b>${esc(serviceName)}</b> to receive your code
3️⃣ Your OTP will be sent <b>automatically to this chat</b> the moment it arrives!

🛡️ <i>Auto 100% refund if no SMS within ${tillMin} min.</i>`;

        const keyboard = { inline_keyboard: [
            [{ text: '🔄 Check for OTP', callback_data: `verify_status_${result.id}` }],
            [{ text: '❌ Cancel & Refund', callback_data: `verify_cancel_${result.id}` }],
            [{ text: '⚡ New Verification', callback_data: 'verify_home' }]
        ]};

        if (processingMsgId) {
            return editMessage(chatId, processingMsgId, successText, { reply_markup: keyboard });
        }
        return sendMessage(chatId, successText, { reply_markup: keyboard });

    } catch (err) {
        console.error('[Bot] Verification order error:', err.message);

        let errorText;
        if (err.code === 'INSUFFICIENT_FUNDS') {
            errorText = `❌ <b>Insufficient Balance</b>
━━━━━━━━━━━━━━━━━━━━━
You need <b>${currency(err.shortfall || 0)}</b> more.
Current balance: <b>${currency(err.currentBalance || 0)}</b>

Fund your wallet and try again.`;
        } else {
            errorText = `❌ <b>Request Failed</b>
━━━━━━━━━━━━━━━━━━━━━
${esc(err.message || 'No numbers available for this service right now.')}

Try another service or try again in a few minutes.`;
        }

        const keyboard = { inline_keyboard: [
            err.code === 'INSUFFICIENT_FUNDS'
                ? [{ text: '💳 Fund Wallet', callback_data: 'cmd_fund' }]
                : [{ text: '⚡ Try Another Service', callback_data: 'verify_home' }],
            [{ text: '← Back to Hub', callback_data: 'verify_home' }]
        ]};

        if (processingMsgId) {
            return editMessage(chatId, processingMsgId, errorText, { reply_markup: keyboard });
        }
        return sendMessage(chatId, errorText, { reply_markup: keyboard });
    }
}

// ─── VERIFICATION: Check / Refresh Status ───────────────────────────────────────

async function handleVerifyStatus(chatId, from, verificationId, messageId = null) {
    const user = resolveUser(from);
    if (!user) {
        return sendMessage(chatId, `⚠️ Could not locate your account. Type /start to initialize.`);
    }

    try {
        const v = await phoneVerify.getVerificationStatus(verificationId, user.id);
        const phone = v.formattedNumber || v.phoneNumber || 'N/A';
        const tillMin = v.remainingSeconds > 0 ? Math.ceil(v.remainingSeconds / 60) : 0;

        let statusLine, keyboard;

        if (v.status === 'completed' && v.otpCode) {
            statusLine =
                `🎉 <b>OTP Code Received!</b>\n\n` +
                `📱 Number: <code>${esc(phone)}</code>\n` +
                `🔑 OTP Code: <code>${esc(v.otpCode)}</code>\n` +
                `📨 Full SMS: <i>${esc(v.smsReply || 'N/A')}</i>\n\n` +
                `✅ Verification complete!`;
            keyboard = { inline_keyboard: [
                [{ text: '⚡ New Verification', callback_data: 'verify_home' }],
                [{ text: '📜 Verification History', callback_data: 'verify_history' }]
            ]};
        } else if (['refunded', 'timed_out'].includes(v.status)) {
            statusLine =
                `💸 <b>Verification Expired & Refunded</b>\n\n` +
                `📱 Number: <code>${esc(phone)}</code>\n` +
                `Status: <b>Timed Out — Full Refund Issued</b>\n\n` +
                `<i>Your ${esc(v.costFormatted || '')} has been returned to your wallet.</i>`;
            keyboard = { inline_keyboard: [
                [{ text: '⚡ Try Again', callback_data: 'verify_home' }]
            ]};
        } else if (v.status === 'rejected') {
            statusLine =
                `❌ <b>Verification Cancelled</b>\n\n` +
                `📱 Number: <code>${esc(phone)}</code>\n` +
                `Status: <b>Cancelled — Full Refund Issued</b>`;
            keyboard = { inline_keyboard: [
                [{ text: '⚡ Start New Verification', callback_data: 'verify_home' }]
            ]};
        } else {
            // Still active / waiting
            statusLine =
                `⏳ <b>Waiting for SMS...</b>\n\n` +
                `Service: <b>${esc(v.service)}</b>\n` +
                `📱 Number: <code>${esc(phone)}</code>\n` +
                `⏱️ Time Left: <b>${tillMin > 0 ? `${tillMin} min` : 'Expiring soon…'}</b>\n\n` +
                `1️⃣ Enter this number in <b>${esc(v.service)}</b>\n` +
                `2️⃣ Wait for the OTP — it'll appear here automatically!\n\n` +
                `<i>You'll receive a notification the moment your code arrives.</i>`;
            keyboard = { inline_keyboard: [
                [{ text: '🔄 Refresh Status', callback_data: `verify_status_${v.id}` }],
                [{ text: '❌ Cancel & Refund', callback_data: `verify_cancel_${v.id}` }]
            ]};
        }

        if (messageId) return editMessage(chatId, messageId, statusLine, { reply_markup: keyboard });
        return sendMessage(chatId, statusLine, { reply_markup: keyboard });

    } catch (e) {
        const errText = `⚠️ Could not fetch verification status: ${esc(e.message)}`;
        if (messageId) return editMessage(chatId, messageId, errText);
        return sendMessage(chatId, errText);
    }
}

// ─── VERIFICATION: Cancel & Refund ───────────────────────────────────────────────

async function handleVerifyCancel(chatId, from, verificationId, messageId = null) {
    const user = resolveUser(from);
    if (!user) {
        return sendMessage(chatId, `⚠️ Could not locate your account. Type /start to initialize.`);
    }

    // Show processing message
    const processingText = `⏳ <b>Processing cancellation & refund...</b>`;
    if (messageId) {
        await editMessage(chatId, messageId, processingText, { reply_markup: { inline_keyboard: [] } });
    }

    try {
        const result = await phoneVerify.cancelAndRefund(verificationId, user.id);

        const text =
            `✅ <b>Cancelled & Refunded!</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n` +
            `Your verification has been cancelled and <b>${result.refundedFormatted || result.refundAmount || 'full amount'}</b> has been credited back to your wallet.\n\n` +
            `New Balance: <b>${currency(result.newBalance)}</b>`;

        const keyboard = { inline_keyboard: [
            [{ text: '⚡ Start New Verification', callback_data: 'verify_home' }],
            [{ text: '💰 Check Balance', callback_data: 'cmd_balance' }]
        ]};

        if (messageId) return editMessage(chatId, messageId, text, { reply_markup: keyboard });
        return sendMessage(chatId, text, { reply_markup: keyboard });

    } catch (e) {
        const errText = `⚠️ <b>Cancel failed:</b> ${esc(e.message)}\n\n<i>If the issue persists, contact support.</i>`;
        const keyboard = { inline_keyboard: [
            [{ text: '💬 Contact Support', url: 'https://t.me/olaslogsupport' }],
            [{ text: '← Back to Hub', callback_data: 'verify_home' }]
        ]};
        if (messageId) return editMessage(chatId, messageId, errText, { reply_markup: keyboard });
        return sendMessage(chatId, errText, { reply_markup: keyboard });
    }
}

// ─── VERIFICATION: History ────────────────────────────────────────────────────────

async function handleVerifyHistory(chatId, from, messageId = null) {
    const user = resolveUser(from);
    if (!user) {
        return sendMessage(chatId, `⚠️ Could not locate your account. Type /start to initialize.`);
    }

    const history = phoneVerify.getUserVerifications(user.id, 10);

    if (!history || history.length === 0) {
        const text =
            `📜 <b>Verification History</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n` +
            `No verifications yet! Request your first US number below.`;
        const keyboard = { inline_keyboard: [
            [{ text: '⚡ Start Verification', callback_data: 'verify_home' }]
        ]};
        if (messageId) return editMessage(chatId, messageId, text, { reply_markup: keyboard });
        return sendMessage(chatId, text, { reply_markup: keyboard });
    }

    let text = `📜 <b>Recent Verifications (Last 10)</b>\n━━━━━━━━━━━━━━━━━━━━━\n`;
    for (const v of history) {
        const date = v.createdAt ? new Date(v.createdAt).toLocaleDateString('en-NG', {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        }) : '—';

        const statusEmoji = {
            completed: '✅', refunded: '💸', timed_out: '⏰', rejected: '❌', reserved: '⏳', awaiting_mdn: '⏳'
        }[v.status] || '⏳';

        text += `\n${statusEmoji} <b>${esc(v.service)}</b>`;
        if (v.formattedNumber || v.phoneNumber) {
            text += ` — <code>${esc(v.formattedNumber || v.phoneNumber)}</code>`;
        }
        if (v.otpCode) {
            text += `\n🔑 OTP: <code>${esc(v.otpCode)}</code>`;
        }
        text += `\n   ${statusEmoji} ${v.status.replace(/_/g, ' ')} • ${esc(v.costFormatted || '')} • <i>${date}</i>\n`;
    }

    const keyboard = { inline_keyboard: [
        [{ text: '⚡ New Verification', callback_data: 'verify_home' }],
        [{ text: '📱 Full History in App', web_app: { url: `${APP_URL}/#verification` } }]
    ]};

    if (messageId) return editMessage(chatId, messageId, text, { reply_markup: keyboard });
    return sendMessage(chatId, text, { reply_markup: keyboard });
}

// ─── SHOP: Category List ────────────────────────────────────────────────────────

async function handleShopHome(chatId, messageId = null) {
    const categories = db.prepare(`
        SELECT pc.id, pc.name, pc.icon, COUNT(p.id) as product_count
        FROM product_categories pc
        LEFT JOIN products p ON p.category_id = pc.id AND p.is_active = 1
        GROUP BY pc.id
        HAVING product_count > 0
        ORDER BY product_count DESC
        LIMIT 12
    `).all();

    if (!categories.length) {
        const text = `🛍️ <b>Olaslog Shop</b>\n\nNo products available right now. Check back soon!`;
        const keyboard = { inline_keyboard: [[{ text: '🔔 Get Notified', url: 'https://t.me/olaslogsupport' }]] };
        if (messageId) return editMessage(chatId, messageId, text, { reply_markup: keyboard });
        return sendMessage(chatId, text, { reply_markup: keyboard });
    }

    const text =
        `🛍️ <b>Olaslog Marketplace</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `Tap a category to browse products and buy instantly:\n`;

    // Build category grid (2 per row)
    const rows = [];
    for (let i = 0; i < categories.length; i += 2) {
        const row = [];
        const catA = categories[i];
        row.push({
            text: `${catA.icon || '📦'} ${catA.name} (${catA.product_count})`,
            callback_data: `cat_${catA.id}`
        });
        if (categories[i + 1]) {
            const catB = categories[i + 1];
            row.push({
                text: `${catB.icon || '📦'} ${catB.name} (${catB.product_count})`,
                callback_data: `cat_${catB.id}`
            });
        }
        rows.push(row);
    }

    rows.push([
        { text: '💰 My Balance', callback_data: 'cmd_balance' },
        { text: '📦 My Orders', callback_data: 'cmd_orders' }
    ]);

    if (messageId) {
        return editMessage(chatId, messageId, text, { reply_markup: { inline_keyboard: rows } });
    }
    return sendMessage(chatId, text, { reply_markup: { inline_keyboard: rows } });
}

// ─── SHOP: Product List for a Category ─────────────────────────────────────────

async function handleCategoryProducts(chatId, categoryId, messageId = null) {
    const category = db.prepare(`SELECT * FROM product_categories WHERE id = ?`).get(categoryId);
    if (!category) {
        return sendMessage(chatId, `⚠️ Category not found.`);
    }

    const products = db.prepare(`
        SELECT id, name, price, description, sujan_product_id
        FROM products
        WHERE category_id = ? AND is_active = 1
        ORDER BY price ASC
        LIMIT 20
    `).all(categoryId);

    if (!products.length) {
        const text = `${category.icon || '📦'} <b>${esc(category.name)}</b>\n\nNo products available in this category right now.`;
        const keyboard = {
            inline_keyboard: [[{ text: '← Back to Categories', callback_data: 'shop_home' }]]
        };
        if (messageId) return editMessage(chatId, messageId, text, { reply_markup: keyboard });
        return sendMessage(chatId, text, { reply_markup: keyboard });
    }

    const text =
        `${category.icon || '📦'} <b>${esc(category.name)}</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `${products.length} product${products.length > 1 ? 's' : ''} available. Tap to view & buy:\n`;

    // Build product buttons (1 per row, shows name + price)
    const rows = products.map(p => ([{
        text: `${esc(p.name)} — ${currency(p.price)}`,
        callback_data: `prod_${p.id}`
    }]));

    rows.push([{ text: '← Back to Categories', callback_data: 'shop_home' }]);

    if (messageId) {
        return editMessage(chatId, messageId, text, { reply_markup: { inline_keyboard: rows } });
    }
    return sendMessage(chatId, text, { reply_markup: { inline_keyboard: rows } });
}

// ─── SHOP: Product Detail + Buy Button ─────────────────────────────────────────

async function handleProductDetail(chatId, productId, messageId = null) {
    const product = db.prepare(`
        SELECT p.*, pc.name as category_name, pc.icon as category_icon
        FROM products p
        JOIN product_categories pc ON p.category_id = pc.id
        WHERE p.id = ? AND p.is_active = 1
    `).get(productId);

    if (!product) {
        return sendMessage(chatId, `⚠️ Product not found or is no longer available.`);
    }

    // Check live stock availability from Sujan
    let stockNote = '';
    try {
        const sujanService = require('./sujan');
        if (product.sujan_product_id) {
            const stockRes = await sujanService.getProductStock(product.sujan_product_id);
            const avail = stockRes?.data?.available_stock;
            if (avail != null) {
                stockNote = avail > 0
                    ? `✅ <b>In Stock</b> (${avail} available)\n`
                    : `❌ <b>Out of Stock</b>\n`;
            }
        } else {
            // Check local stock
            const localCount = db.prepare(
                `SELECT COUNT(*) as c FROM stock_items WHERE product_id = ? AND status = 'available'`
            ).get(productId);
            if (localCount) {
                stockNote = localCount.c > 0
                    ? `✅ <b>In Stock</b> (${localCount.c} available)\n`
                    : `❌ <b>Out of Stock</b>\n`;
            }
        }
    } catch (e) { /* skip stock check on error */ }

    const text =
        `${product.category_icon || '📦'} <b>${esc(product.name)}</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `Category: <i>${esc(product.category_name)}</i>\n` +
        `Price:    <b>${currency(product.price)}</b>\n` +
        stockNote +
        `\n${product.description ? esc(product.description) + '\n' : ''}` +
        `\n⚡ <i>Credentials delivered instantly to this chat after purchase.</i>`;

    const keyboard = {
        inline_keyboard: [
            [{ text: `🛒 Buy Now — ${currency(product.price)}`, callback_data: `buy_confirm_${product.id}` }],
            [
                { text: '← Back to Category', callback_data: `cat_${product.category_id}` },
                { text: '💰 Check Balance', callback_data: 'cmd_balance' }
            ]
        ]
    };

    if (messageId) {
        return editMessage(chatId, messageId, text, { reply_markup: keyboard });
    }
    return sendMessage(chatId, text, { reply_markup: keyboard });
}

// ─── SHOP: Order Confirmation Prompt ───────────────────────────────────────────

async function handleBuyConfirm(chatId, from, productId, messageId = null) {
    const user = resolveUser(from);
    if (!user) {
        return sendMessage(chatId, `⚠️ Could not locate your account. Type /start to initialize.`);
    }

    const product = db.prepare(`SELECT * FROM products WHERE id = ? AND is_active = 1`).get(productId);
    if (!product) {
        return sendMessage(chatId, `⚠️ Product not found or is no longer available.`);
    }

    const balance = getWalletBalance(user.id);
    const canAfford = balance >= product.price;

    // Store pending order context
    pendingOrders.set(chatId, { productId: product.id, productName: product.name, price: product.price });

    let text =
        `🛒 <b>Confirm Your Order</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `Product: <b>${esc(product.name)}</b>\n` +
        `Price:   <b>${currency(product.price)}</b>\n\n` +
        `Your Balance: <b>${currency(balance)}</b>\n`;

    if (!canAfford) {
        const shortfall = product.price - balance;
        text +=
            `\n⚠️ <b>Insufficient balance!</b>\n` +
            `You need <b>${currency(shortfall)}</b> more.\n` +
            `Fund your wallet first, then come back.`;

        const keyboard = {
            inline_keyboard: [
                [{ text: '💳 Fund Wallet', callback_data: 'cmd_fund' }],
                [{ text: '← Back', callback_data: `prod_${productId}` }]
            ]
        };
        if (messageId) return editMessage(chatId, messageId, text, { reply_markup: keyboard });
        return sendMessage(chatId, text, { reply_markup: keyboard });
    }

    const balanceAfter = balance - product.price;
    text += `Balance After: <b>${currency(balanceAfter)}</b>\n\n✅ Tap <b>Confirm & Pay</b> to complete your purchase.`;

    const keyboard = {
        inline_keyboard: [
            [{ text: `✅ Confirm & Pay ${currency(product.price)}`, callback_data: `buy_execute_${productId}` }],
            [{ text: '❌ Cancel', callback_data: `prod_${productId}` }]
        ]
    };

    if (messageId) {
        return editMessage(chatId, messageId, text, { reply_markup: keyboard });
    }
    return sendMessage(chatId, text, { reply_markup: keyboard });
}

// ─── SHOP: Execute Purchase ─────────────────────────────────────────────────────

async function handleBuyExecute(chatId, from, productId, messageId = null) {
    const user = resolveUser(from);
    if (!user) {
        return sendMessage(chatId, `⚠️ Could not locate your account. Type /start to initialize.`);
    }

    // Show processing state
    const processingText =
        `⏳ <b>Processing your order...</b>\n\n` +
        `Please wait while we secure your digital product.`;

    if (messageId) {
        await editMessage(chatId, messageId, processingText, { reply_markup: { inline_keyboard: [] } });
    } else {
        await sendMessage(chatId, processingText);
    }

    // Clear pending order
    pendingOrders.delete(chatId);

    // Lazy require to avoid circular dependency (order.js imports telegramBot at top level)
    const { checkoutCart } = require('./order');
    try {
        const result = await checkoutCart(user.id, [{ productId: Number(productId), quantity: 1 }]);

        // checkoutCart already fires the Telegram DM delivery notification internally,
        // so we only need to update the "processing" message to a success summary.
        const successText =
            `✅ <b>Order Placed Successfully!</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n` +
            `Order: <b>#${esc(result.orderNumber)}</b>\n` +
            `Amount: <b>${currency(result.totalAmount)}</b>\n` +
            `New Balance: <b>${currency(result.remainingBalance)}</b>\n\n` +
            `📦 <b>Your credentials have been delivered above in this chat!</b>\n` +
            `<i>Scroll up or check below.</i>`;

        const keyboard = {
            inline_keyboard: [
                [{ text: '🛍️ Shop Again', callback_data: 'shop_home' }],
                [
                    { text: '📦 My Orders', callback_data: 'cmd_orders' },
                    { text: '💬 Support', url: 'https://t.me/olaslogsupport' }
                ]
            ]
        };

        return sendMessage(chatId, successText, { reply_markup: keyboard });

    } catch (err) {
        console.error('[Bot] Checkout error:', err.message);

        let errorText;
        if (err.code === 'INSUFFICIENT_FUNDS') {
            errorText =
                `❌ <b>Payment Failed: Insufficient Balance</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━\n` +
                `You need <b>${currency(err.shortfall || 0)}</b> more to complete this purchase.\n` +
                `Current balance: <b>${currency(err.currentBalance || 0)}</b>`;
        } else if (err.code === 'OUT_OF_STOCK') {
            errorText =
                `❌ <b>Out of Stock</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━\n` +
                `Sorry, this product just went out of stock.\n` +
                `Browse alternatives below.`;
        } else {
            errorText =
                `❌ <b>Order Failed</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━\n` +
                `Something went wrong processing your order.\n` +
                `Please try again or contact support.`;
        }

        const keyboard = {
            inline_keyboard: [
                err.code === 'INSUFFICIENT_FUNDS'
                    ? [{ text: '💳 Fund Wallet', callback_data: 'cmd_fund' }]
                    : [{ text: '🛍️ Browse Other Products', callback_data: 'shop_home' }],
                [{ text: '💬 Contact Support', url: 'https://t.me/olaslogsupport' }]
            ]
        };

        return sendMessage(chatId, errorText, { reply_markup: keyboard });
    }
}

// ─── Callback Query Router ─────────────────────────────────────────────────────

async function handleCallbackQuery(cq) {
    const { data, id: cqId, from: cqFrom, message: cqMessage } = cq;
    const chatId = cqMessage ? cqMessage.chat.id : cqFrom.id;
    const messageId = cqMessage ? cqMessage.message_id : null;

    // Always acknowledge immediately to remove loading spinner
    apiCall('answerCallbackQuery', { callback_query_id: cqId }).catch(() => {});

    // ── Navigation ──────────────────────────
    if (data === 'shop_home') {
        return handleShopHome(chatId, messageId);
    }

    if (data === 'main_menu') {
        return handleStart({ chat: { id: chatId }, from: cqFrom });
    }

    if (data === 'cmd_balance') {
        return handleBalance(chatId, cqFrom, messageId);
    }

    if (data === 'cmd_fund') {
        return handleFund(chatId, cqFrom, messageId);
    }

    if (data === 'cmd_orders') {
        return handleOrders(chatId, cqFrom, messageId);
    }

    if (data === 'cmd_help') {
        return handleHelp(chatId, messageId);
    }

    // ── Category drill-down ─────────────────
    if (data.startsWith('cat_')) {
        const catId = parseInt(data.slice(4), 10);
        return handleCategoryProducts(chatId, catId, messageId);
    }

    // ── Product detail ──────────────────────
    if (data.startsWith('prod_')) {
        const prodId = parseInt(data.slice(5), 10);
        return handleProductDetail(chatId, prodId, messageId);
    }

    // ── Buy: confirmation screen ────────────
    if (data.startsWith('buy_confirm_')) {
        const prodId = parseInt(data.slice(12), 10);
        return handleBuyConfirm(chatId, cqFrom, prodId, messageId);
    }

    // ── Buy: execute payment ────────────────
    if (data.startsWith('buy_execute_')) {
        const prodId = parseInt(data.slice(12), 10);
        return handleBuyExecute(chatId, cqFrom, prodId, messageId);
    }

    // ── SMS Verification Hub ─────────────────
    if (data === 'verify_home') {
        return handleVerifyHome(chatId, cqFrom, messageId);
    }

    if (data === 'verify_browse') {
        return handleVerifyBrowse(chatId, cqFrom, 0, messageId);
    }

    if (data === 'verify_history') {
        return handleVerifyHistory(chatId, cqFrom, messageId);
    }

    if (data.startsWith('verify_page_')) {
        const page = parseInt(data.slice(12), 10) || 0;
        return handleVerifyBrowse(chatId, cqFrom, page, messageId);
    }

    if (data.startsWith('verify_svc_')) {
        const svcName = data.slice(11);
        return handleVerifyService(chatId, cqFrom, svcName, messageId);
    }

    if (data.startsWith('verify_buy_')) {
        const svcName = data.slice(11);
        return handleVerifyBuy(chatId, cqFrom, svcName, messageId);
    }

    if (data.startsWith('verify_exec_')) {
        const svcName = data.slice(12);
        return handleVerifyExecute(chatId, cqFrom, svcName, messageId);
    }

    if (data.startsWith('verify_status_')) {
        const vId = parseInt(data.slice(14), 10);
        return handleVerifyStatus(chatId, cqFrom, vId, messageId);
    }

    if (data.startsWith('verify_cancel_')) {
        const vId = parseInt(data.slice(14), 10);
        return handleVerifyCancel(chatId, cqFrom, vId, messageId);
    }
}

// ─── Text / Command Dispatcher ─────────────────────────────────────────────────

async function processUpdate(update) {
    if (update.callback_query) {
        return handleCallbackQuery(update.callback_query);
    }

    if (update.message && update.message.text) {
        const msg = update.message;
        const rawText = msg.text.trim();
        const lowerText = rawText.toLowerCase();
        const cmd = rawText.split(' ')[0].toLowerCase().split('@')[0];

        // ── Reply keyboard button handlers (text messages from bottom keyboard) ──
        if (lowerText === '🛍️ browse products') {
            return handleShopHome(msg.chat.id);
        }
        if (lowerText === '💰 my balance') {
            return handleBalance(msg.chat.id, msg.from);
        }
        if (lowerText === '💳 fund wallet') {
            return handleFund(msg.chat.id, msg.from);
        }
        if (lowerText === '⚡ sms verify') {
            return handleVerifyHome(msg.chat.id, msg.from);
        }
        if (lowerText === '📦 my orders') {
            return handleOrders(msg.chat.id, msg.from);
        }
        if (lowerText === '❓ help & support') {
            return handleHelp(msg.chat.id);
        }

        // ── Slash commands ───────────────────────────────────────────────────────
        switch (cmd) {
            case '/start':
                return handleStart(msg);
            case '/shop':
            case '/catalog':
            case '/products':
                return handleShopHome(msg.chat.id);
            case '/balance':
                return handleBalance(msg.chat.id, msg.from);
            case '/fund':
            case '/deposit':
                return handleFund(msg.chat.id, msg.from);
            case '/orders':
                return handleOrders(msg.chat.id, msg.from);
            case '/verify':
            case '/verification':
            case '/sms':
                return handleVerifyHome(msg.chat.id, msg.from);
            case '/help':
            case '/support':
                return handleHelp(msg.chat.id);
            default:
                if (rawText.startsWith('/')) {
                    return sendMessage(msg.chat.id,
                        `Unrecognized command. Use /verify for SMS verification, /shop to browse products, or tap the keyboard buttons below.`,
                        {
                            parse_mode: 'HTML',
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '⚡ SMS Verify', callback_data: 'verify_home' },
                                     { text: '🛍️ Shop', callback_data: 'shop_home' }]
                                ]
                            }
                        }
                    );
                }
        }
    }
}

// ─── Bot Interface Config ──────────────────────────────────────────────────────

async function configureBotInterface() {
    if (!BOT_TOKEN) return;

    await apiCall('setMyCommands', {
        commands: [
            { command: 'verify',  description: '⚡ US SMS Verification — receive OTP codes from 500+ services' },
            { command: 'shop',    description: '🛍️ Browse & buy products directly in Telegram' },
            { command: 'balance', description: '💰 Check your wallet balance' },
            { command: 'fund',    description: '💳 Get your virtual bank account to top up' },
            { command: 'orders',  description: '📦 View your purchase history & credentials' },
            { command: 'help',    description: '❓ FAQs and customer support' },
            { command: 'start',   description: 'Restart Olaslog Bot' }
        ]
    });

    // Menu button shows the command list — users can also open the Mini App via /start inline button
    await apiCall('setChatMenuButton', {
        menu_button: {
            type: 'commands'
        }
    });
}

// ─── Order Delivery Notification ───────────────────────────────────────────────

async function notifyUserOrderDelivered({ telegramId, orderNumber, totalAmount, deliveredItems }) {
    if (!telegramId) return;

    let text =
        `🎉 <b>Order Delivered!</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `Order: <b>#${esc(orderNumber)}</b>\n` +
        `Total: <b>${currency(totalAmount)}</b>\n\n` +
        `📦 <b>Your Credentials:</b>\n`;

    for (let i = 0; i < (deliveredItems || []).length; i++) {
        const itm = deliveredItems[i];
        text += `\n<b>${esc(itm.productName || 'Digital Product')}</b>\n`;
        if (itm.publicData) {
            text += `Info: <i>${esc(itm.publicData)}</i>\n`;
        }
        text += `<code>${esc(itm.credentialText || itm.credentials || 'Delivered')}</code>\n`;
    }

    text += `\n⚠️ <i>Save your credentials securely. Tap below to view full order history.</i>`;

    const keyboard = {
        inline_keyboard: [
            [
                { text: '📦 My Orders', callback_data: 'cmd_orders' },
                { text: '🛍️ Shop Again', callback_data: 'shop_home' }
            ]
        ]
    };

    return sendMessage(telegramId, text, { reply_markup: keyboard });
}

// ─── Wallet Funded Notification ────────────────────────────────────────────────

async function notifyUserWalletFunded({ telegramId, amount, newBalance, reference }) {
    if (!telegramId) return;

    const text =
        `💰 <b>Wallet Credited!</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `Amount Added: <b>${currency(amount)}</b>\n` +
        `New Balance:  <b>${currency(newBalance)}</b>\n` +
        `Ref: <code>${esc(reference || 'N/A')}</code>\n\n` +
        `You're ready to shop! Browse products below.`;

    const keyboard = {
        inline_keyboard: [
            [{ text: '🛍️ Shop Now', callback_data: 'shop_home' }]
        ]
    };

    return sendMessage(telegramId, text, { reply_markup: keyboard });
}

// ─── OTP / Verification Code Delivery Notification ──────────────────────────────

async function notifyUserOtpReceived({ telegramId, service, phoneNumber, formattedNumber, otpCode, smsReply, verificationId }) {
    if (!telegramId) return;

    const displayNum = formattedNumber || phoneNumber || 'N/A';

    const text =
        `🔑 <b>OTP Code Received!</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `Service:  <b>${esc(service)}</b>\n` +
        `📱 Number: <code>${esc(displayNum)}</code>\n\n` +
        `🎯 <b>Your Verification Code:</b>\n` +
        `<code>${esc(otpCode)}</code>\n\n` +
        (smsReply ? `📨 Full SMS:\n<i>${esc(smsReply)}</i>\n\n` : '') +
        `✅ <i>Enter the code above in ${esc(service)} to complete verification!</i>`;

    const keyboard = {
        inline_keyboard: [
            [{ text: '⚡ New Verification', callback_data: 'verify_home' }],
            [{ text: '📜 Verification History', callback_data: 'verify_history' }]
        ]
    };

    return sendMessage(telegramId, text, { reply_markup: keyboard });
}

// ─── Long Polling Engine ───────────────────────────────────────────────────────

async function pollLoop() {
    while (isPolling) {
        try {
            const res = await apiCall('getUpdates', {
                offset: lastUpdateId + 1,
                timeout: 25,
                allowed_updates: ['message', 'callback_query']
            });

            if (res && res.ok && Array.isArray(res.result)) {
                for (const update of res.result) {
                    if (update.update_id > lastUpdateId) {
                        lastUpdateId = update.update_id;
                    }
                    processUpdate(update).catch((err) => {
                        console.error('[Telegram Bot] Error processing update:', err);
                    });
                }
            } else if (res && !res.ok) {
                if (res.error_code === 409) {
                    console.warn('[Telegram Bot] Conflict 409: Another instance or webhook is active. Retrying in 10s...');
                    await new Promise(r => setTimeout(r, 10000));
                } else {
                    await new Promise(r => setTimeout(r, 3000));
                }
            }
        } catch (err) {
            console.error('[Telegram Bot] Polling network error:', err.message);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

function startBot() {
    if (!BOT_TOKEN) {
        console.log('[Telegram Bot] TELEGRAM_BOT_TOKEN not set, bot service skipped.');
        return;
    }
    if (isPolling) return;
    isPolling = true;

    apiCall('deleteWebhook', { drop_pending_updates: false })
        .then(() => configureBotInterface())
        .then(() => {
            console.log('🤖 [Telegram Bot] Inline shopping engine started for Olaslog!');
            pollLoop();
        })
        .catch((err) => {
            console.warn('[Telegram Bot] Init warning:', err.message);
            pollLoop();
        });
}

function stopBot() {
    isPolling = false;
    console.log('[Telegram Bot] Polling engine stopped.');
}

module.exports = {
    startBot,
    stopBot,
    sendMessage,
    notifyUserOrderDelivered,
    notifyUserWalletFunded,
    notifyUserOtpReceived,
    configureBotInterface
};
