'use strict';

if (process.env.CI !== 'true' || process.env.OLASLOG_OFFLINE_TEST !== '1') {
    throw new Error('Offline checkout tests may only run in the isolated CI environment.');
}

process.env.NODE_ENV = 'test';
process.env.SUJAN_API_KEY = 'mock_offline_test';
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.TELEGRAM_CHAT_ID = '';
process.env.SMTP_HOST = '';
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';

const assert = require('assert');
const db = require('../server/db');
const { seedDatabase } = require('../server/db/seed');
const { getWalletBalance, getLedgerBalance, getReservedBalance } = require('../server/services/wallet');
const { encrypt } = require('../server/services/crypto');
const sujanService = require('../server/services/sujan');
const emailService = require('../server/services/email');
const telegram = require('../server/services/telegram');
const telegramBot = require('../server/services/telegramBot');
const { checkoutCart, completeSupplierCheckoutFromWebhook } = require('../server/services/order');
const phoneVerify = require('../server/services/phoneVerify');
const phoneVerifyRecovery = require('../server/services/phoneVerifyRecovery');

// Hard-disable outbound notifications for this test process.
emailService.sendPurchaseEmail = async () => ({ skipped: true });
telegram.notifyLowStock = async () => ({ skipped: true });
telegramBot.notifyUserOrderDelivered = async () => ({ skipped: true });

