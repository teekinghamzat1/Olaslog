const crypto = require('crypto');
const db = require('../db');
const { getWalletBalance, recordFunding, completeFunding } = require('./wallet');
require('dotenv').config();

const BILLSTACK_SECRET_KEY = process.env.BILLSTACK_SECRET_KEY || '';
const BILLSTACK_BASE_URL = 'https://api.billstack.co/v2/thirdparty';

const isMock = !BILLSTACK_SECRET_KEY || BILLSTACK_SECRET_KEY.includes('mock') || BILLSTACK_SECRET_KEY === 'your_billstack_secret_key_here';

/**
 * Supported banks for BillStack virtual account generation.
 * One bank per request; call multiple times to offer multiple banks.
 */
const SUPPORTED_BANKS = [
    { id: '9PSB',      name: '9PSB Bank' },
    { id: 'SAFEHAVEN', name: 'Safehaven MFB' },
    { id: 'PROVIDUS',  name: 'Providus Bank' },
    { id: 'PALMPAY',   name: 'PalmPay Bank' }
];

// Default bank to use when none is specified
const DEFAULT_BANK = process.env.BILLSTACK_DEFAULT_BANK || '9PSB';

// ─── DB helpers ──────────────────────────────────────────────────────────────

/**
 * Retrieve a user's stored virtual account (first one found).
 * @param {number} userId
 */
function getVirtualAccount(userId) {
    const row = db.prepare(`
        SELECT id, user_id, account_name, account_number, bank_code, bank_name,
               account_reference, unique_id, account_status, currency, is_mock, created_at
        FROM user_virtual_accounts
        WHERE user_id = ?
        ORDER BY created_at ASC
        LIMIT 1
    `).get(userId);

    return row || null;
}

/**
 * Retrieve all virtual accounts for a user (multiple banks).
 * @param {number} userId
 */
function getAllVirtualAccounts(userId) {
    return db.prepare(`
        SELECT id, user_id, account_name, account_number, bank_code, bank_name,
               account_reference, unique_id, account_status, currency, is_mock, created_at
        FROM user_virtual_accounts
        WHERE user_id = ?
        ORDER BY created_at ASC
    `).all(userId);
}

// ─── API helpers ─────────────────────────────────────────────────────────────

/**
 * Internal fetch wrapper for BillStack API calls.
 */
