const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { getWalletBalance, getTransactions } = require('../services/wallet');

const billstackService = require('../services/billstack');

// ─── Balance ──────────────────────────────────────────────────────────────────

// GET /api/wallet/balance
router.get('/balance', authenticate, (req, res) => {
    const balance = getWalletBalance(req.user.id);
    return res.json({
        success: true,
        currency: 'NGN',
        balance
    });
});

// ─── Virtual Account ──────────────────────────────────────────────────────────

/**
 * GET /api/wallet/virtual-account
 * Returns the user's first stored virtual bank account.
 */
router.get('/virtual-account', authenticate, (req, res) => {
    try {
        const account = billstackService.getVirtualAccount(req.user.id);
        const allAccounts = billstackService.getAllVirtualAccounts(req.user.id);

        if (!account) {
            return res.json({
                success: true,
                hasAccount: false,
                message: 'No Virtual Bank Account generated yet.'
            });
        }

        return res.json({
            success: true,
            hasAccount: true,
            account: formatAccount(account),
            accounts: allAccounts.map(formatAccount)
        });
    } catch (err) {
        console.error('[Wallet] Fetch virtual account error:', err);
        return res.status(500).json({ success: false, error: 'Failed to retrieve virtual bank account' });
    }
});

/**
 * POST /api/wallet/virtual-account
 * Create a BillStack dedicated virtual bank account for the authenticated user.
 *
 * Body:
 *   bankId   {string}  - One of: 9PSB, SAFEHAVEN, PROVIDUS, PALMPAY  (default: 9PSB)
 *   phone    {string}  - Customer phone number
 *   idType   {string}  - 'nin' or 'bvn'  (required for PALMPAY only)
 *   idNumber {string}  - The NIN/BVN value (required for PALMPAY only)
 */
router.post('/virtual-account', authenticate, async (req, res) => {
    try {
        const { bankId, phone, idType, idNumber } = req.body;
        const result = await billstackService.createOrGetVirtualAccount(req.user.id, { bankId, phone, idType, idNumber });

        return res.json({
            success: true,
            isNew: result.isNew,
            isMock: Boolean(result.isMock),
            message: result.isNew
                ? 'Virtual Bank Account created successfully'
                : 'Retrieved existing Virtual Bank Account',
            account: formatAccount(result.data),
            accounts: (result.accounts || []).map(formatAccount)
        });
    } catch (err) {
        console.error('[Wallet] Create virtual account error:', err);
        const statusCode = err.code === 'PALMPAY_ID_REQUIRED' ? 422 : 400;
        return res.status(statusCode).json({ success: false, error: err.message || 'Failed to create virtual bank account' });
    }
});

/**
 * GET /api/wallet/banks
 * Returns the list of supported BillStack banks.
 */
router.get('/banks', authenticate, (req, res) => {
    return res.json({
        success: true,
        banks: billstackService.SUPPORTED_BANKS,
        defaultBank: billstackService.DEFAULT_BANK
    });
});

// ─── Transactions ─────────────────────────────────────────────────────────────

// GET /api/wallet/transactions
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

// ─── Legacy Fallback Handlers ──────────────────────────────────────────────────

// POST /api/wallet/fund (Migration note: Direct checkout is replaced by Dedicated Virtual Accounts)
router.post('/fund', authenticate, (req, res) => {
    return res.status(400).json({
        success: false,
        error: 'Direct checkout has migrated to BillStack Dedicated Virtual Accounts. Please use the account number displayed in your wallet to transfer funds.'
    });
});

// GET /api/wallet/verify/:reference
router.get('/verify/:reference', authenticate, (req, res) => {
    return res.json({
        success: true,
        status: 'successful',
        message: 'Virtual bank account deposits are verified and credited automatically.'
    });
});

// ─── Webhook (BillStack) ──────────────────────────────────────────────────────

/**
 * POST /api/wallet/webhook
 *
 * BillStack sends PAYMENT_NOTIFICATION events when funds arrive in a virtual account.
 *
 * Signature verification uses the RAW request body (before JSON parsing) because
 * re-serialising with JSON.stringify() can change key order and break the HMAC.
 * The raw body is captured via the `verify` option in express.json() and stored on
 * req.rawBody — see server/index.js where the wallet webhook route is mounted
 * with rawBody capture enabled.
 *
 * Webhook MUST respond with 200 + { status: true, message: "successful" } quickly;
 * BillStack retries on any non-200 response.
 */
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    let rawBody;
    let event;

    try {
        // express.raw() gives us the Buffer; convert to string for HMAC
        rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : JSON.stringify(req.body);

        // Parse the event — we need this to decide what action to take
        event = JSON.parse(rawBody);
    } catch (parseErr) {
        console.error('[BillStack Webhook] Failed to parse body:', parseErr.message);
        return res.status(400).json({ status: false, message: 'Invalid JSON body' });
    }

    // Verify signature before any processing
    const signature = req.headers['x-wiaxy-signature-256'];
    const timestamp  = req.headers['x-wiaxy-timestamp'];

    if (signature && !billstackService.verifyWebhookSignature(rawBody, signature, timestamp)) {
        console.warn('[BillStack Webhook] Invalid signature — request rejected.');
        return res.status(400).json({ status: false, message: 'Invalid signature' });
    }

    // Acknowledge immediately (BillStack retries on non-200)
    res.status(200).json({ status: true, message: 'successful' });

    // Process asynchronously after responding
    setImmediate(async () => {
        try {
            if (event?.event === 'PAYMENT_NOTIFICATION' && event?.data) {
                const result = await billstackService.processIncomingPayment(event.data);
                console.log('[BillStack Webhook] Payment processed:', result.message,
                    '| User:', result.user?.id, '| Balance:', result.balance);
            } else {
                console.log('[BillStack Webhook] Unhandled event type:', event?.event);
            }
        } catch (err) {
            console.error('[BillStack Webhook] Processing error:', err.message);
        }
    });
});

// ─── Helper ───────────────────────────────────────────────────────────────────

function formatAccount(a) {
    if (!a) return null;
    return {
        accountName: a.account_name,
        accountNumber: a.account_number,
        bankName: a.bank_name,
        bankCode: a.bank_code,
        accountReference: a.account_reference,
        accountStatus: a.account_status,
        currency: a.currency,
        isMock: Boolean(a.is_mock),
        createdAt: a.created_at
    };
}

module.exports = router;
