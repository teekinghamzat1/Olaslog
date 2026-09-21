const jwt = require('jsonwebtoken');
const db = require('../db');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'olaslog_jwt_secret_key_prod_super_secure_2026';

function authenticate(req, res, next) {
    let token = null;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
        token = req.headers.authorization.split(' ')[1];
    } else if (req.cookies && req.cookies.token) {
        token = req.cookies.token;
    }

    if (!token) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = db.prepare(`SELECT id, email, full_name, phone, role, is_banned, is_verified FROM users WHERE id = ?`).get(decoded.id);

        if (!user) {
            return res.status(401).json({ success: false, error: 'User account no longer exists' });
        }

        if (user.is_banned) {
            return res.status(403).json({ success: false, error: 'Your account has been suspended' });
        }

        req.user = user;
        next();
    } catch (err) {
        return res.status(401).json({ success: false, error: 'Invalid or expired authentication token' });
    }
}

function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ success: false, error: 'Admin privileges required' });
    }
    next();
}

function generateToken(user) {
    return jwt.sign(
        { id: user.id, email: user.email, role: user.role },
        JWT_SECRET,
        { expiresIn: '7d' }
    );
}

module.exports = {
    authenticate,
    requireAdmin,
    generateToken
};