async function billstackFetch(endpoint, body) {
    const url = `${BILLSTACK_BASE_URL}${endpoint}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${BILLSTACK_SECRET_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.status) {
        const err = new Error(data?.message || `BillStack API error (${response.status})`);
        err.status = response.status;
        err.details = data;
        throw err;
    }

    return data;
}

// ─── Virtual Account ──────────────────────────────────────────────────────────

/**
 * Create or retrieve a dedicated virtual bank account for a customer.
 *
 * BillStack does NOT require BVN. Instead it requires firstName, lastName, phone.
 * For PALMPAY bank, idType and idNumber (NIN or BVN) are required.
 *
 * @param {number} userId
 * @param {object} params
 * @param {string} [params.bankId]    - One of: 9PSB, SAFEHAVEN, PROVIDUS, PALMPAY
 * @param {string} [params.phone]     - Customer phone number (required)
 * @param {string} [params.idType]    - 'nin' or 'bvn' (required when bankId = PALMPAY)
 * @param {string} [params.idNumber]  - The NIN/BVN value (required when bankId = PALMPAY)
 */
async function createOrGetVirtualAccount(userId, { bankId, phone, idType, idNumber } = {}) {
    // 1. Return existing account if already created
    const existing = getAllVirtualAccounts(userId);
    if (existing.length > 0) {
        return {
            success: true,
            isNew: false,
            data: existing[0],
            accounts: existing
        };
    }

    // 2. Fetch user info
    const user = db.prepare(`SELECT id, email, full_name, phone FROM users WHERE id = ?`).get(userId);
    if (!user) throw new Error('User not found');

    const selectedBank = bankId || DEFAULT_BANK;
    const bankObj = SUPPORTED_BANKS.find(b => b.id === selectedBank) || SUPPORTED_BANKS[0];

    // 3. Validate PALMPAY-specific fields
    if (selectedBank === 'PALMPAY' && (!idType || !idNumber)) {
        const err = new Error('PalmPay bank requires idType (nin/bvn) and idNumber.');
        err.code = 'PALMPAY_ID_REQUIRED';
        throw err;
    }

    // 4. Split full_name into first/last
    const nameParts = (user.full_name || '').trim().split(/\s+/);
    const firstName = nameParts[0] || 'Customer';
    const lastName = nameParts.slice(1).join(' ') || firstName;

    const customerPhone = (phone || user.phone || '08000000000').trim();
    const accountReference = `OLAS-VBA-${userId}-${Date.now()}`;

    // 5. Live API call
    if (!isMock && process.env.NODE_ENV !== 'test') {
        try {
            const payload = {
                reference: accountReference,
                email: user.email,
                phone: customerPhone,
                firstName,
                lastName,
                bank: selectedBank,
                ...(selectedBank === 'PALMPAY' ? { idType, idNumber } : {})
            };

            const resData = await billstackFetch('/generateVirtualAccount/', payload);
            const d = resData.data;

            // BillStack returns an array of account objects
            const accounts = Array.isArray(d.account) ? d.account : [];
            const primaryAccount = accounts[0] || {};

            const stmt = db.prepare(`
                INSERT INTO user_virtual_accounts
                (user_id, account_name, account_number, bank_code, bank_name, account_reference, unique_id, account_status, currency, bvn, nin, is_mock)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            `);

            stmt.run(
                userId,
                primaryAccount.account_name || `${firstName} ${lastName}`,
                primaryAccount.account_number || '',
                primaryAccount.bank_id || selectedBank,
                primaryAccount.bank_name || bankObj.name,
                d.reference || accountReference,
                d.reference || null,
                'active',
                'NGN',
                (selectedBank === 'PALMPAY' && idType === 'bvn') ? idNumber : null,
                (selectedBank === 'PALMPAY' && idType === 'nin') ? idNumber : null
            );

            return {
                success: true,
                isNew: true,
                data: getVirtualAccount(userId),
                accounts: getAllVirtualAccounts(userId),
                billstackReference: d.reference
            };
        } catch (apiErr) {
            console.error('[BillStack] createVirtualAccount error:', apiErr.message);
            throw apiErr;
        }
    }

    // 6. Mock / Dev mode
    const mockAccountNumber = '70' + String(userId).padStart(3, '0') + Math.floor(10000 + Math.random() * 90000);
    const mockAccountName = `Olaslog / ${firstName} ${lastName}`;

    db.prepare(`
        INSERT INTO user_virtual_accounts
        (user_id, account_name, account_number, bank_code, bank_name, account_reference, unique_id, account_status, currency, bvn, nin, is_mock)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
        userId,
        mockAccountName,
        mockAccountNumber,
        bankObj.id,
        `${bankObj.name} (BillStack)`,
        accountReference,
        `billstack_mock_${Date.now()}`,
        'active',
        'NGN',
        null,
        null
    );

    return {
        success: true,
        isNew: true,
        isMock: true,
        data: getVirtualAccount(userId),
        accounts: getAllVirtualAccounts(userId)
    };
}

// ─── Webhook Signature ────────────────────────────────────────────────────────

/**
 * Verify the BillStack webhook signature.
 *
 * BillStack signs webhooks with HMAC-SHA256 over `"{timestamp}.{rawBody}"`
 * using your secret key, sent in the `x-wiaxy-signature-256` header.
 * The timestamp is in `x-wiaxy-timestamp`.
 *
 * IMPORTANT: rawBody must be the raw, unparsed request bytes — not re-serialised JSON.
 *
 * @param {string|Buffer} rawBody   - Raw, unparsed request body
 * @param {string}        signature - Value of `x-wiaxy-signature-256` header
 * @param {string}        timestamp - Value of `x-wiaxy-timestamp` header
 * @returns {boolean}
 */
