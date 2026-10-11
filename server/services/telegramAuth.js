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

    // 2. Look up by telegram_username if pre-configured on a web account
    if (tgUsername) {
        const usernameMatch = db.prepare('SELECT * FROM users WHERE LOWER(telegram_username) = LOWER(?) AND telegram_id IS NULL').get(tgUsername);
        if (usernameMatch) {
            db.prepare(`
                UPDATE users
                SET telegram_id = ?,
                    telegram_first_name = COALESCE(?, telegram_first_name),
                    telegram_photo_url = COALESCE(?, telegram_photo_url),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(telegramId, tgFirstName, tgPhotoUrl, usernameMatch.id);

            return db.prepare('SELECT * FROM users WHERE id = ?').get(usernameMatch.id);
        }
    }

    // 3. Auto-provision a new user account linked to this Telegram ID
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

/**
 * Links a Telegram user to an existing web account via email and optional password
 *
 * @param {object} tgUser - { id, username, first_name, photo_url }
 * @param {string} email - Email of the account to link
 * @param {string} [password] - Password if the account has one configured
 * @returns {object} Linked user DB record
 */
function linkTelegramAccount(tgUser, email, password = null) {
    if (!tgUser || !tgUser.id) {
        throw new Error('Telegram user data requires an ID');
    }
    const cleanEmail = String(email || '').toLowerCase().trim();
    if (!cleanEmail) {
        throw new Error('Please provide your website email address.');
    }

    const targetUser = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(cleanEmail);
    if (!targetUser) {
        throw new Error(`No account found on Olaslog with email "${cleanEmail}".`);
    }

    if (password) {
        const isMatch = bcrypt.compareSync(password, targetUser.password_hash);
        if (!isMatch) {
            throw new Error('Incorrect password for this account.');
        }
    }

    const telegramId = String(tgUser.id);
    const tgUsername = tgUser.username ? String(tgUser.username).trim() : null;
    const tgFirstName = tgUser.first_name ? String(tgUser.first_name).trim() : null;
    const tgPhotoUrl = tgUser.photo_url ? String(tgUser.photo_url).trim() : null;

    // If another account is currently linked to this Telegram ID, clean it up or unlink it
    const otherLinked = db.prepare('SELECT id, email FROM users WHERE telegram_id = ? AND id != ?').get(telegramId, targetUser.id);
    if (otherLinked) {
        if (otherLinked.email && otherLinked.email.startsWith('tg_')) {
            const txCount = db.prepare('SELECT COUNT(*) as c FROM wallet_transactions WHERE user_id = ?').get(otherLinked.id).c;
            const orderCount = db.prepare('SELECT COUNT(*) as c FROM orders WHERE user_id = ?').get(otherLinked.id).c;
            if (txCount === 0 && orderCount === 0) {
                db.prepare('DELETE FROM users WHERE id = ?').run(otherLinked.id);
            } else {
                db.prepare('UPDATE users SET telegram_id = NULL WHERE id = ?').run(otherLinked.id);
            }
        } else {
            db.prepare('UPDATE users SET telegram_id = NULL WHERE id = ?').run(otherLinked.id);
        }
    }

    db.prepare(`
        UPDATE users
        SET telegram_id = ?,
            telegram_username = COALESCE(?, telegram_username),
            telegram_first_name = COALESCE(?, telegram_first_name),
            telegram_photo_url = COALESCE(?, telegram_photo_url),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(telegramId, tgUsername, tgFirstName, tgPhotoUrl, targetUser.id);

    return db.prepare('SELECT * FROM users WHERE id = ?').get(targetUser.id);
}

module.exports = {
    validateTelegramInitData,
    findOrCreateTelegramUser,
    linkTelegramAccount
};
