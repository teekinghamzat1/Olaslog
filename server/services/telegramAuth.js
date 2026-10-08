'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');

/**
 * Validates Telegram WebApp initData string against Telegram Bot Token.
 * Specification: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * @param {string} initDataRaw - The raw initData string sent by window.Telegram.WebApp.initData
 * @param {string} botToken - The bot token from BotFather
 * @returns {{ valid: boolean, user?: object, authDate?: number, error?: string }}
 */
function validateTelegramInitData(initDataRaw, botToken) {
    if (!initDataRaw || typeof initDataRaw !== 'string') {
        return { valid: false, error: 'Missing initData parameter' };
    }

    if (!botToken) {
        return { valid: false, error: 'Telegram Bot Token is not configured' };
    }

    try {
        const urlParams = new URLSearchParams(initDataRaw);
        const hash = urlParams.get('hash');
        if (!hash) {
            return { valid: false, error: 'Missing hash in initData' };
        }

        urlParams.delete('hash');

        // Sort keys alphabetically and format as key=value\n
        const pairs = [];
        for (const [key, val] of urlParams.entries()) {
            pairs.push(`${key}=${val}`);
        }
        pairs.sort();
        const dataCheckString = pairs.join('\n');

        // HMAC-SHA-256 signature calculation:
        // secret_key = HMAC_SHA256("WebAppData", botToken)
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

        // Timing-safe comparison to prevent timing attacks
        const calculatedBuf = Buffer.from(calculatedHash, 'utf8');
        const hashBuf = Buffer.from(hash, 'utf8');
        if (calculatedBuf.length !== hashBuf.length || !crypto.timingSafeEqual(calculatedBuf, hashBuf)) {
            return { valid: false, error: 'Invalid HMAC signature' };
        }

        // Validate auth_date freshness (allow up to 24 hours)
        const authDate = parseInt(urlParams.get('auth_date'), 10);
        const now = Math.floor(Date.now() / 1000);
        if (isNaN(authDate) || now - authDate > 86400) {
            return { valid: false, error: 'initData has expired (older than 24 hours)' };
        }

        const userStr = urlParams.get('user');
        const userObj = userStr ? JSON.parse(userStr) : null;

        return {
            valid: true,
            user: userObj,
            authDate,
            rawParams: Object.fromEntries(urlParams.entries())
        };
    } catch (err) {
        return { valid: false, error: err.message };
    }
}

/**
 * Finds or creates an Olaslog user from validated Telegram user payload.
 *
 * @param {object} tgUser - { id, first_name, last_name, username, photo_url }
 * @returns {object} Olaslog user database record
 */
function findOrCreateTelegramUser(tgUser) {
    if (!tgUser || !tgUser.id) {
        throw new Error('Telegram user data requires an ID');
    }

    const telegramId = String(tgUser.id);
    const tgUsername = tgUser.username ? String(tgUser.username).trim() : null;
    const tgFirstName = tgUser.first_name ? String(tgUser.first_name).trim() : null;
    const tgPhotoUrl = tgUser.photo_url ? String(tgUser.photo_url).trim() : null;

    // 1. Look up existing user by telegram_id
    let existingUser = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);

    if (existingUser) {
        // Update profile details if changed
        db.prepare(`
            UPDATE users
            SET telegram_username = COALESCE(?, telegram_username),
                telegram_first_name = COALESCE(?, telegram_first_name),
                telegram_photo_url = COALESCE(?, telegram_photo_url),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(tgUsername, tgFirstName, tgPhotoUrl, existingUser.id);

        return db.prepare('SELECT * FROM users WHERE id = ?').get(existingUser.id);
    }

    // 2. Auto-provision a new user account linked to this Telegram ID
    const syntheticEmail = `tg_${telegramId}@olaslog.com`;
    const fullName = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') || tgUsername || `Telegram User #${telegramId}`;
    const randomPassword = crypto.randomBytes(24).toString('hex');
    const passwordHash = bcrypt.hashSync(randomPassword, 10);

    const result = db.prepare(`
        INSERT INTO users (
            email, password_hash, full_name, role, is_verified,
            telegram_id, telegram_username, telegram_first_name, telegram_photo_url
        ) VALUES (?, ?, ?, 'customer', 1, ?, ?, ?, ?)
    `).run(
        syntheticEmail,
        passwordHash,
        fullName,
        telegramId,
        tgUsername,
        tgFirstName,
        tgPhotoUrl
    );

    return db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
}

module.exports = {
    validateTelegramInitData,
    findOrCreateTelegramUser
};
