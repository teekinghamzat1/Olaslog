const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { checkoutCart } = require('../services/order');
const db = require('../db');
const telegram = require('../services/telegram');

// Checkout Cart
router.post('/', authenticate, async (req, res) => {
    try {
        const { items } = req.body;
        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ success: false, error: 'Shopping cart is empty' });
        }

        const orderResult = await checkoutCart(req.user.id, items);

        // Telegram admin alert (non-blocking)
        try {
            const userRow = db.prepare(`SELECT full_name, email FROM users WHERE id = ?`).get(req.user.id);
            const order   = orderResult.order || orderResult;
            telegram.notifyNewOrder({
                fullName:    userRow?.full_name || 'Unknown',
                email:       userRow?.email    || 'N/A',
                userId:      req.user.id,
                orderNumber: order.order_number || order.orderNumber || order.id || '—',
                totalAmount: order.total_amount || order.totalAmount || 0,
                itemCount:   items.length,
                orderId:     order.id
            }).catch(() => {});
        } catch (_) {}

        return res.status(201).json({
            success: true,
            message: 'Order completed and credentials delivered instantly!',
            data: orderResult
        });
    } catch (err) {
        if (err.code === 'INSUFFICIENT_FUNDS') {
            return res.status(402).json({
                success: false,
                code: 'INSUFFICIENT_FUNDS',
                error: 'Insufficient wallet balance to complete this purchase.',
                shortfall: err.shortfall,
                required: err.required,
                currentBalance: err.currentBalance,
                fundingUrl: '/#wallet'
            });
        }

        if (err.code === 'OUT_OF_STOCK') {
            return res.status(400).json({
                success: false,
                code: 'OUT_OF_STOCK',
                error: err.message
            });
        }

        console.error('Checkout error:', err);
        return res.status(400).json({ success: false, error: err.message || 'Checkout failed' });
    }
});

module.exports = router;
