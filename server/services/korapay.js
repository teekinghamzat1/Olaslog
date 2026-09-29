const crypto = require('crypto');
const db = require('../db');
const { getWalletBalance, recordFunding, completeFunding } = require('./wallet');
require('dotenv').config();

const KORAPAY_SECRET_KEY = process.env.KORAPAY_SECRET_KEY || '';
const KORAPAY_PUBLIC_KEY = process.env.KORAPAY_PUBLIC_KEY || '';
const KORAPAY_BANK_CODE = process.env.KORAPAY_BANK_CODE || '070'; // Default Fidelity Bank (070) or Sandbox (000)
const KORAPAY_BASE_URL = 'https://api.korapay.com';

const isMock = !KORAPAY_SECRET_KEY || KORAPAY_SECRET_KEY.includes('mock');

/**
 * Supported bank codes as per Korapay documentation
 */
const SUPPORTED_BANKS = [
    { name: 'Fidelity Bank', code: '070' },
    { name: 'Wema Bank', code: '035' },
    { name: 'Moniepoint', code: '090405' },
    { name: 'Globus Bank', code: '103' },
    { name: 'UBA', code: '033' },
    { name: 'Optimus Bank', code: '107' },
    { name: 'Parallex Bank', code: '104' },
    { name: 'FCMB', code: '214' },
    { name: 'Sandbox Test Bank', code: '000' }
];

/**
 * Retrieve user's dedicated virtual bank account
 * @param {number} userId
 */
function getVirtualAccount(userId) {
    const row = db.prepare(`
        SELECT id, user_id, account_name, account_number, bank_code, bank_name, 
               account_reference, unique_id, account_status, currency, is_mock, created_at
        FROM user_virtual_accounts
        WHERE user_id = ?
    `).get(userId);

    return row || null;
}

/**
 * Create or retrieve a persistent dedicated Virtual Bank Account for a customer
 * @param {number} userId
 * @param {object} params
 * @param {string} params.bvn - 11 digit Bank Verification Number (Mandatory by Korapay)
 * @param {string} [params.nin] - Optional National Identity Number
 * @param {string} [params.bankCode] - Preferred bank code (defaults to KORAPAY_BANK_CODE)
 */
