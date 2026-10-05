const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authenticate, generateToken } = require('../middleware/auth');
const { getWalletBalance } = require('../services/wallet');
const emailService = require('../services/email');

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

// Logout
router.post('/logout', (req, res) => {
    res.clearCookie('token');
    return res.json({ success: true, message: 'Logged out successfully' });
});

module.exports = router;
