const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { checkoutCart } = require('../services/order');

// Checkout Cart
router.post('/', authenticate, async (req, res) => {
    try {
        const { items } = req.body;
        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ success: false, error: 'Shopping cart is empty' });
        }

        const orderResult = await checkoutCart(req.user.id, items);

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