async function createOrGetVirtualAccount(userId, { bvn, nin, bankCode } = {}) {
    // 1. Check if user already has an active virtual bank account
    const existing = getVirtualAccount(userId);
    if (existing) {
        return {
            success: true,
            isNew: false,
            data: existing
        };
    }

    // 2. Fetch user details from database
    const user = db.prepare(`SELECT id, email, full_name, phone FROM users WHERE id = ?`).get(userId);
    if (!user) {
        throw new Error('User not found');
    }

    // 3. BVN is mandatory for initial VBA generation
    const cleanBvn = (bvn || '').trim();
    if (!cleanBvn || cleanBvn.length !== 11 || !/^\d{11}$/.test(cleanBvn)) {
        const err = new Error('A valid 11-digit Bank Verification Number (BVN) is required to generate your dedicated Virtual Bank Account.');
        err.code = 'BVN_REQUIRED';
        throw err;
    }

    const accountReference = `OLAS-VBA-${userId}-${Date.now()}`;
    const selectedBankCode = bankCode || KORAPAY_BANK_CODE;

    // 4. If live/sandbox Korapay credentials are provided, call Korapay API
    if (!isMock && process.env.NODE_ENV !== 'test') {
        try {
            const payload = {
                account_name: user.full_name,
                account_reference: accountReference,
                permanent: true,
                bank_code: selectedBankCode,
                customer: {
                    name: user.full_name,
                    email: user.email
                },
                kyc: {
                    bvn: cleanBvn,
                    ...(nin ? { nin: nin.trim() } : {})
                }
            };

            const response = await fetch(`${KORAPAY_BASE_URL}/merchant/api/v1/virtual-bank-account`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${KORAPAY_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            const resData = await response.json();
            if (resData.status && resData.data) {
                const d = resData.data;
                const stmt = db.prepare(`
                    INSERT INTO user_virtual_accounts 
                    (user_id, account_name, account_number, bank_code, bank_name, account_reference, unique_id, account_status, currency, bvn, nin, is_mock)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
                `);

                stmt.run(
                    userId,
                    d.account_name,
                    d.account_number,
                    d.bank_code || selectedBankCode,
                    d.bank_name || 'Fidelity Bank',
                    d.account_reference || accountReference,
                    d.unique_id || null,
                    d.account_status || 'active',
                    d.currency || 'NGN',
                    cleanBvn,
                    nin || null
                );

                return {
                    success: true,
                    isNew: true,
                    data: getVirtualAccount(userId)
                };
            } else {
                let errMsg = resData.message || 'Failed to create virtual bank account with Korapay';
                if (errMsg.toLowerCase().includes('not enabled')) {
                    errMsg = 'Virtual Bank Account payment is not enabled on your Korapay merchant account. Please enable Virtual Bank Accounts in your Korapay dashboard (Settings > Preferences > Payment Methods) or contact support@korapay.com.';
                }
                console.warn('Korapay VBA creation failed from API response:', errMsg);
                throw new Error(errMsg);
            }
        } catch (apiErr) {
            console.error('Korapay API error:', apiErr.message);
            throw apiErr;
        }
    }

    // 5. Simulation / Development Mode: Generate Realistic Mock Nigerian Virtual Account
    const bankObj = SUPPORTED_BANKS.find(b => b.code === selectedBankCode) || SUPPORTED_BANKS[0];
    // Generate realistic 10-digit NUBAN
    const mockAccountNumber = '70' + String(userId).padStart(3, '0') + Math.floor(10000 + Math.random() * 90000);
    const mockAccountName = `Olaslog - ${user.full_name}`;

    const stmt = db.prepare(`
        INSERT INTO user_virtual_accounts 
        (user_id, account_name, account_number, bank_code, bank_name, account_reference, unique_id, account_status, currency, bvn, nin, is_mock)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);

    stmt.run(
        userId,
        mockAccountName,
        mockAccountNumber,
        bankObj.code,
        `${bankObj.name} (Korapay)`,
        accountReference,
        `korapay_mock_${Date.now()}`,
        'active',
        'NGN',
        cleanBvn,
        nin || null
    );

    return {
        success: true,
        isNew: true,
        isMock: true,
        data: getVirtualAccount(userId)
    };
}

/**
 * Verify Korapay webhook signature
 * Korapay sends an HMAC SHA-256 signature in the 'x-korapay-signature' header
 * @param {string} rawBody
 * @param {string} signature
 */
function verifyWebhookSignature(rawBody, signature) {
    if (!signature) return false;
    if (isMock) return true; // Accept simulated test webhooks in dev mode
    try {
        const hash = crypto.createHmac('sha256', KORAPAY_SECRET_KEY).update(rawBody).digest('hex');
        return hash === signature;
    } catch (e) {
        return false;
    }
}

/**
 * Verify transaction using Korapay Charge Query API
 * GET https://api.korapay.com/merchant/api/v1/charges/:reference
 * @param {string} reference
 */
async function verifyCharge(reference) {
    if (!isMock && KORAPAY_SECRET_KEY) {
        try {
            const response = await fetch(`${KORAPAY_BASE_URL}/merchant/api/v1/charges/${encodeURIComponent(reference)}`, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${KORAPAY_SECRET_KEY}`
                }
            });
            const data = await response.json();
            if (data.status && data.data) {
                return data.data;
            }
        } catch (err) {
            console.error('Korapay charge query error:', err.message);
        }
    }

    // Fallback/simulation response
    return {
        reference,
        status: 'success',
        currency: 'NGN'
    };
}

/**
 * Initialize a standard Korapay checkout session (Cards, Bank Transfer, USSD)
 * No CAC or customer BVN required!
 * @param {number} userId
 * @param {string} email
 * @param {string} name
 * @param {number} amount
 * @param {string} [redirectUrl]
 */
