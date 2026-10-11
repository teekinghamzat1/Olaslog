'use strict';

const db = require('../db');
const { getWalletBalance } = require('./wallet');

const API_ENDPOINT = 'https://www.usphoneverify.com/api_command.php';

// In-memory cache for provider service list (5 minutes TTL)
let servicesCache = null;
let servicesCacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

// Curated list of popular services with icons & categories
const POPULAR_SERVICES_METADATA = {
    'WhatsApp': { icon: '💬', category: 'Social', popular: true, desc: 'Receive WhatsApp SMS code for accounts & business' },
    'Telegram': { icon: '✈️', category: 'Social', popular: true, desc: 'Instant code for Telegram registration & login' },
    'Google': { icon: '🔍', category: 'Tech & AI', popular: true, desc: 'Gmail, Google Workspace & YouTube activation' },
    'OpenAI': { icon: '🤖', category: 'Tech & AI', popular: true, desc: 'ChatGPT, OpenAI & Sora developer accounts' },
    'TikTok': { icon: '🎵', category: 'Social', popular: true, desc: 'TikTok creator & ads account verification' },
    'Instagram': { icon: '📸', category: 'Social', popular: true, desc: 'Instagram & Threads phone confirmation' },
    'Discord': { icon: '🎮', category: 'Social', popular: true, desc: 'Discord unbanning & phone verification' },
    'Twitter': { icon: '🐦', category: 'Social', popular: true, desc: 'X / Twitter profile verification' },
    'Amazon': { icon: '📦', category: 'Shopping', popular: true, desc: 'Amazon buyer, seller & AWS OTP' },
    'Apple': { icon: '🍎', category: 'Tech & AI', popular: true, desc: 'Apple ID & iCloud two-factor authentication' },
    'Netflix': { icon: '🎬', category: 'Entertainment', popular: true, desc: 'Netflix family & household verification' },
    'Microsoft': { icon: '💻', category: 'Tech & AI', popular: true, desc: 'Outlook, Xbox & Microsoft 365 activation' },
    'Steam': { icon: '🕹️', category: 'Gaming', popular: false, desc: 'Steam Guard & CS:GO Prime matchmaking' },
    'Uber': { icon: '🚗', category: 'Lifestyle', popular: false, desc: 'Uber rider & driver activation' },
    'Tinder': { icon: '🔥', category: 'Lifestyle', popular: false, desc: 'Tinder dating profile phone verification' },
    'Coinbase': { icon: '🪙', category: 'Finance', popular: false, desc: 'Coinbase crypto wallet authentication' },
    'Binance': { icon: '🟡', category: 'Finance', popular: false, desc: 'Binance security SMS verification' },
    'PayPal': { icon: '💳', category: 'Finance', popular: false, desc: 'PayPal US account phone verification' }
};

/**
 * Reads verification settings from DB with fallback to process.env
 */
function getSettings() {
    try {
        const rows = db.prepare('SELECT key, value FROM verification_settings').all();
        const map = {};
        for (const r of rows) {
            map[r.key] = r.value;
        }

        const user = map.api_user || process.env.USPHONEVERIFY_USER || '';
        const apiKey = map.api_key || process.env.USPHONEVERIFY_API_KEY || '';
        const usdRate = parseFloat(map.usd_rate || process.env.USPHONEVERIFY_USD_RATE || '1500');
        const marginPercent = parseFloat(map.margin_percent || process.env.USPHONEVERIFY_MARGIN_PERCENT || '25');
        const minPriceNgn = parseFloat(map.min_price_ngn || process.env.USPHONEVERIFY_MIN_PRICE || '800');

        return {
            user,
            apiKey,
            usdRate: isNaN(usdRate) || usdRate <= 0 ? 1500 : usdRate,
            marginPercent: isNaN(marginPercent) || marginPercent < 0 ? 25 : marginPercent,
            minPriceNgn: isNaN(minPriceNgn) || minPriceNgn <= 0 ? 800 : minPriceNgn,
            isConfigured: Boolean(user && apiKey)
        };
    } catch (e) {
        return {
            user: process.env.USPHONEVERIFY_USER || '',
            apiKey: process.env.USPHONEVERIFY_API_KEY || '',
            usdRate: 1500,
            marginPercent: 25,
            minPriceNgn: 800,
            isConfigured: Boolean(process.env.USPHONEVERIFY_USER && process.env.USPHONEVERIFY_API_KEY)
        };
    }
}

