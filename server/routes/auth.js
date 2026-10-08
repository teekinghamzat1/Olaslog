const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const { authenticate, generateToken } = require('../middleware/auth');
const { getWalletBalance } = require('../services/wallet');
const emailService = require('../services/email');
const telegram = require('../services/telegram');
const telegramAuth = require('../services/telegramAuth');

// Register
router.post('/register', (req, res) => {
    try {
        const { email, password, fullName, phone } = req.body;
        if (!email || !password || !fullName) {
            return res.status(400).json({ success: false, error: 'Email, password, and full name are required' });
        }

        if (password.length < 6) {
            return res.status(400).json({ success: false, error: 'Password must be at least 6 characters long' });
        }

        const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email.toLowerCase().trim());
        if (existing) {
            return res.status(400).json({ success: false, error: 'An account with this email already exists' });
        }

        const passwordHash = bcrypt.hashSync(password, 10);
        const result = db.prepare(`
            INSERT INTO users (email, password_hash, full_name, phone, role, is_verified)
            VALUES (?, ?, ?, ?, 'customer', 1)
        `).run(email.toLowerCase().trim(), passwordHash, fullName.trim(), phone ? phone.trim() : null);

        const newUser = {
            id: result.lastInsertRowid,
            email: email.toLowerCase().trim(),
            full_name: fullName.trim(),
            phone: phone || null,
            role: 'customer'
        };

        const token = generateToken(newUser);
        res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });

        // Fire welcome email (non-blocking)
        emailService.sendWelcomeEmail({ email: newUser.email, fullName: newUser.full_name }).catch(() => {});

        // Fire Telegram notification (non-blocking)
        telegram.notifyNewRegistration({ fullName: newUser.full_name, email: newUser.email, id: newUser.id }).catch(() => {});

        return res.status(201).json({
            success: true,
            message: 'Registration successful',
            token,
            user: {
                id: newUser.id,
                email: newUser.email,
                fullName: newUser.full_name,
                role: newUser.role,
                balance: 0
            }
        });
    } catch (err) {
        console.error('Register error:', err);
        return res.status(500).json({ success: false, error: 'Failed to create account' });
    }
});

// Login
router.post('/login', (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ success: false, error: 'Email and password are required' });
        }

        const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email.toLowerCase().trim());
        if (!user) {
            return res.status(401).json({ success: false, error: 'Invalid email or password' });
        }

        if (user.is_banned) {
            return res.status(403).json({ success: false, error: 'Your account has been suspended by administration' });
        }

        const isMatch = bcrypt.compareSync(password, user.password_hash);
        if (!isMatch) {
            return res.status(401).json({ success: false, error: 'Invalid email or password' });
        }

        const token = generateToken(user);
        res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });

        const balance = getWalletBalance(user.id);

        return res.json({
            success: true,
            message: 'Login successful',
            token,
            user: {
                id: user.id,
                email: user.email,
                fullName: user.full_name,
                phone: user.phone,
                role: user.role,
                balance
            }
        });
    } catch (err) {
        console.error('Login error:', err);
        return res.status(500).json({ success: false, error: 'Authentication failed' });
    }
});

// Current Authenticated User & Live Balance
router.get('/me', authenticate, (req, res) => {
    const balance = getWalletBalance(req.user.id);
    return res.json({
        success: true,
        user: {
            id: req.user.id,
            email: req.user.email,
            fullName: req.user.full_name,
            phone: req.user.phone,
            role: req.user.role,
            isVerified: !!req.user.is_verified,
            telegramId: req.user.telegram_id,
            telegramUsername: req.user.telegram_username,
            balance
        }
    });
});

// Update Profile
router.post('/update-profile', authenticate, (req, res) => {
    try {
        const { fullName, phone } = req.body;
        if (!fullName) {
            return res.status(400).json({ success: false, error: 'Full name is required' });
        }

        db.prepare(`
            UPDATE users
            SET full_name = ?, phone = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(fullName.trim(), phone ? phone.trim() : null, req.user.id);

        return res.json({
            success: true,
            message: 'Profile updated successfully'
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Failed to update profile' });
    }
});

// Change Password
router.post('/change-password', authenticate, (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ success: false, error: 'Current and new password are required' });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ success: false, error: 'New password must be at least 6 characters' });
        }

        const user = db.prepare(`SELECT password_hash FROM users WHERE id = ?`).get(req.user.id);
        if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
            return res.status(400).json({ success: false, error: 'Current password is incorrect' });
        }

        const newHash = bcrypt.hashSync(newPassword, 10);
        db.prepare(`UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(newHash, req.user.id);

        return res.json({ success: true, message: 'Password changed successfully' });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Failed to change password' });
    }
});

// Request Password Reset Link
router.post('/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email || !email.includes('@')) {
            return res.status(400).json({ success: false, error: 'Please enter a valid email address' });
        }

        const user = db.prepare('SELECT id, email, full_name, is_banned FROM users WHERE email = ?').get(email.toLowerCase().trim());

        // Generic safe message to prevent email enumeration
        if (!user || user.is_banned) {
            return res.json({
                success: true,
                message: 'If an account exists with this email, a password reset link has been dispatched. Please check your inbox.'
            });
        }

        // Invalidate older unused reset tokens
        db.prepare('UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0').run(user.id);

        const resetToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

        db.prepare(`
            INSERT INTO password_resets (user_id, token, expires_at, used)
            VALUES (?, ?, ?, 0)
        `).run(user.id, resetToken, expiresAt);

        const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
        const resetUrl = `${appUrl}/#reset-password?token=${resetToken}`;

        try {
            await emailService.sendPasswordResetEmail(user, { resetUrl, token: resetToken });
        } catch (mailErr) {
            console.error('[Auth] Failed to send password reset email:', mailErr.message);
        }

        return res.json({
            success: true,
            message: 'If an account exists with this email, a password reset link has been dispatched. Please check your inbox.'
        });
    } catch (err) {
        console.error('Forgot password error:', err);
        return res.status(500).json({ success: false, error: 'Unable to process password reset request' });
    }
});