async function initializeCheckout(userId, email, name, amount, redirectUrl = '') {
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount < 100) {
        const err = new Error('Minimum wallet funding amount is ₦100');
        err.code = 'MIN_FUNDING_NOT_MET';
        throw err;
    }

    const reference = `WAL-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

    // Record pending transaction in immutable ledger
    recordFunding(userId, numAmount, reference, 'korapay', 'pending', { email, name, redirectUrl });

    if (!isMock && KORAPAY_SECRET_KEY && process.env.NODE_ENV !== 'test') {
        try {
            const payload = {
                amount: numAmount,
                redirect_url: redirectUrl || (process.env.APP_URL ? `${process.env.APP_URL}/#wallet` : 'http://localhost:3000/#wallet'),
                currency: 'NGN',
                reference,
                narration: 'Olaslog Wallet Top-up',
                customer: {
                    name: name || 'Customer',
                    email
                }
            };

            const response = await fetch(`${KORAPAY_BASE_URL}/merchant/api/v1/charges/initialize`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${KORAPAY_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            const resData = await response.json();
            if (resData.status && resData.data && resData.data.checkout_url) {
                return {
                    success: true,
                    reference,
                    checkoutUrl: resData.data.checkout_url,
                    isMock: false
                };
            } else {
                throw new Error(resData.message || 'Failed to initialize payment with Korapay');
            }
        } catch (apiErr) {
            console.error('Korapay initialize error:', apiErr.message);
            throw apiErr;
        }
    }

    // Dev/fallback mode
    return {
        success: true,
        reference,
        checkoutUrl: `${redirectUrl || '/#wallet'}?reference=${reference}`,
        isMock: true
    };
}

/**
 * Verify a Korapay checkout transaction by reference and credit wallet
 * @param {string} reference
 */
async function verifyPayment(reference) {
    if (!reference) throw new Error('Transaction reference is required');

    // 1. Check if already credited in wallet ledger
    const existingTx = db.prepare(`SELECT * FROM wallet_transactions WHERE reference = ?`).get(reference);
    if (existingTx && existingTx.status === 'successful') {
        return {
            success: true,
            status: 'successful',
            alreadyProcessed: true,
            balance: getWalletBalance(existingTx.user_id),
            message: 'Transaction already verified and credited'
        };
    }

    // 2. Query Korapay API if live
    let chargeData = { status: 'success' };
    if (!isMock && KORAPAY_SECRET_KEY && process.env.NODE_ENV !== 'test') {
        chargeData = await verifyCharge(reference);
    }

    if (chargeData.status === 'success') {
        const result = completeFunding(reference, 'successful', chargeData);
        return {
            success: true,
            status: 'successful',
            alreadyProcessed: result.alreadyProcessed,
            balance: result.balance,
            message: 'Payment verified and wallet credited successfully'
        };
    } else {
        return {
            success: false,
            status: chargeData.status || 'pending',
            message: `Payment status is ${chargeData.status || 'pending'}`
        };
    }
}

/**
 * Process an incoming payment from Korapay (Idempotent)
 * Handles both Standard Checkout charges and Dedicated Virtual Bank Accounts
 * @param {object} paymentPayload
 */
async function processIncomingPayment(paymentPayload) {
    const { reference, amount, fee = 0, currency = 'NGN', virtual_bank_account_details, transaction_date } = paymentPayload;

    if (!reference) {
        throw new Error('Transaction reference is missing');
    }

    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
        throw new Error('Invalid payment amount');
    }

    // 1. Idempotency check: Has this transaction reference already been recorded in wallet ledger?
    const existingTx = db.prepare(`SELECT * FROM wallet_transactions WHERE reference = ?`).get(reference);
    if (existingTx) {
        if (existingTx.status === 'successful') {
            return {
                alreadyProcessed: true,
                message: 'Payment already credited',
                balance: getWalletBalance(existingTx.user_id),
                transaction: existingTx
            };
        }
        // If it was initiated via Korapay standard checkout, complete and credit it immediately
        const completed = completeFunding(reference, 'successful', paymentPayload);
        return {
            alreadyProcessed: false,
            message: 'Wallet credited successfully via Korapay Checkout',
            balance: completed.balance,
            transaction: completed.transaction
        };
    }

    // 2. Identify user by virtual bank account reference or account number
    const vbaInfo = (virtual_bank_account_details && virtual_bank_account_details.virtual_bank_account) || {};
    const accountRef = vbaInfo.account_reference;
    const accountNumber = vbaInfo.account_number;

    let vbaUser = null;
    if (accountRef) {
        vbaUser = db.prepare(`SELECT * FROM user_virtual_accounts WHERE account_reference = ?`).get(accountRef);
    }
    if (!vbaUser && accountNumber) {
        vbaUser = db.prepare(`SELECT * FROM user_virtual_accounts WHERE account_number = ?`).get(accountNumber);
    }

    if (!vbaUser) {
        throw new Error(`No matching user found for virtual account ref: ${accountRef || accountNumber}`);
    }

    // 3. Double-check verification via Korapay Charges Query API if live
    if (!isMock) {
        const verifiedCharge = await verifyCharge(reference);
        if (verifiedCharge.status !== 'success') {
            throw new Error(`Charge verification failed for reference ${reference}. Status: ${verifiedCharge.status}`);
        }
    }

    // 4. Credit the user's wallet in the immutable ledger
    const metadata = {
        korapayReference: reference,
        fee,
        currency,
        payerBank: (virtual_bank_account_details && virtual_bank_account_details.payer_bank_account) || {},
        virtualAccount: vbaInfo,
        transactionDate: transaction_date || new Date().toISOString(),
        verifiedAt: new Date().toISOString()
    };

    const recordResult = recordFunding(
        vbaUser.user_id,
        numAmount,
        reference,
        'korapay',
        'successful',
        metadata
    );

    return {
        alreadyProcessed: false,
        message: 'Wallet credited successfully',
        balance: recordResult.balance,
        transaction: recordResult,
        user: { id: vbaUser.user_id, accountName: vbaUser.account_name }
    };
}

