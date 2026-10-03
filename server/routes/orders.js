const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { getOrderWithCredentials } = require('../services/order');
const { encrypt } = require('../services/crypto');
const sujanService = require('../services/sujan');

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

// ─── Public Live Order Feed (no auth required) ───────────────────────────────
// GET /api/orders/feed
// Returns the last 20 completed orders, fully anonymized — safe for public display.
router.get('/feed', (req, res) => {
    try {
        const feed = db.prepare(`
            SELECT
                o.id,
                o.created_at,
                oi.quantity,
                p.name  AS product_name,
                p.price AS unit_price,
                COALESCE(c.icon, '🛍️')  AS category_icon,
                COALESCE(c.name, 'Digital')  AS category_name
            FROM orders o
            JOIN order_items oi ON oi.order_id = o.id
            JOIN products    p  ON p.id = oi.product_id
            LEFT JOIN product_categories c ON c.id = p.category_id
            WHERE o.status = 'completed'
            ORDER BY o.created_at DESC
            LIMIT 20
        `).all();

        return res.json({ success: true, feed });
    } catch (err) {
        console.error('Order feed error:', err);
        return res.status(500).json({ success: false, feed: [] });
    }
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

        const proofImagePath = req.file ? `/uploads/disputes/${req.file.filename}` : null;

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

// Sujan Logs Marketplace Webhook Handler (order.completed)
// POST /api/orders/webhook
router.post('/webhook', async (req, res) => {
    try {
        const rawBody = JSON.stringify(req.body);
        const signature = req.headers['x-sujan-signature'] ?? req.headers['x-signature'] ?? req.headers['signature'];
        const webhookSecret = process.env.SUJAN_WEBHOOK_SECRET;

        // If webhook secret is configured, enforce signature verification
        if (webhookSecret && signature) {
            const isValid = sujanService.verifyWebhookSignature(rawBody, signature, webhookSecret);
            if (!isValid) {
                return res.status(400).json({ success: false, error: 'Invalid webhook signature' });
            }
        }

        const event = req.body;
        // Handle order.completed event
        if (event?.event === 'order.completed' || event?.data?.status === 'completed') {
            const orderData = event.data || event;
            const sujanOrderId = String(orderData?.id ?? orderData?.order_id ?? '');

            if (sujanOrderId) {
                // Find matching order in DB
                const localOrder = db.prepare(`
                    SELECT id FROM orders 
                    WHERE sujan_order_id = ? OR rakib_order_id = ?
                `).get(sujanOrderId, sujanOrderId);

                if (localOrder && Array.isArray(orderData.items) && orderData.items.length > 0) {
                    const orderId = localOrder.id;

                    // Ensure items have credentials recorded
                    for (const item of orderData.items) {
                        const rawCred = item.credential || item.key;
                        if (!rawCred) continue;

                        // Check if already stored
                        const existingCred = db.prepare(`
                            SELECT id FROM delivered_credentials
                            WHERE order_id = ? AND (sujan_item_id = ? OR sujan_item_id = ?)
                        `).get(orderId, String(item.id || ''), String(sujanOrderId));

                        if (!existingCred) {
                            const enc = encrypt(rawCred);
                            const publicData = item.public_data || `Account #${item.id || 'AUTO'}`;

                            // Find order_item_id for this product
                            const orderItem = db.prepare(`
                                SELECT oi.id FROM order_items oi
                                JOIN products p ON oi.product_id = p.id
                                WHERE oi.order_id = ? AND (p.sujan_product_id = ? OR p.rakib_product_id = ?)
                                LIMIT 1
                            `).get(orderId, item.product_id, item.product_id);

                            db.prepare(`
                                INSERT INTO delivered_credentials
                                (order_id, order_item_id, product_id, stock_item_id, sujan_item_id, public_data, encrypted_credential, iv, auth_tag)
                                VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)
                            `).run(
                                orderId,
                                orderItem ? orderItem.id : null,
                                orderItem ? orderItem.product_id : null,
                                item.id || sujanOrderId,
                                publicData,
                                enc.encrypted,
                                enc.iv,
                                enc.authTag
                            );
                        }
                    }

                    // Update order status to completed
                    db.prepare(`UPDATE orders SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(orderId);
                }
            }
        }

        return res.status(200).json({ success: true, message: 'Webhook processed successfully' });
    } catch (err) {
        console.error('Sujan Webhook processing error:', err);
        return res.status(500).json({ success: false, error: 'Internal webhook error' });
    }
});

module.exports = router;