/**
 * Updates a verification setting in DB
 */
function updateSetting(key, value) {
    db.prepare(`
        INSERT INTO verification_settings (key, value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run(key, String(value));
}

/**
 * Converts USD price into customer-facing NGN price with configured margin & rounding
 */
function calculateNgnPrice(usdPrice, settings = null) {
    const s = settings || getSettings();
    const parsedUsd = parseFloat(usdPrice) || 0.50;
    const baseNgn = parsedUsd * s.usdRate * (1 + s.marginPercent / 100);
    // Round up to nearest 50 Naira
    const roundedNgn = Math.ceil(baseNgn / 50) * 50;
    return Math.max(roundedNgn, s.minPriceNgn);
}

/**
 * Sends a command to the USPhoneVerify API
 */
async function callApi(cmd, params = {}) {
    const s = getSettings();
    if (!s.isConfigured) {
        console.warn('[PhoneVerify] API credentials are not configured in settings.');
        throw new Error('SMS verification service is temporarily unavailable. Please try again later or contact support.');
    }

    const url = new URL(API_ENDPOINT);
    url.searchParams.set('cmd', cmd);
    url.searchParams.set('user', s.user);
    url.searchParams.set('api_key', s.apiKey);

    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') {
            url.searchParams.set(k, String(v));
        }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    try {
        const response = await fetch(url.toString(), {
            method: 'GET',
            headers: { 'User-Agent': 'Olaslog-Marketplace/1.0' },
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`SMS verification service error (${response.status}). Please try again later.`);
        }

        return await response.json();
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new Error('SMS verification request timed out. Please try again.');
        }
        throw err;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Check provider account balance (in USD)
 */
async function getProviderBalance() {
    const s = getSettings();
    if (!s.isConfigured) {
        return { isConfigured: false, balanceUsd: '0.00', balanceNgn: 0 };
    }

    try {
        const res = await callApi('balance');
        if (res.status === 'ok') {
            const balanceUsd = parseFloat(res.message) || 0;
            return {
                isConfigured: true,
                balanceUsd: balanceUsd.toFixed(2),
                balanceNgn: Math.round(balanceUsd * s.usdRate)
            };
        }
        return { isConfigured: true, balanceUsd: '0.00', error: res.message };
    } catch (err) {
        return { isConfigured: true, balanceUsd: '0.00', error: err.message };
    }
}

/**
 * List available services with customer NGN prices
 */
async function listServices(forceRefresh = false) {
    const s = getSettings();
    const now = Date.now();

    // Check memory cache
    if (!forceRefresh && servicesCache && (now - servicesCacheTime < CACHE_TTL_MS)) {
        return servicesCache;
    }

    let rawList = [];

    if (s.isConfigured) {
        try {
            const apiRes = await callApi('list_services');
            if (apiRes.status === 'ok' && Array.isArray(apiRes.message)) {
                rawList = apiRes.message;
            }
        } catch (err) {
            console.warn('[PhoneVerify] Failed to fetch services from live API:', err.message);
        }
    }

    // If live API returned nothing or not configured, build default list from popular services
    if (!rawList || rawList.length === 0) {
        rawList = Object.keys(POPULAR_SERVICES_METADATA).map(name => ({
            name,
            price: '0.60',
            otp_available: '50',
            recommended_markup: '10'
        }));
    }

    // Map each service with metadata, icons and calculated NGN price
    const enriched = rawList.map(item => {
        const meta = POPULAR_SERVICES_METADATA[item.name] || {
            icon: '📱',
            category: 'Other',
            popular: false,
            desc: `Instant US verification code for ${item.name}`
        };

        const usdPrice = parseFloat(item.price) || 0.60;
        const ngnPrice = calculateNgnPrice(usdPrice, s);
        const otpCount = parseInt(item.otp_available || '0', 10);

        return {
            name: item.name,
            usdPrice: usdPrice.toFixed(2),
            priceNgn: ngnPrice,
            priceFormatted: `₦${ngnPrice.toLocaleString()}`,
            available: otpCount > 0,
            availableCount: otpCount,
            recommendedMarkup: item.recommended_markup || '0',
            icon: meta.icon,
            category: meta.category,
            popular: meta.popular,
            desc: meta.desc
        };
    });

    // Sort: popular first, then alphabetically
    enriched.sort((a, b) => {
        if (a.popular && !b.popular) return -1;
        if (!a.popular && b.popular) return 1;
        return a.name.localeCompare(b.name);
    });

    servicesCache = enriched;
    servicesCacheTime = now;
    return enriched;
}

/**
 * Purchase / Request a verification phone number
 */
async function requestNumber({ userId, service, areacode, state, markup, mdn }) {
    if (!userId) throw new Error('User authentication required');
    if (!service) throw new Error('Service name is required');

    const s = getSettings();

    // 1. Estimate cost from service list
    const services = await listServices();
    const serviceInfo = services.find(x => x.name.toLowerCase() === service.toLowerCase());
    const estimatedNgn = serviceInfo ? serviceInfo.priceNgn : calculateNgnPrice(0.60, s);
    const estimatedUsd = serviceInfo ? parseFloat(serviceInfo.usdPrice) : 0.60;

    // 2. Verify user has enough wallet balance
    const currentBalance = getWalletBalance(userId);
    if (currentBalance < estimatedNgn) {
        const shortfall = Math.round((estimatedNgn - currentBalance) * 100) / 100;
        const err = new Error('Insufficient wallet balance to request this verification number');
        err.code = 'INSUFFICIENT_FUNDS';
        err.required = estimatedNgn;
        err.currentBalance = currentBalance;
        err.shortfall = shortfall;
        throw err;
    }

    // 3. Make the API call to USPhoneVerify
    const apiParams = { service };
    if (mdn) apiParams.mdn = mdn;
    if (areacode) apiParams.areacode = areacode;
    else if (state) apiParams.state = state;
    if (markup) apiParams.markup = markup;

    const apiRes = await callApi('request', apiParams);

    if (apiRes.status !== 'ok' || !Array.isArray(apiRes.message) || apiRes.message.length === 0) {
        const errorMsg = apiRes.message || 'No verification numbers currently available for this service. Please retry in a few minutes.';
        throw new Error(typeof errorMsg === 'string' ? errorMsg : JSON.stringify(errorMsg));
    }

    const item = apiRes.message[0];
    const requestId = String(item.id);
    const actualUsdPrice = parseFloat(item.price) || estimatedUsd;
    const finalNgnPrice = calculateNgnPrice(actualUsdPrice, s);

    // Re-verify balance in case final price is higher
    if (currentBalance < finalNgnPrice) {
        // Auto-reject at provider since user cannot afford
        try { await callApi('reject', { id: requestId }); } catch (_) {}
        const err = new Error('Insufficient wallet balance for this number');
        err.code = 'INSUFFICIENT_FUNDS';
        err.required = finalNgnPrice;
        err.currentBalance = currentBalance;
        throw err;
    }

    // 4. Atomic Database Debit & Record Creation
    const timestamp = Date.now();
    const walletRef = `VER-REQ-${timestamp}-${Math.floor(1000 + Math.random() * 9000)}`;
    const newBalance = Math.round((currentBalance - finalNgnPrice) * 100) / 100;

    const tillSeconds = parseInt(item.till_expiration || '900', 10);
    const expiresAt = new Date(Date.now() + tillSeconds * 1000).toISOString();

    let initialStatus = 'reserved';
    if (item.status === 'Awaiting MDN' || !item.mdn) {
        initialStatus = 'awaiting_mdn';
    }

    const executeOrder = db.transaction(() => {
        // Record wallet debit in immutable ledger
        db.prepare(`
            INSERT INTO wallet_transactions
            (user_id, type, amount, balance_before, balance_after, reference, status, payment_channel, description, metadata)
            VALUES (?, 'purchase', ?, ?, ?, ?, 'successful', 'wallet', ?, ?)
        `).run(
            userId,
            finalNgnPrice,
            currentBalance,
            newBalance,
            walletRef,
            `US Phone Verification: ${service}`,
            JSON.stringify({ requestId, service, mdn: item.mdn, priceUsd: actualUsdPrice, priceNgn: finalNgnPrice })
        );

        // Record verification in phone_verifications
        const res = db.prepare(`
            INSERT INTO phone_verifications
            (user_id, request_id, service_name, phone_number, state, areacode, carrier, markup, cost_usd, cost_ngn, wallet_ref, status, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            userId,
            requestId,
            service,
            item.mdn || null,
            item.state || state || null,
            areacode || null,
            item.carrier || null,
            parseInt(item.markup || '0', 10),
            actualUsdPrice,
            finalNgnPrice,
            walletRef,
            initialStatus,
            expiresAt
        );

        return res.lastInsertRowid;
    });

    const localId = executeOrder();

    return {
        id: localId,
        requestId,
        service,
        phoneNumber: item.mdn || null,
        formattedNumber: item.mdn ? formatUsPhoneNumber(item.mdn) : null,
        status: initialStatus,
        carrier: item.carrier || null,
        state: item.state || null,
        costNgn: finalNgnPrice,
        costFormatted: `₦${finalNgnPrice.toLocaleString()}`,
        tillExpiration: tillSeconds,
        expiresAt,
        newBalance
    };
}

