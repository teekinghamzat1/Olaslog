const crypto = require('crypto');
const { recordFunding, completeFunding } = require('./wallet');
require('dotenv').config();

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || 'sk_test_mock_paystack_secret_key';
const PAYSTACK_PUBLIC = process.env.PAYSTACK_PUBLIC_KEY || 'pk_test_mock_paystack_public_key';
const MIN_FUNDING = parseInt(process.env.MIN_FUNDING_AMOUNT || '100', 10);

/**
 * Initialize a funding transaction
 * @param {number} userId
 * @param {string} email
 * @param {number} amount
 * @param {string} [callbackUrl]
 */
async function initializeFunding(userId, email, amount, callbackUrl = '') {
    if (amount < MIN_FUNDING) {
        const err = new Error(`Minimum funding amount is ₦${MIN_FUNDING}`);
        err.code = 'MIN_FUNDING_NOT_MET';
        throw err;
    }

    const reference = `WAL-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

    // Record pending transaction in wallet ledger
    recordFunding(userId, amount, reference, 'paystack', 'pending', { email, callbackUrl });

    // Check if live Paystack credentials exist (starts with sk_live_ or sk_test_ without "mock")
    const isMock = PAYSTACK_SECRET.includes('mock') || !process.env.PAYSTACK_SECRET_KEY;

    if (!isMock) {
        try {
            const response = await fetch('https://api.paystack.co/transaction/initialize', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${PAYSTACK_SECRET}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    email,
                    amount: Math.round(amount * 100), // Paystack expects Kobo
                    reference,
                    callback_url: callbackUrl
                })
            });
            const data = await response.json();
            if (data.status) {
                return {
                    success: true,
                    reference,
                    authorizationUrl: data.data.authorization_url,
                    accessCode: data.data.access_code,
                    isMock: false
                };
            }
        } catch (err) {
            console.warn('Paystack live init failed, falling back to simulation:', err.message);
        }
    }

    // Return simulation payload
    return {
        success: true,
        reference,
        authorizationUrl: `/wallet-paystack-sim.html?reference=${reference}&amount=${amount}&email=${encodeURIComponent(email)}`,
        accessCode: `sim_${reference}`,
        isMock: true,
        publicKey: PAYSTACK_PUBLIC
    };
}

/**
 * Verify Paystack webhook signature
 * @param {string} rawBody
 * @param {string} signature
 * @returns {boolean}
 */
function verifyWebhookSignature(rawBody, signature) {
    if (!signature) return false;
    const hash = crypto.createHmac('sha512', PAYSTACK_SECRET).update(rawBody).digest('hex');
    return hash === signature;
}

/**
 * Server-side transaction verification (via Paystack API or simulated)
 * @param {string} reference
 */
async function verifyTransaction(reference) {
    const isMock = PAYSTACK_SECRET.includes('mock') || !process.env.PAYSTACK_SECRET_KEY;

    if (!isMock) {
        try {
            const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${PAYSTACK_SECRET}`
                }
            });
            const data = await response.json();
            if (data.status && data.data && data.data.status === 'success') {
                return completeFunding(reference, 'successful', data.data);
            } else {
                return completeFunding(reference, 'failed', data.data || {});
            }
        } catch (err) {
            console.warn('Error during Paystack server verification:', err.message);
        }
    }

    // In simulation mode, verify and credit
    return completeFunding(reference, 'successful', { simulated: true, channel: 'card_simulated' });
}

module.exports = {
    initializeFunding,
    verifyWebhookSignature,
    verifyTransaction,
    MIN_FUNDING
};
