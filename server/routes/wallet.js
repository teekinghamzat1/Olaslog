const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { getWalletBalance, getTransactions } = require('../services/wallet');

const korapayService = require('../services/korapay');

// Get current wallet balance
router.get('/balance', authenticate, (req, res) => {
    const balance = getWalletBalance(req.user.id);
    return res.json({
        success: true,
        currency: 'NGN',
        balance
    });
});

// Get user dedicated Virtual Bank Account details
router.get('/virtual-account', authenticate, (req, res) => {
    try {
        const account = korapayService.getVirtualAccount(req.user.id);
        if (!account) {
            return res.json({
                success: true,
                hasAccount: false,
                needsBvn: true,
                message: 'No Virtual Bank Account generated yet. BVN is required.'
            });
        }

        return res.json({
            success: true,
            hasAccount: true,
            needsBvn: false,
            account: {
                accountName: account.account_name,
                accountNumber: account.account_number,
                bankName: account.bank_name,
                bankCode: account.bank_code,
                accountReference: account.account_reference,
                accountStatus: account.account_status,
                currency: account.currency,
                isMock: Boolean(account.is_mock)
            }
        });
    } catch (err) {
        console.error('Fetch virtual account error:', err);
        return res.status(500).json({ success: false, error: 'Failed to retrieve virtual bank account' });
    }
});

// Create user dedicated Virtual Bank Account with BVN & optional NIN
router.post('/virtual-account', authenticate, async (req, res) => {
    try {
        const { bvn, nin, bankCode } = req.body;
        const result = await korapayService.createOrGetVirtualAccount(req.user.id, { bvn, nin, bankCode });

        return res.json({
            success: true,
            isNew: result.isNew,
            message: result.isNew ? 'Virtual Bank Account created successfully' : 'Retrieved existing Virtual Bank Account',
            account: {
                accountName: result.data.account_name,
                accountNumber: result.data.account_number,
                bankName: result.data.bank_name,
                bankCode: result.data.bank_code,
                accountReference: result.data.account_reference,
                accountStatus: result.data.account_status,
                currency: result.data.currency,
                isMock: Boolean(result.data.is_mock)
            }
        });
    } catch (err) {
        console.error('Create virtual account error:', err);
        return res.status(400).json({ success: false, error: err.message || 'Failed to create virtual bank account' });
    }
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



// Initiate wallet funding via Korapay Standard Checkout (Cards, Bank Transfer, USSD)
router.post('/fund', authenticate, async (req, res) => {
    try {
        const amount = parseFloat(req.body.amount);
        if (isNaN(amount) || amount < 100) {
            return res.status(400).json({
                success: false,
                error: 'Minimum wallet funding amount is ₦100'
            });
        }

        const redirectUrl = req.body.redirectUrl || `${req.protocol}://${req.get('host')}/#wallet`;
        const result = await korapayService.initializeCheckout(
            req.user.id,
            req.user.email,
            req.user.full_name,
            amount,
            redirectUrl
        );

        return res.json({
            success: true,
            message: 'Korapay payment initialized',
            data: result
        });
    } catch (err) {
        console.error('Wallet funding init error:', err);
        return res.status(400).json({ success: false, error: err.message || 'Failed to initialize funding' });
    }
});

// Verify transaction server-side
router.get('/verify/:reference', authenticate, async (req, res) => {
    try {
        const { reference } = req.params;
        const result = await korapayService.verifyPayment(reference);

        return res.json({
            success: result.success,
            message: result.message,
            balance: result.balance,
            alreadyProcessed: result.alreadyProcessed,
            status: result.status
        });
    } catch (err) {
        console.error('Wallet verify error:', err);
        return res.status(400).json({ success: false, error: err.message || 'Verification failed' });
    }
});

// Korapay Webhook Handler
router.post('/webhook', async (req, res) => {
    try {
        const rawBody = JSON.stringify(req.body);
        const koraSignature = req.headers['x-korapay-signature'];

        if (koraSignature && !korapayService.verifyWebhookSignature(rawBody, koraSignature)) {
            return res.status(400).send('Invalid Korapay signature');
        }

        const event = req.body;
        if (event && event.event === 'charge.success' && event.data) {
            await korapayService.processIncomingPayment(event.data);
            return res.status(200).send('Korapay webhook processed successfully');
        }

        return res.status(200).send('Webhook received');
    } catch (err) {
        console.error('Webhook error:', err);
        return res.status(500).send('Webhook processing error');
    }
});

module.exports = router;