// Reset Password with Token
router.post('/reset-password', (req, res) => {
    try {
        const { token, newPassword } = req.body;
        if (!token) {
            return res.status(400).json({ success: false, error: 'Reset token is required' });
        }

        if (!newPassword || newPassword.length < 6) {
            return res.status(400).json({ success: false, error: 'New password must be at least 6 characters long' });
        }

        const resetRecord = db.prepare(`
            SELECT pr.*, u.id as user_id, u.email, u.full_name
            FROM password_resets pr
            JOIN users u ON u.id = pr.user_id
            WHERE pr.token = ? AND pr.used = 0
        `).get(token.trim());

        if (!resetRecord) {
            return res.status(400).json({ success: false, error: 'This password reset link is invalid or has already been used' });
        }

        const now = new Date();
        const expires = new Date(resetRecord.expires_at);
        if (now > expires) {
            return res.status(400).json({ success: false, error: 'This password reset link has expired. Please request a new one.' });
        }

        const passwordHash = bcrypt.hashSync(newPassword, 10);

        const executeReset = db.transaction(() => {
            db.prepare(`UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                .run(passwordHash, resetRecord.user_id);
            db.prepare(`UPDATE password_resets SET used = 1 WHERE id = ?`)
                .run(resetRecord.id);
        });

        executeReset();

        return res.json({
            success: true,
            message: 'Password reset successful! You can now log in with your new password.'
        });
    } catch (err) {
        console.error('Reset password error:', err);
        return res.status(500).json({ success: false, error: 'Failed to reset password' });
    }
});

// Logout
router.post('/logout', (req, res) => {
    res.clearCookie('token');
    return res.json({ success: true, message: 'Logged out successfully' });
});

// Telegram WebApp Authentication (1-Tap Login from Telegram Mini App)
router.post('/telegram-webapp', (req, res) => {
    try {
        const { initData } = req.body;
        if (!initData) {
            return res.status(400).json({ success: false, error: 'Telegram initData is required' });
        }

        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        if (!botToken) {
            return res.status(500).json({ success: false, error: 'Telegram Bot is not configured on this server' });
        }

        const validation = telegramAuth.validateTelegramInitData(initData, botToken);
        if (!validation.valid || !validation.user) {
            return res.status(401).json({
                success: false,
                error: validation.error || 'Invalid or expired Telegram WebApp authentication'
            });
        }

        // Provision or retrieve user matching this Telegram profile
        const user = telegramAuth.findOrCreateTelegramUser(validation.user);
        if (user.is_banned) {
            return res.status(403).json({ success: false, error: 'Your account has been suspended by administration' });
        }

        const token = generateToken(user);
        res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });

        const balance = getWalletBalance(user.id);

        return res.json({
            success: true,
            message: 'Telegram Mini App authenticated successfully',
            token,
            user: {
                id: user.id,
                email: user.email,
                fullName: user.full_name,
                role: user.role,
                telegramId: user.telegram_id,
                telegramUsername: user.telegram_username,
                telegramPhotoUrl: user.telegram_photo_url,
                balance
            }
        });
    } catch (err) {
        console.error('[Telegram WebApp Auth] Error:', err);
        return res.status(500).json({ success: false, error: 'Failed to authenticate via Telegram' });
    }
});

// Link Telegram Account to existing logged-in user
router.post('/telegram-link', authenticate, (req, res) => {
    try {
        const { initData } = req.body;
        if (!initData) {
            return res.status(400).json({ success: false, error: 'Telegram initData is required' });
        }

        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        const validation = telegramAuth.validateTelegramInitData(initData, botToken);
        if (!validation.valid || !validation.user) {
            return res.status(400).json({ success: false, error: validation.error || 'Invalid Telegram authentication' });
        }

        const tgId = String(validation.user.id);
        const existingLinked = db.prepare('SELECT id FROM users WHERE telegram_id = ? AND id != ?').get(tgId, req.user.id);
        if (existingLinked) {
            return res.status(409).json({ success: false, error: 'This Telegram account is already linked to another Olaslog user' });
        }

        db.prepare(`
            UPDATE users
            SET telegram_id = ?,
                telegram_username = COALESCE(?, telegram_username),
                telegram_first_name = COALESCE(?, telegram_first_name),
                telegram_photo_url = COALESCE(?, telegram_photo_url),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(
            tgId,
            validation.user.username || null,
            validation.user.first_name || null,
            validation.user.photo_url || null,
            req.user.id
        );

        return res.json({
            success: true,
            message: 'Telegram account linked successfully!',
            telegramId: tgId,
            telegramUsername: validation.user.username || null
        });
    } catch (err) {
        console.error('[Telegram Link] Error:', err);
        return res.status(500).json({ success: false, error: 'Failed to link Telegram account' });
    }
});

module.exports = router;
