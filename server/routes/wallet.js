const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { getWalletBalance, getTransactions } = require('../services/wallet');
const { initializeFunding, verifyTransaction, verifyWebhookSignature, MIN_FUNDING } = require('../services/paystack');

// Get current wallet balance
router.get('/balance', authenticate, (req, res) => {
    const balance = getWalletBalance(req.user.id);
    return res.json({
        success: true,
        currency: 'NGN',
        balance
    });
});

// Get user wallet transaction ledger
router.get('/transactions', authenticate, (req, res) => {
    try {
        const limit = parseInt(req.query.limit || '50', 10);
        const transactions = getTransactions(req.user.id, limit);
        return res.json({
            success: true,
            transactions: transactions.map(t => ({
                id: t.id,
                type: t.type,
                amount: t.amount,
                balanceBefore: t.balance_before,
                balanceAfter: t.balance_after,
                reference: t.reference,
                status: t.status,
                paymentChannel: t.payment_channel,
                description: t.description,
                createdAt: t.created_at
            }))
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Failed to fetch transactions' });
    }
});

// Initiate wallet funding
router.post('/fund', authenticate, async (req, res) => {
    try {
        const amount = parseFloat(req.body.amount);
        if (isNaN(amount) || amount < MIN_FUNDING) {
            return res.status(400).json({
                success: false,
                error: `Minimum wallet funding amount is ₦${MIN_FUNDING.toLocaleString()}`
            });
        }

        const callbackUrl = req.body.callbackUrl || `${req.protocol}://${req.get('host')}/wallet.html`;
        const result = await initializeFunding(req.user.id, req.user.email, amount, callbackUrl);

        return res.json({
            success: true,
            message: 'Funding transaction initialized',
            data: result
        });
    } catch (err) {
        console.error('Wallet funding init error:', err);
        return res.status(400).json({ success: false, error: err.message || 'Failed to initialize funding' });
    }
});

// Verify transaction server-side
router.post('/verify/:reference', authenticate, async (req, res) => {
    try {
        const { reference } = req.params;
        const result = await verifyTransaction(reference);

        return res.json({
            success: true,
            message: 'Transaction verified successfully',
            balance: result.balance,
            alreadyProcessed: result.alreadyProcessed
        });
    } catch (err) {
        console.error('Wallet verify error:', err);
        return res.status(400).json({ success: false, error: err.message || 'Verification failed' });
    }
});

// Paystack Webhook Handler
router.post('/webhook', (req, res) => {
    try {
        const signature = req.headers['x-paystack-signature'];
        const rawBody = JSON.stringify(req.body);

        // Verify webhook signature
        if (signature && !verifyWebhookSignature(rawBody, signature)) {
            return res.status(400).send('Invalid signature');
        }

        const event = req.body;
        if (event && event.event === 'charge.success') {
            const { reference } = event.data;
            if (reference) {
                verifyTransaction(reference);
            }
        }

        return res.status(200).send('Webhook processed');
    } catch (err) {
        console.error('Webhook error:', err);
        return res.status(500).send('Webhook processing error');
    }
});

module.exports = router;
