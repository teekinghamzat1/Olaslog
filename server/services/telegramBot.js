'use strict';

const https = require('https');
const db = require('../db');
const { getWalletBalance } = require('./wallet');
const billstack = require('./billstack');
const telegramAuth = require('./telegramAuth');
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

async function handleStart(msg) {
    const { from } = msg;
    const user = resolveUser(from);
    const firstName = from.first_name || 'there';

    const welcomeText =
        `👋 <b>Welcome to Olaslog, ${esc(firstName)}!</b>\n\n` +
        `Nigeria's fastest digital products marketplace.\n` +
        `Get verified accounts, streaming, VPNs & software delivered <b>instantly</b> — right here in Telegram.\n\n` +
        `🛒 <b>Shop without leaving Telegram.</b> Use the buttons below or tap <b>/shop</b> to browse:`;

    const keyboard = {
        inline_keyboard: [
            [{ text: '🛍️ Browse & Buy Products', callback_data: 'shop_home' }],
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

    await sendMessage(msg.chat.id, welcomeText, { reply_markup: keyboard });
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
}

// ─── Text / Command Dispatcher ─────────────────────────────────────────────────

async function processUpdate(update) {
    if (update.callback_query) {
        return handleCallbackQuery(update.callback_query);
    }

    if (update.message && update.message.text) {
        const msg = update.message;
        const text = msg.text.trim();
        const cmd = text.split(' ')[0].toLowerCase().split('@')[0];

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
            case '/help':
            case '/support':
                return handleHelp(msg.chat.id);
            default:
                if (text.startsWith('/')) {
                    return sendMessage(msg.chat.id,
                        `Unrecognized command. Use /shop to browse products or /help for support.`,
                        {
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '🛍️ Browse Products', callback_data: 'shop_home' }]
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
            { command: 'shop',    description: '🛍️ Browse & buy products directly in Telegram' },
            { command: 'balance', description: '💰 Check your wallet balance' },
            { command: 'fund',    description: '💳 Get your virtual bank account to top up' },
            { command: 'orders',  description: '📦 View your purchase history & credentials' },
            { command: 'help',    description: '❓ FAQs and customer support' },
            { command: 'start',   description: 'Restart Olaslog Bot' }
        ]
    });

    await apiCall('setChatMenuButton', {
        menu_button: {
            type: 'web_app',
            text: '🛍️ Mini App',
            web_app: { url: APP_URL }
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
    configureBotInterface
};