async function run() {
    const crypto = require('crypto');
    const webhookSecret = 'offline-webhook-secret';
    const webhookPayload = Buffer.from('{"event":"order.completed","data":{"id":"OFFLINE-1"}}');
    const webhookSignature = crypto.createHmac('sha256', webhookSecret).update(webhookPayload).digest('hex');
    assert.strictEqual(sujanService.verifyWebhookSignature(webhookPayload, webhookSignature, webhookSecret), true);
    assert.strictEqual(sujanService.verifyWebhookSignature(Buffer.from('tampered'), webhookSignature, webhookSecret), false);
    assert.strictEqual(sujanService.verifyWebhookSignature(webhookPayload, 'not-a-valid-signature', webhookSecret), false);
    assert.strictEqual(sujanService.verifyWebhookSignature(webhookPayload, webhookSignature, ''), false);
    console.log('PASS: Sujan webhook HMAC verification accepts valid raw bodies and rejects invalid signatures');

    // This runs only in a fresh, disposable CI database.
    seedDatabase();

    // Email template rendering checks: no SMTP transport or outbound email is used.
    const emailSamples = {
        welcome: emailService.buildWelcomeEmail({ email: 'customer@olaslog.com', fullName: 'Offline Customer' }),
        wallet_funded: emailService.buildWalletFundedEmail(
            { email: 'customer@olaslog.com', fullName: 'Offline Customer' },
            { amount: 5000, newBalance: 15000, reference: 'OFFLINE-PAYMENT-1', channel: 'virtual_bank_account' }
        ),
        purchase: emailService.buildPurchaseEmail(
            { email: 'customer@olaslog.com', fullName: 'Offline Customer' },
            {
                orderNumber: 'OFFLINE-ORDER-1',
                totalAmount: 3500,
                remainingBalance: 11500,
                items: [{ productName: 'Offline Product', credentialText: 'offline-user|offline-pass', publicData: 'Offline account' }]
            }
        ),
        password_reset: emailService.buildPasswordResetEmail(
            { email: 'customer@olaslog.com', fullName: 'Offline Customer' },
            { resetUrl: 'https://olaslog.com/#reset-password?token=offline-reset-token' }
        )
    };
    for (const [key, rendered] of Object.entries(emailSamples)) {
        assert(rendered.subject && rendered.html, key + ' email must render a subject and HTML body');
        assert(rendered.html.includes('Offline'), key + ' email must include the customer first name');
    }
    assert(emailSamples.wallet_funded.html.includes('OFFLINE-PAYMENT-1'), 'Wallet email must include the payment reference');
    assert(emailSamples.purchase.html.includes('OFFLINE-ORDER-1'), 'Purchase email must include the order number');
    assert(emailSamples.purchase.html.includes('offline-user|offline-pass'), 'Purchase email must include delivered credentials');
    assert(emailSamples.password_reset.html.includes('offline-reset-token'), 'Password reset email must include its reset link');
    console.log('PASS: all four transactional email templates render expected customer and transaction details without sending email');

    const customer = db.prepare("SELECT id FROM users WHERE email = 'customer@olaslog.com'").get();
    assert(customer, 'Seeded test customer must exist');

    // US Phone Verify tests use a mocked fetch implementation only.
    phoneVerify.updateSetting('api_user', 'offline-user');
    phoneVerify.updateSetting('api_key', 'offline-key');
    phoneVerify.updateSetting('usd_rate', '1000');
    phoneVerify.updateSetting('margin_percent', '0');
    phoneVerify.updateSetting('min_price_ngn', '100');
    const originalFetch = global.fetch;
    let phoneProviderMode = 'success';
    global.fetch = async url => {
        const command = new URL(url).searchParams.get('cmd');
        if (command === 'list_services') {
            return { ok: true, json: async () => ({ status: 'ok', message: [{ name: 'OfflineTest', price: '0.50', otp_available: '5' }] }) };
        }
        if (command === 'request' && phoneProviderMode === 'timeout') {
            throw new Error('Simulated provider timeout');
        }
        if (command === 'request') {
            return { ok: true, json: async () => ({ status: 'ok', message: [{ id: 'OFFLINE-PHONE-REQ-1', price: '0.50', mdn: '12125550123', till_expiration: '900' }] }) };
        }
        if (command === 'reject') {
            return { ok: true, json: async () => ({ status: 'ok', message: 'rejected' }) };
        }
        throw new Error('Unexpected mocked USPhoneVerify command: ' + command);
    };
    try {
        const phoneBalanceBefore = getWalletBalance(customer.id);
        const phoneLedgerBefore = getLedgerBalance(customer.id);
        const phonePurchase = await phoneVerify.requestNumber({ userId: customer.id, service: 'OfflineTest' });
        assert.strictEqual(phonePurchase.requestId, 'OFFLINE-PHONE-REQ-1');
        assert.strictEqual(getLedgerBalance(customer.id), phoneLedgerBefore - phonePurchase.costNgn);
        assert.strictEqual(getReservedBalance(customer.id), 0, 'Successful phone verification must commit and release its reservation');
        assert.strictEqual(getWalletBalance(customer.id), phoneBalanceBefore - phonePurchase.costNgn);
        console.log('PASS: US Phone Verify reserves funds before provider request and commits one wallet debit');

        phoneProviderMode = 'timeout';
        const phoneLedgerBeforeTimeout = getLedgerBalance(customer.id);
        const phoneReservedBeforeTimeout = getReservedBalance(customer.id);
        await assert.rejects(
            phoneVerify.requestNumber({ userId: customer.id, service: 'OfflineTest' }),
            error => error.code === 'PHONE_VERIFY_UNCERTAIN'
        );
        assert.strictEqual(getLedgerBalance(customer.id), phoneLedgerBeforeTimeout, 'Ambiguous phone provider response must not debit the ledger');
        assert.strictEqual(getReservedBalance(customer.id), phoneReservedBeforeTimeout + 500, 'Ambiguous phone provider response must keep estimated funds held');
        const uncertainPhoneAttempt = db.prepare("SELECT * FROM phone_verification_attempts WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(customer.id);
        assert.strictEqual(uncertainPhoneAttempt.status, 'provider_uncertain');
        const uncertainPhone = uncertainPhoneAttempt.attempt_id;
        const reservedBeforeRecovery = getReservedBalance(customer.id);
        const ledgerBeforeRecovery = getLedgerBalance(customer.id);

        const recoveryQueue = phoneVerifyRecovery.listUnresolvedAttempts();
        assert(recoveryQueue.some(row => row.attempt_id === uncertainPhone), 'Uncertain request must appear in admin recovery queue');
        assert.strictEqual(phoneVerifyRecovery.listUnresolvedAttempts(1).length <= 1, true, 'Recovery queue limit must be bounded');
        assert.throws(
            () => phoneVerifyRecovery.resolveNoIssue(uncertainPhone, customer.id, false, 'No provider confirmation'),
            /Confirm that the provider issued no number/
        );
        assert.strictEqual(getReservedBalance(customer.id), reservedBeforeRecovery, 'Missing provider confirmation must not release funds');
        assert.throws(
            () => phoneVerifyRecovery.resolveNoIssue(uncertainPhone, customer.id, true, 'short'),
            /at least 10 characters/
        );
        assert.strictEqual(getReservedBalance(customer.id), reservedBeforeRecovery, 'Insufficient evidence must not release funds');

        assert.throws(
            () => phoneVerifyRecovery.markInvestigating(uncertainPhone, 'no'),
            /at least 5 characters/
        );
        phoneVerifyRecovery.markInvestigating(uncertainPhone, 'Contacted provider support; awaiting confirmation.');
        const investigating = db.prepare('SELECT recovery_status, resolution_note FROM phone_verification_attempts WHERE attempt_id = ?').get(uncertainPhone);
        assert.strictEqual(investigating.recovery_status, 'investigating');
        assert.match(investigating.resolution_note, /Contacted provider support/);

        const resolution = phoneVerifyRecovery.resolveNoIssue(
            uncertainPhone, customer.id, true,
            'Provider support confirmed no number was issued; case reference OFFLINE-CASE-1.'
        );
        assert.strictEqual(resolution.amount, 500);
        assert.strictEqual(getLedgerBalance(customer.id), ledgerBeforeRecovery, 'Releasing a hold must not create a wallet credit or debit');
        assert.strictEqual(getReservedBalance(customer.id), reservedBeforeRecovery - 500, 'Confirmed no-issue resolution must release only this attempt hold');
        const resolvedAttempt = db.prepare('SELECT status, recovery_status, resolved_by, resolution_note, resolved_at FROM phone_verification_attempts WHERE attempt_id = ?').get(uncertainPhone);
        const resolvedReservation = db.prepare('SELECT status FROM wallet_reservations WHERE checkout_id = ?').get(uncertainPhone);
        assert.strictEqual(resolvedAttempt.status, 'rejected');
        assert.strictEqual(resolvedAttempt.recovery_status, 'resolved_no_issue');
        assert.strictEqual(resolvedAttempt.resolved_by, customer.id);
        assert(resolvedAttempt.resolved_at, 'Resolution timestamp must be saved');
        assert.strictEqual(resolvedReservation.status, 'released');
        assert.throws(
            () => phoneVerifyRecovery.resolveNoIssue(uncertainPhone, customer.id, true, 'Provider again confirmed no number was issued.'),
            /already resolved or does not exist/
        );
        assert.strictEqual(getReservedBalance(customer.id), reservedBeforeRecovery - 500, 'Duplicate resolution must not release another reservation');
        assert.strictEqual(getLedgerBalance(customer.id), ledgerBeforeRecovery, 'Duplicate resolution must not change wallet ledger');
        assert.strictEqual(phoneVerifyRecovery.listUnresolvedAttempts().some(row => row.attempt_id === uncertainPhone), false);
        console.log('PASS: phone verification recovery queue, review notes, evidence gate, one-time hold release, and duplicate protection');
    } finally {
        global.fetch = originalFetch;
        phoneVerify.stopVerificationPoller();
    }

    let category = db.prepare("SELECT id FROM product_categories LIMIT 1").get();
    if (!category) {
        const result = db.prepare(
            "INSERT INTO product_categories (name, slug) VALUES ('Offline Test', 'offline-test')"
        ).run();
        category = { id: result.lastInsertRowid };
    }

    const createProduct = (name, slug, price, sujanProductId = null) => {
        const result = db.prepare(`
            INSERT INTO products (category_id, sujan_product_id, name, slug, price, is_active)
            VALUES (?, ?, ?, ?, ?, 1)
        `).run(category.id, sujanProductId, name, slug, price);
        return { id: result.lastInsertRowid, price, sujanProductId };
    };

    const providerProduct = createProduct('Mock Provider Product', 'mock-provider-product', 1000, 910001);
    let providerCalls = 0;
    sujanService.placeOrder = async ({ productId, quantity }) => {
        providerCalls++;
        assert.strictEqual(productId, providerProduct.sujanProductId);
        assert.strictEqual(quantity, 1);
        return {
            data: {
                id: 'OFFLINE-MOCK-ORDER-1',
                product: 'Mock Provider Product',
                items: [{
                    id: 'OFFLINE-MOCK-ITEM-1',
                    product_name: 'Mock Provider Product',
                    public_data: 'Offline test account',
                    credential: 'offline-user|offline-password'
                }]
            }
        };
    };

    const startingBalance = getWalletBalance(customer.id);
    const providerOrder = await checkoutCart(customer.id, [
        { productId: providerProduct.id, quantity: 1 }
    ]);
    assert.strictEqual(providerCalls, 1, 'Checkout must use the mocked provider exactly once');
    assert.strictEqual(providerOrder.deliveredCredentials.length, 1);
    assert.strictEqual(providerOrder.deliveredCredentials[0].credentialText, 'offline-user|offline-password');
    assert.strictEqual(getWalletBalance(customer.id), startingBalance - providerProduct.price);
    console.log('PASS: mocked provider checkout, credential delivery, and wallet debit');

    const malformedProviderProduct = createProduct('Malformed Provider Response', 'offline-malformed-provider', 250, 910003);
    const balanceBeforeMalformedResponse = getWalletBalance(customer.id);
    const ledgerBeforeMalformedResponse = getLedgerBalance(customer.id);
    sujanService.placeOrder = async () => ({
        data: {
            // Deliberately omit the supplier order ID and return an empty credential.
            items: [{ id: 'OFFLINE-BAD-ITEM', credential: '   ' }]
        }
    });
    await assert.rejects(
        checkoutCart(customer.id, [{ productId: malformedProviderProduct.id, quantity: 1 }]),
        error => error.code === 'SUPPLIER_UNCERTAIN'
    );
    assert.strictEqual(
        getLedgerBalance(customer.id),
        ledgerBeforeMalformedResponse,
        'An unverifiable supplier response must not create a wallet debit'
    );
    assert.strictEqual(
        getWalletBalance(customer.id),
        balanceBeforeMalformedResponse - malformedProviderProduct.price,
        'Funds for an uncertain supplier order must remain reserved and unavailable'
    );
    assert.strictEqual(getReservedBalance(customer.id), malformedProviderProduct.price);
    const malformedAttempt = db.prepare("SELECT status FROM checkout_attempts WHERE user_id = ? AND status = 'supplier_uncertain' ORDER BY id DESC LIMIT 1").get(customer.id);
    assert(malformedAttempt, 'Uncertain supplier checkout must be durably recorded');
    console.log('PASS: incomplete supplier response keeps funds reserved without charging the wallet');

    const callsBeforeMixedCart = providerCalls;
    await assert.rejects(
        checkoutCart(customer.id, [
            { productId: providerProduct.id, quantity: 1 },
            { productId: createProduct('Local Basket Item', 'offline-local-basket', 100).id, quantity: 1 }
        ]),
        error => error.code === 'CHECKOUT_SPLIT_REQUIRED'
    );
    assert.strictEqual(providerCalls, callsBeforeMixedCart, 'Mixed supplier/local cart must be rejected before supplier calls');
    console.log('PASS: mixed supplier/local cart is rejected before any supplier request');

    const expensiveProduct = createProduct('Too Expensive', 'offline-too-expensive', 50000);
    let callsBeforeInsufficientFunds = providerCalls;
    await assert.rejects(
        checkoutCart(customer.id, [{ productId: expensiveProduct.id, quantity: 1 }]),
        error => error.code === 'INSUFFICIENT_FUNDS'
    );
    assert.strictEqual(providerCalls, callsBeforeInsufficientFunds, 'Provider must not be called when funds are insufficient');
    console.log('PASS: insufficient funds blocks checkout before provider fulfillment');

    const localProduct = createProduct('Local Backup Product', 'offline-local-backup', 500);
    const addStock = credential => {
        const encrypted = encrypt(credential);
        const result = db.prepare(`
            INSERT INTO stock_items (product_id, encrypted_credential, iv, auth_tag, status)
            VALUES (?, ?, ?, ?, 'available')
        `).run(localProduct.id, encrypted.encrypted, encrypted.iv, encrypted.authTag);
        return result.lastInsertRowid;
    };
    const unselectedId = addStock('unselected-account|password-A');
    const selectedId = addStock('selected-account|password-B');

    let localProductProviderCalls = 0;
    sujanService.placeOrder = async () => {
        localProductProviderCalls++;
        throw new Error('Local products must not call the supplier');
    };

    const localOrder = await checkoutCart(customer.id, [{
        productId: localProduct.id,
        quantity: 1,
        inventoryItemIds: [selectedId]
    }]);
    assert.strictEqual(localProductProviderCalls, 0, 'Local-only products must not call the supplier');

    assert.strictEqual(localOrder.deliveredCredentials.length, 1);
    assert.strictEqual(localOrder.deliveredCredentials[0].credentialText, 'selected-account|password-B');
    const unselected = db.prepare('SELECT status FROM stock_items WHERE id = ?').get(unselectedId);
    const selected = db.prepare('SELECT status FROM stock_items WHERE id = ?').get(selectedId);
    assert.strictEqual(unselected.status, 'available', 'Unselected stock must remain untouched');
    assert.strictEqual(selected.status, 'sold', 'Only the selected stock item should be sold');
    console.log('PASS: local-only products use local stock without calling the supplier');
    console.log('PASS: local fulfilment delivers only the exact selected inventory item');

    const balanceBeforeTimeout = getWalletBalance(customer.id);
    const ledgerBeforeTimeout = getLedgerBalance(customer.id);
    const uncertainProduct = createProduct('Supplier Timeout Product', 'offline-supplier-timeout', 700, 910002);
    const uncertainStockId = addStock('must-not-fallback|password-C');
    db.prepare('UPDATE stock_items SET product_id = ? WHERE id = ?').run(uncertainProduct.id, uncertainStockId);
    sujanService.placeOrder = async () => {
        const error = new Error('Simulated network timeout after request');
        throw error;
    };
    await assert.rejects(
        checkoutCart(customer.id, [{ productId: uncertainProduct.id, quantity: 1 }]),
        error => error.code === 'SUPPLIER_UNCERTAIN'
    );
    assert.strictEqual(getLedgerBalance(customer.id), ledgerBeforeTimeout, 'An ambiguous supplier timeout must not debit the wallet ledger');
    assert.strictEqual(getWalletBalance(customer.id), balanceBeforeTimeout - uncertainProduct.price, 'An ambiguous supplier timeout must keep the amount reserved');
    assert.strictEqual(getReservedBalance(customer.id), malformedProviderProduct.price + uncertainProduct.price);
    const untouchedStock = db.prepare('SELECT status FROM stock_items WHERE id = ?').get(uncertainStockId);
    assert.strictEqual(untouchedStock.status, 'available', 'Supplier timeout must not trigger local stock delivery');
    const uncertaintyAudit = db.prepare(`
        SELECT details FROM audit_logs
        WHERE action = 'SUPPLIER_ORDER_UNCERTAIN' AND target_id = ?
        ORDER BY id DESC LIMIT 1
    `).get(String(customer.id));
    assert(uncertaintyAudit, 'Supplier timeout must be recorded for manual reconciliation');
    const auditDetails = JSON.parse(uncertaintyAudit.details);
    assert.strictEqual(auditDetails.productId, uncertainProduct.id);
    console.log('PASS: supplier timeout fails closed, keeps funds reserved, preserves local stock, and records a reconciliation audit');

    // Simulate a supplier-confirmed checkout whose local commit was interrupted.
    // The signed webhook recovery path must use the existing reservation exactly once.
    const recoveryProduct = createProduct('Webhook Recovery Product', 'offline-webhook-recovery', 300, 910004);
    const recoveryCheckoutId = 'offline-recovery-checkout-1';
    const recoveryAmount = recoveryProduct.price;
    const recoveryBeforeLedger = getLedgerBalance(customer.id);
    db.prepare(`
        INSERT INTO wallet_reservations (checkout_id, user_id, amount, status)
        VALUES (?, ?, ?, 'active')
    `).run(recoveryCheckoutId, customer.id, recoveryAmount);
    db.prepare(`
        INSERT INTO checkout_attempts (checkout_id, user_id, amount, status, supplier_order_id, request_json)
        VALUES (?, ?, ?, 'supplier_confirmed', ?, ?)
    `).run(
        recoveryCheckoutId,
        customer.id,
        recoveryAmount,
        'OFFLINE-RECOVERY-SUPPLIER-1',
        JSON.stringify([{ productId: recoveryProduct.id, quantity: 1, inventoryItemIds: null }])
    );
    const recovered = completeSupplierCheckoutFromWebhook('OFFLINE-RECOVERY-SUPPLIER-1', {
        items: [{ id: 'OFFLINE-RECOVERY-ITEM-1', credential: 'recovered-user|recovered-password' }]
    });
    assert(recovered && !recovered.alreadyCompleted, 'Webhook must recover a confirmed pending checkout');
    assert.strictEqual(getLedgerBalance(customer.id), recoveryBeforeLedger - recoveryAmount);
    assert.strictEqual(getReservedBalance(customer.id), malformedProviderProduct.price + uncertainProduct.price);
    const recoveredAgain = completeSupplierCheckoutFromWebhook('OFFLINE-RECOVERY-SUPPLIER-1', {
        items: [{ id: 'OFFLINE-RECOVERY-ITEM-1', credential: 'recovered-user|recovered-password' }]
    });
    assert(recoveredAgain && recoveredAgain.alreadyCompleted, 'Webhook retry must not charge or create a second order');
    assert.strictEqual(getLedgerBalance(customer.id), recoveryBeforeLedger - recoveryAmount);
    const recoveredOrder = db.prepare('SELECT COUNT(*) AS count FROM orders WHERE sujan_order_id = ?').get('OFFLINE-RECOVERY-SUPPLIER-1');
    assert.strictEqual(recoveredOrder.count, 1);
    console.log('PASS: signed webhook recovery completes a supplier-confirmed checkout exactly once');

    console.log('ALL OFFLINE CHECKOUT TESTS PASSED. No provider, payment, email, or Telegram API calls were made.');
}

run().catch(error => {
    console.error('OFFLINE CHECKOUT TEST FAILED:', error);
    process.exitCode = 1;
});