/**
 * Simulate / Credit Sandbox Virtual Bank Account
 * POST https://api.korapay.com/merchant/api/v1/virtual-bank-account/sandbox/credit
 * @param {string} accountNumber
 * @param {number} amount
 * @param {object} [payerInfo]
 */
async function creditSandboxAccount(accountNumber, amount, payerInfo = {}) {
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount < 100 || numAmount > 10000000) {
        throw new Error('Funding amount must be between ₦100 and ₦10,000,000');
    }

    const vba = db.prepare(`SELECT * FROM user_virtual_accounts WHERE account_number = ?`).get(accountNumber);
    if (!vba) {
        throw new Error(`Virtual account number ${accountNumber} not found`);
    }

    // If live sandbox keys are provided, call Korapay Sandbox Credit API
    if (!isMock && !vba.is_mock) {
        try {
            const response = await fetch(`${KORAPAY_BASE_URL}/merchant/api/v1/virtual-bank-account/sandbox/credit`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${KORAPAY_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    account_number: accountNumber,
                    currency: 'NGN',
                    amount: numAmount
                })
            });
            const data = await response.json();
            if (data.status) {
                // Also process locally to ensure immediate wallet reflection
                const simRef = `KPY-SANDBOX-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
                return processIncomingPayment({
                    reference: simRef,
                    amount: numAmount,
                    currency: 'NGN',
                    fee: 0,
                    virtual_bank_account_details: {
                        payer_bank_account: {
                            account_name: payerInfo.payerName || 'Test Customer',
                            account_number: '******9901',
                            bank_name: payerInfo.payerBank || 'GTBank'
                        },
                        virtual_bank_account: {
                            account_name: vba.account_name,
                            account_number: vba.account_number,
                            account_reference: vba.account_reference,
                            bank_name: vba.bank_name
                        }
                    }
                });
            }
        } catch (apiErr) {
            console.warn('Korapay sandbox credit API call notice:', apiErr.message);
        }
    }

    // Mock / Simulated Credit
    const simRef = `KPY-SIM-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
    return processIncomingPayment({
        reference: simRef,
        amount: numAmount,
        currency: 'NGN',
        fee: 0,
        virtual_bank_account_details: {
            payer_bank_account: {
                account_name: payerInfo.payerName || 'Simulated Bank Transfer',
                account_number: '******1234',
                bank_name: payerInfo.payerBank || 'Access Bank / GTBank'
            },
            virtual_bank_account: {
                account_name: vba.account_name,
                account_number: vba.account_number,
                account_reference: vba.account_reference,
                bank_name: vba.bank_name
            }
        }
    });
}

module.exports = {
    SUPPORTED_BANKS,
    getVirtualAccount,
    createOrGetVirtualAccount,
    initializeCheckout,
    verifyPayment,
    verifyWebhookSignature,
    verifyCharge,
    processIncomingPayment,
    creditSandboxAccount,
    isMock
};