function verifyWebhookSignature(rawBody, signature, timestamp) {
    if (!signature || !timestamp) return false;
    if (isMock) return true; // Accept all simulated webhooks in dev mode

    try {
        // Reject events older than 5 minutes (replay protection)
        if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
            console.warn('[BillStack Webhook] Stale event rejected. Timestamp:', timestamp);
            return false;
        }

        const signingString = `${timestamp}.${rawBody}`;
        const expected = crypto
            .createHmac('sha256', BILLSTACK_SECRET_KEY)
            .update(signingString)
            .digest('hex');

        return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch (e) {
        console.error('[BillStack Webhook] Signature verification error:', e.message);
        return false;
    }
}

// ─── Payment Processing ───────────────────────────────────────────────────────

/**
 * Process an incoming PAYMENT_NOTIFICATION webhook from BillStack (idempotent).
 *
 * BillStack payload shape:
 * {
 *   event: "PAYMENT_NOTIFICATION",
 *   data: {
 *     type: "RESERVED_ACCOUNT_TRANSACTION",
 *     reference: "virtual_account_reference",    // the account reference
 *     merchant_reference: "...",
 *     wiaxy_ref: "...",                          // interbank reference (use as tx ref)
 *     transaction_ref: "...",
 *     amount: "5000",
 *     created_at: "...",
 *     account: { account_number, account_name, bank_name, created_at },
 *     payer: { account_number, first_name, last_name, createdAt }
 *   }
 * }
 *
 * @param {object} data - The `data` object from the webhook payload
 */
async function processIncomingPayment(data) {
    // Use wiaxy_ref / transaction_ref as the unique transaction reference
    const txRef = data.wiaxy_ref || data.transaction_ref || data.merchant_reference || data.reference;
    const accountRef = data.reference || data.merchant_reference;
    const amount = parseFloat(data.amount);

    if (!txRef) throw new Error('[BillStack] Missing transaction reference in webhook payload');
    if (isNaN(amount) || amount <= 0) throw new Error('[BillStack] Invalid payment amount in webhook payload');

    // 1. Idempotency: already processed?
    const existingTx = db.prepare(`SELECT * FROM wallet_transactions WHERE reference = ?`).get(txRef);
    if (existingTx) {
        if (existingTx.status === 'successful') {
            return {
                alreadyProcessed: true,
                message: 'Payment already credited',
                balance: getWalletBalance(existingTx.user_id),
                transaction: existingTx
            };
        }
        // Was pending (e.g. checkout-initiated), complete it
        const completed = completeFunding(txRef, 'successful', data);
        return {
            alreadyProcessed: false,
            message: 'Wallet credited via BillStack (pending→completed)',
            balance: completed.balance,
            transaction: completed.transaction
        };
    }

    // 2. Find user by virtual account reference stored in DB
    let vbaUser = null;
    if (accountRef) {
        vbaUser = db.prepare(`SELECT * FROM user_virtual_accounts WHERE account_reference = ?`).get(accountRef);
    }

    // Fallback: look up by account number from the payload
    const payloadAccNum = data.account?.account_number || data.account_number || data.accountNumber;
    if (!vbaUser && payloadAccNum) {
        vbaUser = db.prepare(`SELECT * FROM user_virtual_accounts WHERE account_number = ?`).get(payloadAccNum);
    }

    if (!vbaUser) {
        throw new Error(`[BillStack] No matching user found for account ref: ${accountRef}`);
    }

    // 3. Credit wallet — record as a new successful funding entry
    const metadata = {
        billstackRef: txRef,
        accountReference: accountRef,
        amount,
        currency: 'NGN',
        payer: data.payer || {},
        account: data.account || {},
        receivedAt: data.created_at || new Date().toISOString(),
        processedAt: new Date().toISOString()
    };

    const recordResult = recordFunding(
        vbaUser.user_id,
        amount,
        txRef,
        'billstack',
        'successful',
        metadata
    );

    return {
        alreadyProcessed: false,
        message: 'Wallet credited successfully via BillStack',
        balance: recordResult.balance,
        transaction: recordResult,
        user: { id: vbaUser.user_id, accountName: vbaUser.account_name }
    };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    SUPPORTED_BANKS,
    DEFAULT_BANK,
    isMock,
    getVirtualAccount,
    getAllVirtualAccounts,
    createOrGetVirtualAccount,
    verifyWebhookSignature,
    processIncomingPayment
};