/**
 * Checks live status of a verification request from provider & DB
 */
async function getVerificationStatus(id, userId = null) {
    let row = null;
    if (userId) {
        row = db.prepare(`SELECT * FROM phone_verifications WHERE id = ? AND user_id = ?`).get(id, userId);
        if (!row) {
            const u = db.prepare('SELECT telegram_id FROM users WHERE id = ?').get(userId);
            if (u && u.telegram_id) {
                row = db.prepare(`
                    SELECT pv.* FROM phone_verifications pv
                    JOIN users u ON pv.user_id = u.id
                    WHERE pv.id = ? AND u.telegram_id = ?
                `).get(id, u.telegram_id);
            }
        }
    } else {
        row = db.prepare(`SELECT * FROM phone_verifications WHERE id = ?`).get(id);
    }

    if (!row) {
        throw new Error('Verification request not found');
    }

    // If already in terminal state, return current record
    if (['completed', 'rejected', 'refunded', 'timed_out'].includes(row.status)) {
        return formatVerificationRow(row);
    }

    // Check if expired locally
    const now = new Date();
    if (row.expires_at && new Date(row.expires_at) < now) {
        // Auto-refund expired request
        await autoRefundVerification(row);
        const updatedRow = db.prepare(`SELECT * FROM phone_verifications WHERE id = ?`).get(id);
        return formatVerificationRow(updatedRow);
    }

    // Call provider API for real-time status update
    try {
        const s = getSettings();
        if (s.isConfigured) {
            const apiRes = await callApi('request_status', { id: row.request_id });
            if (apiRes.status === 'ok' && Array.isArray(apiRes.message) && apiRes.message.length > 0) {
                const pStatus = apiRes.message[0];
                const rawStatus = (pStatus.status || '').toLowerCase();

                // If number was newly assigned in a priority request
                if (pStatus.mdn && (!row.phone_number || row.phone_number !== pStatus.mdn)) {
                    db.prepare(`
                        UPDATE phone_verifications
                        SET phone_number = ?, carrier = ?, status = 'reserved', updated_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                    `).run(pStatus.mdn, pStatus.carrier || row.carrier, row.id);
                    row.phone_number = pStatus.mdn;
                    row.status = 'reserved';
                }

                if (rawStatus === 'completed') {
                    // Fetch received SMS!
                    await fetchAndStoreSMS(row);
                    row = db.prepare(`SELECT * FROM phone_verifications WHERE id = ?`).get(id);
                } else if (['timed out', 'timed_out'].includes(rawStatus)) {
                    await autoRefundVerification(row);
                    row = db.prepare(`SELECT * FROM phone_verifications WHERE id = ?`).get(id);
                } else if (rawStatus === 'rejected') {
                    await autoRefundVerification(row, 'Provider rejected request');
                    row = db.prepare(`SELECT * FROM phone_verifications WHERE id = ?`).get(id);
                }
            }
        }
    } catch (apiErr) {
        console.warn(`[PhoneVerify] Status check error for ${row.request_id}:`, apiErr.message);
    }

    return formatVerificationRow(row);
}

