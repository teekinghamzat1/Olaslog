'use strict';

const db = require('../db');
const { getWalletBalance, getLedgerBalance, getReservedBalance } = require('./wallet');

const API_ENDPOINT = 'https://www.usphoneverify.com/api_command.php';

// In-memory cache for provider service list (5 minutes TTL)
let servicesCache = null;
let servicesCacheTime = 0;
let servicesCachePricingKey = null;
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
        const usdRate = parseFloat(map.usd_rate || process.env.USPHONEVERIFY_USD_RATE || '2000');
        const marginPercent = parseFloat(map.margin_percent || process.env.USPHONEVERIFY_MARGIN_PERCENT || '25');
        const minPriceNgn = parseFloat(map.min_price_ngn || process.env.USPHONEVERIFY_MIN_PRICE || '800');

        return {
            user,
            apiKey,
            usdRate: isNaN(usdRate) || usdRate <= 0 ? 2000 : usdRate,
            marginPercent: isNaN(marginPercent) || marginPercent < 0 ? 25 : marginPercent,
            minPriceNgn: isNaN(minPriceNgn) || minPriceNgn <= 0 ? 800 : minPriceNgn,
            isConfigured: Boolean(user && apiKey)
        };
    } catch (e) {
        return {
            user: process.env.USPHONEVERIFY_USER || '',
            apiKey: process.env.USPHONEVERIFY_API_KEY || '',
            usdRate: 2000,
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

    // Cached service entries contain NGN prices, so invalidate them whenever
    // a setting that affects verification pricing changes.
    if (['usd_rate', 'margin_percent', 'min_price_ngn'].includes(key)) {
        servicesCache = null;
        servicesCacheTime = 0;
        servicesCachePricingKey = null;
    }
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
    const pricingKey = `${s.usdRate}:${s.marginPercent}:${s.minPriceNgn}`;

    // Cached entries include converted NGN prices. Reuse them only while
    // both the TTL and the pricing settings remain unchanged.
    if (!forceRefresh && servicesCache && servicesCachePricingKey === pricingKey && (now - servicesCacheTime < CACHE_TTL_MS)) {
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
    servicesCachePricingKey = pricingKey;
    return enriched;
}

/**
 * Purchase / Request a verification phone number
 */
async function requestNumber({ userId, service, areacode, state, markup, mdn }) {
    if (!userId) throw new Error('User authentication required');
    if (!service) throw new Error('Service name is required');

    const s = getSettings();
    const services = await listServices();
    const serviceInfo = services.find(x => x.name.toLowerCase() === service.toLowerCase());
    const estimatedNgn = serviceInfo ? serviceInfo.priceNgn : calculateNgnPrice(0.60, s);
    const estimatedUsd = serviceInfo ? parseFloat(serviceInfo.usdPrice) : 0.60;

    const crypto = require('crypto');
    const attemptId = `phoneverify:${crypto.randomUUID()}`;
    const walletRef = `VER-REQ-${crypto.randomUUID()}`;
    let reservedAmount = estimatedNgn;

    // Reserve funds before contacting the provider. BEGIN IMMEDIATE serializes
    // competing requests so they cannot both spend the same available balance.
    const reserveFunds = db.transaction(() => {
        const ledger = getLedgerBalance(userId);
        const held = getReservedBalance(userId);
        const spendable = Math.round((ledger - held) * 100) / 100;
        if (spendable < estimatedNgn) {
            const err = new Error('Insufficient wallet balance to request this verification number');
            err.code = 'INSUFFICIENT_FUNDS';
            err.required = estimatedNgn;
            err.currentBalance = spendable;
            err.shortfall = Math.round((estimatedNgn - spendable) * 100) / 100;
            throw err;
        }
        db.prepare(`
            INSERT INTO wallet_reservations (checkout_id, user_id, amount, status)
            VALUES (?, ?, ?, 'active')
        `).run(attemptId, userId, estimatedNgn);
        db.prepare(`
            INSERT INTO phone_verification_attempts
            (attempt_id, user_id, service_name, reserved_amount, status, request_json)
            VALUES (?, ?, ?, ?, 'reserved', ?)
        `).run(attemptId, userId, service, estimatedNgn, JSON.stringify({ service, areacode, state, markup, mdn }));
    }).immediate;
    reserveFunds();

    const updateAttempt = (status, values = {}) => db.prepare(`
        UPDATE phone_verification_attempts
        SET status = ?, provider_request_id = COALESCE(?, provider_request_id),
            actual_amount = COALESCE(?, actual_amount), error_message = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE attempt_id = ?
    `).run(status, values.requestId || null, values.amount ?? null, values.error || null, attemptId);

    const releaseReservation = () => db.prepare(`
        UPDATE wallet_reservations SET status = 'released', updated_at = CURRENT_TIMESTAMP
        WHERE checkout_id = ? AND status = 'active'
    `).run(attemptId);

    const apiParams = { service };
    if (mdn) apiParams.mdn = mdn;
    if (areacode) apiParams.areacode = areacode;
    else if (state) apiParams.state = state;
    if (markup) apiParams.markup = markup;

    let apiRes;
    try {
        updateAttempt('provider_pending');
        apiRes = await callApi('request', apiParams);
    } catch (err) {
        // A timeout/network error does not prove the provider did not issue a number.
        updateAttempt('provider_uncertain', { error: err.message });
        const uncertain = new Error('The verification request could not be confirmed. Your wallet funds are temporarily held while we check its status. Please do not submit another request yet.');
        uncertain.code = 'PHONE_VERIFY_UNCERTAIN';
        throw uncertain;
    }

    if (!apiRes || apiRes.status !== 'ok') {
        releaseReservation();
        updateAttempt('failed', { error: typeof apiRes?.message === 'string' ? apiRes.message : 'Provider rejected the request' });
        const errorMsg = apiRes?.message || 'No verification numbers currently available for this service. Please retry in a few minutes.';
        throw new Error(typeof errorMsg === 'string' ? errorMsg : JSON.stringify(errorMsg));
    }

    if (!Array.isArray(apiRes.message) || apiRes.message.length === 0 || !apiRes.message[0] || apiRes.message[0].id == null) {
        updateAttempt('provider_uncertain', { error: 'Provider returned an incomplete success response without a request ID' });
        const uncertain = new Error('The provider response could not be confirmed. Your wallet funds are temporarily held. Please contact support before retrying.');
        uncertain.code = 'PHONE_VERIFY_UNCERTAIN';
        throw uncertain;
    }

    const item = apiRes.message[0];
    const requestId = String(item.id);
    const parsedUsd = Number.parseFloat(item.price);
    const actualUsdPrice = Number.isFinite(parsedUsd) && parsedUsd > 0 ? parsedUsd : estimatedUsd;
    const finalNgnPrice = calculateNgnPrice(actualUsdPrice, s);
    updateAttempt('provider_confirmed', { requestId, amount: finalNgnPrice });

    // Adjust the hold to the provider's actual price. If the extra amount is
    // unavailable, reject at the provider; retain the hold if rejection is unclear.
    const adjustHold = db.transaction(() => {
        const ledger = getLedgerBalance(userId);
        const heldByOthers = db.prepare(`
            SELECT COALESCE(SUM(amount), 0) AS amount FROM wallet_reservations
            WHERE user_id = ? AND status = 'active' AND checkout_id <> ?
        `).get(userId, attemptId).amount;
        const spendableBeforeThisHold = Math.round((ledger - heldByOthers - reservedAmount) * 100) / 100;
        if (finalNgnPrice > reservedAmount && spendableBeforeThisHold < finalNgnPrice) return false;
        db.prepare(`
            UPDATE wallet_reservations SET amount = ?, updated_at = CURRENT_TIMESTAMP
            WHERE checkout_id = ? AND status = 'active'
        `).run(finalNgnPrice, attemptId);
        reservedAmount = finalNgnPrice;
        return true;
    }).immediate;

    if (!adjustHold()) {
        try {
            const rejectRes = await callApi('reject', { id: requestId });
            if (rejectRes && rejectRes.status === 'ok') {
                releaseReservation();
                updateAttempt('rejected', { requestId, amount: finalNgnPrice, error: 'Actual price exceeded available wallet balance; provider rejection confirmed' });
            } else {
                updateAttempt('provider_uncertain', { requestId, amount: finalNgnPrice, error: 'Could not confirm provider rejection after actual price exceeded available balance' });
            }
        } catch (rejectError) {
            updateAttempt('provider_uncertain', { requestId, amount: finalNgnPrice, error: `Provider rejection uncertain: ${rejectError.message}` });
        }
        const err = new Error('The provider price is higher than your available wallet balance. The request is being checked before any held funds are released.');
        err.code = 'PHONE_VERIFY_UNCERTAIN';
        err.required = finalNgnPrice;
        throw err;
    }

    const tillSeconds = Math.max(1, parseInt(item.till_expiration || '900', 10) || 900);
    const expiresAt = new Date(Date.now() + tillSeconds * 1000).toISOString();
    const initialStatus = item.status === 'Awaiting MDN' || !item.mdn ? 'awaiting_mdn' : 'reserved';

    let localId;
    let newBalance;
    try {
        const commitPurchase = db.transaction(() => {
            const attempt = db.prepare(`
                SELECT status FROM wallet_reservations WHERE checkout_id = ? AND user_id = ?
            `).get(attemptId, userId);
            if (!attempt || attempt.status !== 'active') throw new Error('Wallet reservation is no longer active');

            const ledgerBalance = getLedgerBalance(userId);
            const allReservations = getReservedBalance(userId);
            const ledgerAvailable = Math.round((ledgerBalance - allReservations) * 100) / 100;
            if (ledgerAvailable < 0) throw new Error('Wallet balance changed while verification was being processed');

            newBalance = Math.round((ledgerBalance - finalNgnPrice) * 100) / 100;
            db.prepare(`
                INSERT INTO wallet_transactions
                (user_id, type, amount, balance_before, balance_after, reference, status, payment_channel, description, metadata)
                VALUES (?, 'purchase', ?, ?, ?, ?, 'successful', 'wallet', ?, ?)
            `).run(
                userId, finalNgnPrice, ledgerBalance, newBalance, walletRef,
                `US Phone Verification: ${service}`,
                JSON.stringify({ requestId, service, mdn: item.mdn, priceUsd: actualUsdPrice, priceNgn: finalNgnPrice, attemptId })
            );

            const result = db.prepare(`
                INSERT INTO phone_verifications
                (user_id, request_id, service_name, phone_number, state, areacode, carrier, markup, cost_usd, cost_ngn, wallet_ref, status, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                userId, requestId, service, item.mdn || null, item.state || state || null,
                areacode || null, item.carrier || null, parseInt(item.markup || '0', 10),
                actualUsdPrice, finalNgnPrice, walletRef, initialStatus, expiresAt
            );
            localId = result.lastInsertRowid;
            db.prepare(`
                UPDATE wallet_reservations SET status = 'committed', updated_at = CURRENT_TIMESTAMP
                WHERE checkout_id = ? AND status = 'active'
            `).run(attemptId);
            db.prepare(`
                UPDATE phone_verification_attempts SET status = 'completed', updated_at = CURRENT_TIMESTAMP
                WHERE attempt_id = ?
            `).run(attemptId);
        }).immediate;
        commitPurchase();
    } catch (err) {
        // Provider has issued a number. Keep the reservation and attempt for support recovery.
        updateAttempt('provider_uncertain', { requestId, amount: finalNgnPrice, error: `Local save failed after provider confirmation: ${err.message}` });
        const uncertain = new Error('The provider issued a number, but Olaslog could not finish saving the purchase. Your funds remain held while support resolves it.');
        uncertain.code = 'PHONE_VERIFY_UNCERTAIN';
        throw uncertain;
    }

    startVerificationPoller();
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
        newBalance: getWalletBalance(userId)
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
            if (apiRes && apiRes.status === 'ok') {
                const pStatus = Array.isArray(apiRes.message) ? apiRes.message[0] : (apiRes.message || {});
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
                } else {
                    // Proactive check: Even if provider status hasn't moved to 'completed',
                    // check if SMS is already available in read_sms
                    const smsFound = await fetchAndStoreSMS(row);
                    if (smsFound) {
                        row = db.prepare(`SELECT * FROM phone_verifications WHERE id = ?`).get(id);
                    }
                }
            } else {
                // If request_status returned unexpected format, check read_sms directly as fallback
                const smsFound = await fetchAndStoreSMS(row);
                if (smsFound) {
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
        let msg = null;

        // 1. Try reading with request_id
        if (row.request_id) {
            const smsRes = await callApi('read_sms', { id: row.request_id });
            if (smsRes && smsRes.status === 'ok') {
                const list = Array.isArray(smsRes.message) ? smsRes.message : (smsRes.message ? [smsRes.message] : []);
                if (list.length > 0 && list[0] && (list[0].reply || list[0].pin)) {
                    msg = list[0];
                }
            }
        }

        // 2. Fallback: Try reading with MDN
        if (!msg && row.phone_number) {
            const smsRes = await callApi('read_sms', { mdn: row.phone_number });
            if (smsRes && smsRes.status === 'ok') {
                const list = Array.isArray(smsRes.message) ? smsRes.message : (smsRes.message ? [smsRes.message] : []);
                if (list.length > 0 && list[0] && (list[0].reply || list[0].pin)) {
                    msg = list[0];
                }
            }
        }

        // 3. Fallback: Query all recent messages and match by phone number
        if (!msg && row.phone_number) {
            const smsRes = await callApi('read_sms', {});
            if (smsRes && smsRes.status === 'ok' && Array.isArray(smsRes.message)) {
                const cleanPhone = String(row.phone_number).replace(/\D/g, '');
                msg = smsRes.message.find(m => {
                    if (!m || !m.to) return false;
                    const cleanTo = String(m.to).replace(/\D/g, '');
                    return cleanPhone.endsWith(cleanTo) || cleanTo.endsWith(cleanPhone);
                });
            }
        }

        if (msg) {
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

            console.log(`✅ [PhoneVerify] SMS Successfully Saved for User #${row.user_id} (${row.service_name}): PIN = ${pin}`);

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

            return true;
        }
    } catch (e) {
        console.warn('[PhoneVerify] Error reading SMS:', e.message);
    }
    return false;
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

    // Do not refund unless the provider confirms the number was rejected.
    let rejectResult;
    try {
        rejectResult = await callApi('reject', { id: row.request_id });
    } catch (e) {
        const err = new Error('The provider cancellation could not be confirmed. No refund has been issued yet; please try again or contact support.');
        err.code = 'PHONE_VERIFY_UNCERTAIN';
        throw err;
    }
    if (!rejectResult || rejectResult.status !== 'ok') {
        const err = new Error('The provider has not confirmed cancellation. No refund has been issued.');
        err.code = 'PHONE_VERIFY_UNCERTAIN';
        throw err;
    }

    // Perform atomic, one-time refund in user's wallet
    const targetUserId = row.user_id;
    const currentBalance = getWalletBalance(targetUserId);
    const refundAmount = row.cost_ngn;
    const newBalance = Math.round((currentBalance + refundAmount) * 100) / 100;
    const refundRef = `REF-VER-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

    const executeRefund = db.transaction(() => {
        const current = db.prepare('SELECT status FROM phone_verifications WHERE id = ?').get(row.id);
        if (!current || ['completed', 'rejected', 'refunded', 'timed_out'].includes(current.status)) {
            return false;
        }
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

        const update = db.prepare(`
            UPDATE phone_verifications
            SET status = 'refunded', updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status IN ('reserved', 'awaiting_mdn')
        `).run(row.id);
        if (update.changes !== 1) throw new Error('Verification was already resolved; refund was not repeated');
        return true;
    }).immediate;

    if (!executeRefund()) {
        const latest = db.prepare('SELECT * FROM phone_verifications WHERE id = ?').get(row.id);
        return { success: true, alreadyRefunded: true, verification: formatVerificationRow(latest), balance: getWalletBalance(targetUserId) };
    }

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

        // Notify Telegram user if account is linked
        try {
            const userRow = db.prepare('SELECT telegram_id FROM users WHERE id = ?').get(row.user_id);
            if (userRow && userRow.telegram_id) {
                const telegramBot = require('./telegramBot');
                telegramBot.notifyUserVerificationExpired({
                    telegramId: userRow.telegram_id,
                    service: row.service_name,
                    phoneNumber: row.phone_number,
                    formattedNumber: formatUsPhoneNumber(row.phone_number),
                    refundAmount
                }).catch(err => console.warn('[PhoneVerify] Error sending Telegram refund notification:', err.message));
            }
        } catch (notifyErr) {
            console.warn('[PhoneVerify] Failed to notify Telegram user of refund:', notifyErr.message);
        }
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

let pollerInterval = null;
let isPollingActive = false;

/**
 * Checks all active / pending verifications in DB and polls provider for incoming SMS
 */
async function pollPendingVerifications() {
    if (isPollingActive) return;
    isPollingActive = true;

    try {
        const activeRows = db.prepare(`
            SELECT id, request_id, user_id, service_name, phone_number, status, expires_at
            FROM phone_verifications
            WHERE status IN ('reserved', 'awaiting_mdn')
        `).all();

        if (!activeRows || activeRows.length === 0) {
            return;
        }

        for (const r of activeRows) {
            try {
                // getVerificationStatus will check provider, call fetchAndStoreSMS, notify via Telegram, or auto-refund on expiration
                await getVerificationStatus(r.id);
            } catch (err) {
                console.warn(`[PhoneVerify Poller] Check error for #${r.id}:`, err.message);
            }
        }
    } catch (e) {
        console.warn('[PhoneVerify Poller] Error:', e.message);
    } finally {
        isPollingActive = false;
    }
}

/**
 * Starts background poller (runs every 6 seconds)
 */
function startVerificationPoller() {
    if (pollerInterval) return;
    console.log('🔄 [PhoneVerify Poller] Background SMS checker started (running every 6s)');
    pollerInterval = setInterval(pollPendingVerifications, 6000);
    // Run an immediate pass
    pollPendingVerifications().catch(() => {});
}

function stopVerificationPoller() {
    if (pollerInterval) {
        clearInterval(pollerInterval);
        pollerInterval = null;
        console.log('[PhoneVerify Poller] Background SMS checker stopped');
    }
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
    startVerificationPoller,
    stopVerificationPoller,
    pollPendingVerifications,
    POPULAR_SERVICES_METADATA
};
