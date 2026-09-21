const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { getOrderWithCredentials } = require('../services/order');

// Setup multer storage for dispute screenshots/proof
const uploadDir = path.resolve(__dirname, '../../uploads/disputes');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        const ext = path.extname(file.originalname) || '.png';
        cb(null, `proof-${uniqueSuffix}${ext}`);
    }
});
const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB max
});

// List User Orders
router.get('/', authenticate, (req, res) => {
    try {
        const orders = db.prepare(`
            SELECT 
                o.id,
                o.order_number,
                o.total_amount,
                o.status,
                o.created_at,
                (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) as item_count,
                (SELECT d.status FROM disputes d WHERE d.order_id = o.id) as dispute_status
            FROM orders o
            WHERE o.user_id = ?
            ORDER BY o.created_at DESC
        `).all(req.user.id);

        return res.json({ success: true, orders });
    } catch (err) {
        console.error('Fetch orders error:', err);
        return res.status(500).json({ success: false, error: 'Failed to fetch order history' });
    }
});

// Get Single Order with Decrypted Credentials
router.get('/:id', authenticate, (req, res) => {
    try {
        const order = getOrderWithCredentials(req.params.id, req.user.id);
        if (!order) {
            return res.status(404).json({ success: false, error: 'Order not found' });
        }

        return res.json({ success: true, order });
    } catch (err) {
        console.error('Fetch order detail error:', err);
        return res.status(500).json({ success: false, error: 'Failed to fetch order details' });
    }
});

// File a Dispute / Report Defective Credentials
router.post('/:id/dispute', authenticate, upload.single('proofImage'), (req, res) => {
    try {
        const orderId = req.params.id;
        const { reason } = req.body;

        if (!reason || reason.trim().length < 10) {
            return res.status(400).json({ success: false, error: 'Please provide a detailed reason (at least 10 characters)' });
        }

        // Verify order ownership
        const order = db.prepare(`SELECT * FROM orders WHERE id = ? AND user_id = ?`).get(orderId, req.user.id);
        if (!order) {
            return res.status(404).json({ success: false, error: 'Order not found' });
        }

        // Check if dispute already exists
        const existing = db.prepare(`SELECT id, status FROM disputes WHERE order_id = ?`).get(orderId);
        if (existing) {
            return res.status(400).json({
                success: false,
                error: `A dispute for this order is already ${existing.status.replace('_', ' ')}`
            });
        }

        let proofImagePath = null;
        if (req.file) {
            proofImagePath = `/uploads/disputes/${req.file.filename}`;
        }

        const result = db.prepare(`
            INSERT INTO disputes (order_id, user_id, reason, proof_image_path, status)
            VALUES (?, ?, ?, ?, 'submitted')
        `).run(orderId, req.user.id, reason.trim(), proofImagePath);

        return res.status(201).json({
            success: true,
            message: 'Dispute report submitted successfully. Our admin team will inspect the proof and update your ticket.',
            dispute: {
                id: result.lastInsertRowid,
                orderId,
                status: 'submitted',
                reason: reason.trim(),
                proofImagePath
            }
        });
    } catch (err) {
        console.error('Dispute submission error:', err);
        return res.status(500).json({ success: false, error: 'Failed to submit dispute report' });
    }
});

module.exports = router;