/**
 * Fetches SMS message for completed request and saves to DB
 */
async function fetchAndStoreSMS(row) {
    try {
        const smsRes = await callApi('read_sms', { id: row.request_id });
        if (smsRes.status === 'ok' && Array.isArray(smsRes.message) && smsRes.message.length > 0) {
            const msg = smsRes.message[0];
            const pin = msg.pin || extractPinFromText(msg.reply);
            db.prepare(`
                UPDATE phone_verifications
                SET status = 'completed',
                    sms_reply = ?,
                    otp_code = ?,
                    sms_sender = ?,
                    sms_received_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(msg.reply || '', pin, msg.from || '', row.id);

            // Proactive notification via Telegram Bot if user has telegram linked
            try {
                const userRow = db.prepare('SELECT telegram_id FROM users WHERE id = ?').get(row.user_id);
                if (userRow && userRow.telegram_id && pin) {
                    const telegramBot = require('./telegramBot');
                    telegramBot.notifyUserOtpReceived({
                        telegramId: userRow.telegram_id,
                        service: row.service_name,
                        phoneNumber: row.phone_number,
                        formattedNumber: formatUsPhoneNumber(row.phone_number),
                        otpCode: pin,
                        smsReply: msg.reply || '',
                        verificationId: row.id
                    }).catch(err => console.warn('[PhoneVerify] Error sending Telegram OTP notification:', err.message));
                }
            } catch (notifyErr) {
                console.warn('[PhoneVerify] Failed to notify Telegram user:', notifyErr.message);
            }
        }
    } catch (e) {
        console.warn('[PhoneVerify] Error reading SMS:', e.message);
    }
}

/**
 * Rejects an MDN and instantly refunds 100% of the user's NGN wallet
 */
async function cancelAndRefund(id, userId) {
    let row = db.prepare(`SELECT * FROM phone_verifications WHERE id = ? AND user_id = ?`).get(id, userId);
    if (!row) {
        const u = db.prepare('SELECT telegram_id FROM users WHERE id = ?').get(userId);
        if (u && u.telegram_id) {
            row = db.prepare(`
                SELECT pv.* FROM phone_verifications pv
                JOIN users u ON pv.user_id = u.id
                WHERE pv.id = ? AND u.telegram_id = ?
            `).get(id, u.telegram_id);
        }
    }
    if (!row) {
        throw new Error('Verification request not found');
    }

    if (row.status === 'completed') {
        throw new Error('This verification code was already received and delivered; cannot be refunded.');
    }

    if (['rejected', 'refunded', 'timed_out'].includes(row.status)) {
        return {
            success: true,
            alreadyRefunded: true,
            message: 'This request has already been cancelled and refunded.',
            verification: formatVerificationRow(row),
            balance: getWalletBalance(userId)
        };
    }

    // Call provider reject command (best-effort)
    try {
        await callApi('reject', { id: row.request_id });
    } catch (e) {
        console.warn(`[PhoneVerify] Provider reject warning for ${row.request_id}:`, e.message);
    }

    // Perform atomic refund in user's wallet
    const targetUserId = row.user_id;
    const currentBalance = getWalletBalance(targetUserId);
    const refundAmount = row.cost_ngn;
    const newBalance = Math.round((currentBalance + refundAmount) * 100) / 100;
    const refundRef = `REF-VER-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

    const executeRefund = db.transaction(() => {
        db.prepare(`
            INSERT INTO wallet_transactions
            (user_id, type, amount, balance_before, balance_after, reference, status, payment_channel, description, metadata)
            VALUES (?, 'refund', ?, ?, ?, ?, 'successful', 'wallet_refund', ?, ?)
        `).run(
            targetUserId,
            refundAmount,
            currentBalance,
            newBalance,
            refundRef,
            `Refund for Cancelled Verification (${row.service_name})`,
            JSON.stringify({ verificationId: row.id, requestId: row.request_id, service: row.service_name })
        );

        db.prepare(`
            UPDATE phone_verifications
            SET status = 'refunded', updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(row.id);
    });

    executeRefund();

    const updatedRow = db.prepare(`SELECT * FROM phone_verifications WHERE id = ?`).get(row.id);

    return {
        success: true,
        message: `Successfully cancelled! ₦${refundAmount.toLocaleString()} has been refunded to your wallet.`,
        refundAmount,
        newBalance,
        verification: formatVerificationRow(updatedRow)
    };
}

/**
 * Auto-refunds an expired / timed out verification
 */
async function autoRefundVerification(row, reason = 'Verification timed out without SMS') {
    if (['completed', 'refunded'].includes(row.status)) return;

    try {
        const currentBalance = getWalletBalance(row.user_id);
        const refundAmount = row.cost_ngn;
        const newBalance = Math.round((currentBalance + refundAmount) * 100) / 100;
        const refundRef = `REF-EXP-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

        db.transaction(() => {
            db.prepare(`
                INSERT INTO wallet_transactions
                (user_id, type, amount, balance_before, balance_after, reference, status, payment_channel, description, metadata)
                VALUES (?, 'refund', ?, ?, ?, ?, 'successful', 'auto_refund', ?, ?)
            `).run(
                row.user_id,
                refundAmount,
                currentBalance,
                newBalance,
                refundRef,
                `Auto-Refund: ${row.service_name} (${reason})`,
                JSON.stringify({ verificationId: row.id, requestId: row.request_id, reason })
            );

            db.prepare(`
                UPDATE phone_verifications
                SET status = 'timed_out', updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(row.id);
        })();

        console.log(`[PhoneVerify] Auto-refunded ₦${refundAmount} to user #${row.user_id} for timed out verification #${row.id}`);
    } catch (e) {
        console.error('[PhoneVerify] Failed to auto-refund verification:', e);
    }
}

/**
 * Webhook handler for USPhoneVerify
 */
async function handleWebhookEvent(body) {
    const { event, id = '', reply = '', from = '', mdn = '' } = body;
    const reqId = String(id);

    if (!reqId) {
        return { status: false, message: 'Missing request id' };
    }

    const row = db.prepare(`SELECT * FROM phone_verifications WHERE request_id = ?`).get(reqId);
    if (!row) {
        console.warn(`[PhoneVerify Webhook] No local record found for request_id: ${reqId}`);
        return { status: true, message: 'Ignored (unknown request)' };
    }

    if (event === 'incoming_message') {
        const pin = body.pin || extractPinFromText(reply);
        const sender = from;

        db.prepare(`
            UPDATE phone_verifications
            SET status = 'completed',
                sms_reply = ?,
                otp_code = ?,
                sms_sender = ?,
                sms_received_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(reply, pin, sender, row.id);

        console.log(`✅ [PhoneVerify Webhook] SMS Received for User #${row.user_id} (${row.service_name}): PIN = ${pin}`);

        // Proactive notification via Telegram Bot if user has telegram linked
        try {
            const userRow = db.prepare('SELECT telegram_id FROM users WHERE id = ?').get(row.user_id);
            if (userRow && userRow.telegram_id && pin) {
                const telegramBot = require('./telegramBot');
                telegramBot.notifyUserOtpReceived({
                    telegramId: userRow.telegram_id,
                    service: row.service_name,
                    phoneNumber: row.phone_number,
                    formattedNumber: formatUsPhoneNumber(row.phone_number),
                    otpCode: pin,
                    smsReply: reply,
                    verificationId: row.id
                }).catch(err => console.warn('[PhoneVerify Webhook] Error sending Telegram OTP notification:', err.message));
            }
        } catch (notifyErr) {
            console.warn('[PhoneVerify Webhook] Failed to notify Telegram user:', notifyErr.message);
        }

        return { status: true, message: 'SMS recorded' };
    }

    if (event === 'priority_request') {
        const mdn = body.mdn || '';
        db.prepare(`
            UPDATE phone_verifications
            SET phone_number = ?,
                status = 'reserved',
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(mdn, row.id);

        console.log(`✅ [PhoneVerify Webhook] Priority Request Assigned MDN: ${mdn} for #${row.id}`);
        return { status: true, message: 'MDN assigned' };
    }

    return { status: true, message: 'Unhandled event' };
}

/**
 * Gets user's past and active verifications
 */
function getUserVerifications(userId, limit = 50) {
    const rows = db.prepare(`
        SELECT * FROM phone_verifications
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT ?
    `).all(userId, limit);

    return rows.map(formatVerificationRow);
}

/**
 * Gets currently active verification for a user (if any)
 */
function getActiveVerification(userId) {
    const row = db.prepare(`
        SELECT * FROM phone_verifications
        WHERE user_id = ?
          AND status IN ('reserved', 'awaiting_mdn')
        ORDER BY created_at DESC
        LIMIT 1
    `).get(userId);

    if (!row) return null;

    // Check if expired
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
        autoRefundVerification(row);
        return null;
    }

    return formatVerificationRow(row);
}

/**
 * Helper to format phone number into clean US display format (+1 (XXX) XXX-XXXX)
 */
function formatUsPhoneNumber(num) {
    if (!num) return '';
    const clean = String(num).replace(/\D/g, '');
    let digits = clean;
    if (digits.length === 11 && digits.startsWith('1')) {
        digits = digits.substring(1);
    }
    if (digits.length === 10) {
        return `+1 (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    }
    return `+${clean}`;
}

/**
 * Helper to parse PIN / code from raw SMS text if not already parsed
 */
function extractPinFromText(text) {
    if (!text) return null;
    // Matches G-123456, 123456, 123-456, etc.
    const match = text.match(/\b([A-Z0-9]{1,3}-?[0-9]{4,8})\b/i);
    return match ? match[1] : null;
}

/**
 * Formats a DB row into a clean frontend response
 */
function formatVerificationRow(r) {
    const remainingSeconds = r.expires_at
        ? Math.max(0, Math.floor((new Date(r.expires_at).getTime() - Date.now()) / 1000))
        : 0;

    return {
        id: r.id,
        requestId: r.request_id,
        service: r.service_name,
        phoneNumber: r.phone_number,
        formattedNumber: r.phone_number ? formatUsPhoneNumber(r.phone_number) : null,
        carrier: r.carrier,
        state: r.state,
        costNgn: r.cost_ngn,
        costFormatted: `₦${Number(r.cost_ngn).toLocaleString()}`,
        status: r.status,
        smsReply: r.sms_reply,
        otpCode: r.otp_code,
        smsSender: r.sms_sender,
        smsReceivedAt: r.sms_received_at,
        expiresAt: r.expires_at,
        remainingSeconds,
        createdAt: r.created_at
    };
}

module.exports = {
    getSettings,
    updateSetting,
    calculateNgnPrice,
    getProviderBalance,
    listServices,
    requestNumber,
    getVerificationStatus,
    cancelAndRefund,
    autoRefundVerification,
    handleWebhookEvent,
    getUserVerifications,
    getActiveVerification,
    formatUsPhoneNumber,
    POPULAR_SERVICES_METADATA
};
