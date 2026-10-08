'use strict';

const https = require('https');
const db = require('../db');
const { getWalletBalance } = require('./wallet');
const billstack = require('./billstack');
const telegramAuth = require('./telegramAuth');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const APP_URL   = (process.env.APP_URL || 'https://olaslog.com').replace(/\/+$/, '');

let isPolling = false;
let pollingAbortController = null;
let lastUpdateId = 0;

/**
 * Execute Telegram Bot API HTTP Request
 */
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
                try {
                    const parsed = JSON.parse(data);
                    resolve(parsed);
                } catch (e) {
                    resolve({ ok: false, error: 'Invalid JSON response from Telegram' });
                }
            });
        });

        req.on('error', (err) => {
            resolve({ ok: false, error: err.message });
        });

        req.setTimeout(35000, () => {
            req.destroy();
            resolve({ ok: false, error: 'Request timeout' });
        });

        req.write(payload);
        req.end();
    });
}

function esc(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function currency(amount) {
    return `₦${Number(amount || 0).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;
}

/**
 * Send a message to any Telegram Chat ID
 */
async function sendMessage(chatId, text, options = {}) {
    return apiCall('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...options
    });
}

/**
 * Get or register user by Telegram ID
 */
function resolveUser(from) {
    if (!from || !from.id) return null;
    return telegramAuth.findOrCreateTelegramUser(from);
}

/**
 * Handle /start command
 */
async function handleStart(msg) {
    const { from, chat } = msg;
    const user = resolveUser(from);
    const firstName = from.first_name || 'there';

    const welcomeText =
        `👋 <b>Welcome to Olaslog, ${esc(firstName)}!</b>\n\n` +
        `Olaslog is Nigeria's premier instant-delivery digital products marketplace.\n` +
        `Get verified aged accounts, socials, cloud credits, streaming tools, and software licenses delivered instantly 24/7.\n\n` +
        `🚀 <b>Tap "Open Marketplace" below to launch the Mini App</b> or use the quick commands below:\n` +
        `• 💰 <b>/balance</b> — Check your wallet balance\n` +
        `• 💳 <b>/fund</b> — Get your instant virtual bank account\n` +
        `• 📦 <b>/orders</b> — View your purchased products & keys\n` +
        `• 🛍️ <b>/catalog</b> — Browse digital categories\n` +
        `• ❓ <b>/help</b> — Customer support & instructions`;

    const keyboard = {
        inline_keyboard: [
            [
                {
                    text: '🛍️ Open Marketplace (Mini App)',
                    web_app: { url: APP_URL }
                }
            ],
            [
                { text: '💰 Balance', callback_data: 'cmd_balance' },
                { text: '💳 Fund Wallet', callback_data: 'cmd_fund' }
            ],
            [
                { text: '📦 My Orders', callback_data: 'cmd_orders' },
                { text: '💬 Support', url: 'https://t.me/olaslogsupport' }
            ]
        ]
    };

    await sendMessage(msg.chat.id, welcomeText, { reply_markup: keyboard });
}

/**
 * Handle /balance command
 */
async function handleBalance(chatId, from) {
    const user = resolveUser(from);
    if (!user) {
        return sendMessage(chatId, `⚠️ Could not locate your account. Type /start to initialize.`);
    }

    const bal = getWalletBalance(user.id);

    const text =
        `💰 <b>Your Olaslog Wallet</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `Current Balance: <b>${currency(bal)}</b>\n` +
        `Account Name:    <b>${esc(user.full_name)}</b>\n` +
        `User ID:         #${user.id}\n` +
        `\n` +
        `Need to top up? Tap <b>Fund Wallet</b> to get your dedicated transfer account.`;

    const keyboard = {
        inline_keyboard: [
            [
                {
                    text: '🛍️ Shop Now',
                    web_app: { url: APP_URL }
                },
                { text: '💳 Fund Wallet', callback_data: 'cmd_fund' }
            ]
        ]
    };

    await sendMessage(chatId, text, { reply_markup: keyboard });
}

/**
 * Handle /fund command
 */
async function handleFund(chatId, from) {
    const user = resolveUser(from);
    if (!user) {
        return sendMessage(chatId, `⚠️ Could not locate your account. Type /start to initialize.`);
    }

    let va = billstack.getVirtualAccount(user.id);
    if (!va) {
        try {
            va = await billstack.createVirtualAccount(user, '9PSB');
        } catch (e) {
            // fallback
        }
    }

    let text;
    let keyboard;

    if (va && va.account_number) {
        text =
            `💳 <b>Instant Wallet Top-Up</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n` +
            `Transfer any amount from <b>any Nigerian banking app</b> (Kuda, OPay, PalmPay, GTB, Zenith, etc.) to your dedicated virtual account below:\n\n` +
            `🏦 Bank: <b>${esc(va.bank_name || '9PSB')}</b>\n` +
            `🔢 Account No: <code>${esc(va.account_number)}</code>\n` +
            `👤 Name: <b>${esc(va.account_name)}</b>\n\n` +
            `⚡ <i>Your Olaslog wallet is credited automatically within 10 seconds of transfer!</i>`;

        keyboard = {
            inline_keyboard: [
                [
                    { text: '🔄 Refresh Balance', callback_data: 'cmd_balance' },
                    { text: '🛍️ Open Mini App', web_app: { url: APP_URL } }
                ]
            ]
        };
    } else {
        text =
            `💳 <b>Fund Your Wallet</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n` +
            `Open the Olaslog Mini App to generate your dedicated bank account or top up using card/transfer.`;

        keyboard = {
            inline_keyboard: [
                [
                    { text: '⚡ Fund in Mini App', web_app: { url: `${APP_URL}/#wallet` } }
                ]
            ]
        };
    }

    await sendMessage(chatId, text, { reply_markup: keyboard });
}

/**
 * Handle /orders command
 */
async function handleOrders(chatId, from) {
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

    if (!recentOrders || recentOrders.length === 0) {
        const text =
            `📦 <b>Your Order History</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n` +
            `You haven't placed any orders yet!\n\n` +
            `Explore our catalog of digital accounts and tools in the Mini App below:`;

        const keyboard = {
            inline_keyboard: [
                [{ text: '🛍️ Browse Products', web_app: { url: APP_URL } }]
            ]
        };
        return sendMessage(chatId, text, { reply_markup: keyboard });
    }

    let text = `📦 <b>Recent Orders (Last 5)</b>\n━━━━━━━━━━━━━━━━━━━━━\n`;
    for (const ord of recentOrders) {
        const dateStr = new Date(ord.created_at).toLocaleDateString('en-NG', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        text += `• <b>#${esc(ord.order_number)}</b> — ${currency(ord.total_amount)} (${esc(ord.status.toUpperCase())})\n  <i>${dateStr}</i>\n`;
    }
    text += `\nTo view credentials, receipts, or download tokens, open the Mini App:`;

    const keyboard = {
        inline_keyboard: [
            [{ text: '📱 View Orders in Mini App', web_app: { url: `${APP_URL}/#orders` } }]
        ]
    };

    await sendMessage(chatId, text, { reply_markup: keyboard });
}

/**
 * Handle /catalog command
 */
async function handleCatalog(chatId) {
    const categories = db.prepare(`
        SELECT pc.id, pc.name, pc.icon, COUNT(p.id) as product_count
        FROM product_categories pc
        LEFT JOIN products p ON p.category_id = pc.id AND p.is_active = 1
        GROUP BY pc.id
        ORDER BY product_count DESC
        LIMIT 8
    `).all();

    let text = `🛍️ <b>Olaslog Digital Catalog</b>\n━━━━━━━━━━━━━━━━━━━━━\n`;
    for (const cat of categories) {
        text += `${cat.icon || '📦'} <b>${esc(cat.name)}</b> (${cat.product_count} items)\n`;
    }
    text += `\nLaunch the Mini App to see full live stock, pricing, and 1-tap checkout:`;

    const keyboard = {
        inline_keyboard: [
            [{ text: '🚀 Launch Marketplace', web_app: { url: APP_URL } }]
        ]
    };

    await sendMessage(chatId, text, { reply_markup: keyboard });
}

/**
 * Handle /help command
 */
async function handleHelp(chatId) {
    const text =
        `❓ <b>Olaslog Support & Guide</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `• <b>How do I buy?</b>\n` +
        `Tap "Open Marketplace", choose your desired digital product, and pay with your funded wallet for instant delivery.\n\n` +
        `• <b>How do I fund my wallet?</b>\n` +
        `Type /fund to see your personal 9PSB bank account number. Transfers reflect in seconds.\n\n` +
        `• <b>Where are my purchased items?</b>\n` +
        `Delivered credentials appear directly in this chat and are always saved under your Orders in the Mini App.\n\n` +
        `💬 Need 1-on-1 human support? Reach out to our 24/7 desk: @olaslogsupport`;

    const keyboard = {
        inline_keyboard: [
            [
                { text: '🛍️ Open Marketplace', web_app: { url: APP_URL } },
                { text: '💬 Contact Support', url: 'https://t.me/olaslogsupport' }
            ]
        ]
    };

    await sendMessage(chatId, text, { reply_markup: keyboard });
}

/**
 * Process incoming Telegram Update
 */
async function processUpdate(update) {
    // 1. Callback Queries (Inline Button clicks)
    if (update.callback_query) {
        const { callback_query: cq } = update;
        const { data, id: cqId, from: cqFrom, message: cqMessage } = cq;
        const chatId = cqMessage ? cqMessage.chat.id : cqFrom.id;

        // Acknowledge callback query
        apiCall('answerCallbackQuery', { callback_query_id: cqId }).catch(() => {});

        if (data === 'cmd_balance') {
            return handleBalance(chatId, cqFrom);
        } else if (data === 'cmd_fund') {
            return handleFund(chatId, cqFrom);
        } else if (data === 'cmd_orders') {
            return handleOrders(chatId, cqFrom);
        }
        return;
    }

    // 2. Text Messages & Commands
    if (update.message && update.message.text) {
        const { message: msg } = update;
        const text = msg.text.trim();
        const cmd = text.split(' ')[0].toLowerCase().split('@')[0];

        switch (cmd) {
            case '/start':
                return handleStart(msg);
            case '/balance':
                return handleBalance(msg.chat.id, msg.from);
            case '/fund':
            case '/deposit':
                return handleFund(msg.chat.id, msg.from);
            case '/orders':
                return handleOrders(msg.chat.id, msg.from);
            case '/catalog':
            case '/products':
            case '/shop':
                return handleCatalog(msg.chat.id);
            case '/help':
            case '/support':
                return handleHelp(msg.chat.id);
            default:
                if (text.startsWith('/')) {
                    return sendMessage(msg.chat.id, `Unrecognized command. Type /help to see all available commands or tap below to open the Mini App:`, {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '🛍️ Open Marketplace', web_app: { url: APP_URL } }]
                            ]
                        }
                    });
                }
        }
    }
}

/**
 * Configure default bot menu buttons and command hints in Telegram
 */
async function configureBotInterface() {
    if (!BOT_TOKEN) return;

    // Set Bot Commands Menu
    await apiCall('setMyCommands', {
        commands: [
            { command: 'start', description: 'Launch Olaslog & Open Mini App' },
            { command: 'balance', description: 'Check your wallet balance' },
            { command: 'fund', description: 'Get virtual bank account to top up' },
            { command: 'orders', description: 'View recent purchases and delivery keys' },
            { command: 'catalog', description: 'Browse digital product categories' },
            { command: 'help', description: 'Frequently asked questions & support' }
        ]
    });

    // Set Chat Menu Button to launch Mini App directly from bottom-left corner
    await apiCall('setChatMenuButton', {
        menu_button: {
            type: 'web_app',
            text: '🛍️ Shop',
            web_app: { url: APP_URL }
        }
    });
}

/**
 * Notification to user when digital goods are delivered
 */
async function notifyUserOrderDelivered({ telegramId, orderNumber, totalAmount, deliveredItems }) {
    if (!telegramId) return;

    let text =
        `🎉 <b>Order Delivered Instantly!</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `Order: <b>#${esc(orderNumber)}</b>\n` +
        `Total: <b>${currency(totalAmount)}</b>\n\n` +
        `📦 <b>Your Items:</b>\n`;

    for (let i = 0; i < (deliveredItems || []).length; i++) {
        const itm = deliveredItems[i];
        text += `\n<b>Item ${i + 1}: ${esc(itm.productName || 'Digital Product')}</b>\n`;
        if (itm.publicData) {
            text += `Info: <i>${esc(itm.publicData)}</i>\n`;
        }
        text += `<code>${esc(itm.credentialText || itm.credentials || 'Delivered')}</code>\n`;
    }

    text += `\n⚠️ <i>Keep your credentials secure. Tap below to manage or view in the Mini App anytime.</i>`;

    const keyboard = {
        inline_keyboard: [
            [
                { text: '📱 View in Mini App', web_app: { url: `${APP_URL}/#orders` } }
            ]
        ]
    };

    return sendMessage(telegramId, text, { reply_markup: keyboard });
}

/**
 * Notification to user when their wallet is funded
 */
async function notifyUserWalletFunded({ telegramId, amount, newBalance, reference }) {
    if (!telegramId) return;

    const text =
        `💰 <b>Deposit Confirmed!</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `Amount Added: <b>${currency(amount)}</b>\n` +
        `New Balance:  <b>${currency(newBalance)}</b>\n` +
        `Ref:          <code>${esc(reference || 'N/A')}</code>\n\n` +
        `Your funds are ready. Tap below to buy any digital product instantly!`;

    const keyboard = {
        inline_keyboard: [
            [{ text: '🛍️ Open Marketplace', web_app: { url: APP_URL } }]
        ]
    };

    return sendMessage(telegramId, text, { reply_markup: keyboard });
}

/**
 * Long Polling Worker Loop
 */
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
                // If conflict (e.g. another instance running or webhook active), wait 10s
                if (res.error_code === 409) {
                    console.warn('[Telegram Bot] Conflict 409: Another bot instance may be polling or webhook is set. Retrying in 10s...');
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

/**
 * Start Bot Service
 */
function startBot() {
    if (!BOT_TOKEN) {
        console.log('[Telegram Bot] TELEGRAM_BOT_TOKEN not provided, bot service skipped.');
        return;
    }

    if (isPolling) return;
    isPolling = true;

    // Delete any previous webhook before polling
    apiCall('deleteWebhook', { drop_pending_updates: false })
        .then(() => configureBotInterface())
        .then(() => {
            console.log('🤖 [Telegram Bot] Polling engine started successfully for Olaslog!');
            pollLoop();
        })
        .catch((err) => {
            console.warn('[Telegram Bot] Initialization warning:', err.message);
            pollLoop();
        });
}

/**
 * Stop Bot Service
 */
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
    configureBotInterface
};
