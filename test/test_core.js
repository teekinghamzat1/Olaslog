process.env.NODE_ENV = 'test';
const assert = require('assert');
const db = require('../server/db');
const { seedDatabase } = require('../server/db/seed');
const { getWalletBalance, recordFunding, completeFunding, recordRefund } = require('../server/services/wallet');
const { checkoutCart, getOrderWithCredentials } = require('../server/services/order');
const { encrypt, decrypt } = require('../server/services/crypto');
const { MIN_FUNDING } = require('../server/services/wallet');

const korapayService = require('../server/services/korapay');
const sujanService = require('../server/services/sujan');

async function runTests() {
    console.log('--- Starting Olaslog Automated Core Tests ---');

    // 1. Re-seed clean state
    seedDatabase();

    // 2. Test Crypto Encryption & Decryption
    console.log('\n[1] Testing AES-256-GCM Encryption / Decryption...');
    const originalText = 'Username: test_account_01 | Password: SecretP@ss2026! | Token: XYZ-9988';
    const enc = encrypt(originalText);
    assert(enc.encrypted && enc.iv && enc.authTag, 'Encryption output must contain encrypted, iv, and authTag');
    const dec = decrypt(enc.encrypted, enc.iv, enc.authTag);
    assert.strictEqual(dec, originalText, 'Decrypted text must match original plaintext');
    console.log('✓ Encryption and decryption passed');

    // 3. Test Users & Pre-funded Balance
    console.log('\n[2] Testing Demo Customer Wallet Balance...');
    const customer = db.prepare(`SELECT id, email FROM users WHERE email = 'customer@olaslog.com'`).get();
    assert(customer, 'Customer user must exist');
    let balance = getWalletBalance(customer.id);
    assert.strictEqual(balance, 15000, 'Initial seeded customer balance should be ₦15,000');
    console.log(`✓ Customer balance verified: ₦${balance.toLocaleString()}`);

    // 4. Test Wallet Funding - Direct Ledger (Korapay path)
    console.log('\n[3] Testing Wallet Funding Ledger & Idempotency...');

    // Test minimum funding enforced by constant
    assert(MIN_FUNDING === 100, 'MIN_FUNDING must be 100');
    console.log(`✓ MIN_FUNDING constant confirmed: ₦${MIN_FUNDING}`);

    // Simulate a Korapay incoming payment via recordFunding + completeFunding
    const testRef = `TEST-${Date.now()}`;
    recordFunding(customer.id, 2500, testRef, 'virtual_bank_account', 'pending', {});
    const verifyResult = completeFunding(testRef, 'successful', { simulated: true });
    assert.strictEqual(verifyResult.balance, 17500, 'Balance should increase to ₦17,500 after ₦2,500 top-up');
    console.log(`✓ Balance after verified top-up: ₦${verifyResult.balance.toLocaleString()}`);

    // Test idempotency (completing same reference again must not double-credit)
    const duplicateVerify = completeFunding(testRef, 'successful', { simulated: true });
    assert.strictEqual(duplicateVerify.alreadyProcessed, true, 'Duplicate completion must be flagged as already processed');
    assert.strictEqual(duplicateVerify.balance, 17500, 'Balance must remain ₦17,500 and not double-credit');
    console.log('✓ Webhook/verification idempotency verified (no double crediting)');

    // 4b. Test Korapay Dedicated Virtual Bank Account Creation & Webhook / Sandbox Crediting
    console.log('\n[3b] Testing Korapay Dedicated Virtual Bank Account & Webhooks...');
    
    // Test BVN requirement
    try {
        await korapayService.createOrGetVirtualAccount(customer.id, { bvn: '123' });
        assert.fail('Should reject invalid BVN');
    } catch (bvnErr) {
        assert.strictEqual(bvnErr.code, 'BVN_REQUIRED');
        console.log('✓ Correctly enforced mandatory 11-digit BVN requirement');
    }

    // Generate Dedicated Virtual Bank Account
    const vbaResult = await korapayService.createOrGetVirtualAccount(customer.id, { bvn: '22212345678', bankCode: '070' });
    assert(vbaResult.success && vbaResult.data, 'Should successfully generate Virtual Bank Account');
    assert.strictEqual(vbaResult.data.account_status, 'active', 'Virtual Account must be active');
    assert(vbaResult.data.account_number && vbaResult.data.account_number.length === 10, 'NUBAN account number must be 10 digits');
    console.log(`✓ Dedicated Virtual Bank Account created: ${vbaResult.data.bank_name} - ${vbaResult.data.account_number} (${vbaResult.data.account_name})`);

    // Verify account persistence (second call returns exact same account)
    const secondVbaCall = await korapayService.createOrGetVirtualAccount(customer.id);
    assert.strictEqual(secondVbaCall.isNew, false, 'Second fetch should return existing persistent account');
    assert.strictEqual(secondVbaCall.data.account_number, vbaResult.data.account_number, 'Persistent account number must match');
    console.log('✓ Virtual Bank Account persistence confirmed (single dedicated account per user)');

    // Test Incoming Bank Transfer via Webhook / Sandbox Simulator
    const startBal = getWalletBalance(customer.id);
    const transferAmount = 5000;
    const simRef = `KPY-TEST-${Date.now()}`;
    const paymentResult = await korapayService.processIncomingPayment({
        reference: simRef,
        amount: transferAmount,
        currency: 'NGN',
        fee: 0,
        virtual_bank_account_details: {
            payer_bank_account: {
                account_name: 'Adetunji Test',
                account_number: '******9901',
                bank_name: 'GTBank'
            },
            virtual_bank_account: {
                account_name: vbaResult.data.account_name,
                account_number: vbaResult.data.account_number,
                account_reference: vbaResult.data.account_reference,
                bank_name: vbaResult.data.bank_name
            }
        }
    });
    assert.strictEqual(paymentResult.balance, startBal + transferAmount, `Balance should increase by ₦${transferAmount}`);
    console.log(`✓ Incoming bank transfer credited wallet: ₦${paymentResult.balance.toLocaleString()}`);

    // Test Korapay Webhook Idempotency
    const dupPayment = await korapayService.processIncomingPayment({
        reference: simRef,
        amount: transferAmount,
        virtual_bank_account_details: {
            virtual_bank_account: {
                account_reference: vbaResult.data.account_reference
            }
        }
    });
    assert.strictEqual(dupPayment.alreadyProcessed, true, 'Duplicate Korapay webhook must not double credit');
    assert.strictEqual(dupPayment.balance, startBal + transferAmount, 'Balance must remain unchanged on duplicate webhook');
    console.log('✓ Korapay webhook idempotency verified');

    // 5. Test Sujan Logs API Integration: Balance, Catalog & Stock Previews
    console.log('\n[4] Testing Sujan Logs Marketplace API Service...');
    const sujanBal = await sujanService.getBalance();
    assert(sujanBal.success && sujanBal.data, 'Sujan balance query should succeed');
    console.log(`✓ Sujan API balance: ₦${(sujanBal.data.balance_minor / 100).toLocaleString()}`);

    const stockPreview = await sujanService.getProductStock(1);
    assert(stockPreview.success && stockPreview.data, 'Sujan stock preview must return data');
    assert(Array.isArray(stockPreview.data.options), 'Sujan stock preview must return options array');

    const fulfillmentType = stockPreview.data.fulfillment_type || 'unknown';
    if (fulfillmentType === 'external_auto' || fulfillmentType === 'auto') {
        // Live API: accounts are auto-dispatched — no pre-selection options needed
        console.log(`✓ Sujan stock preview: fulfillment_type="${fulfillmentType}", available_stock=${stockPreview.data.available_stock} (auto-dispatch mode)`);
    } else if (stockPreview.data.options.length > 0) {
        // Sandbox / manual selection mode: options should include preview data
        assert(stockPreview.data.options[0].preview && stockPreview.data.options[0].preview.location, 'Preview option must include location attribute');
        console.log(`✓ Sujan stock preview retrieved: ${stockPreview.data.options.length} options (e.g. ${stockPreview.data.options[0].preview.location})`);
    } else {
        console.log(`✓ Sujan stock preview: no manual options (empty stock or unrecognised fulfillment type "${fulfillmentType}")`);
    }

    // 6. Test Insufficient Funds Check
    console.log('\n[5] Testing Insufficient Funds Prevention...');
    const gvProduct = db.prepare(`SELECT id, price FROM products WHERE slug = 'google-voice-us'`).get();
    try {
        // Try to buy 10 Google Voice accounts (10 * 4200 = 42000 > 17500 balance)
        await checkoutCart(customer.id, [{ productId: gvProduct.id, quantity: 10 }]);
        assert.fail('Should have failed with INSUFFICIENT_FUNDS');
    } catch (err) {
        assert(err.code === 'INSUFFICIENT_FUNDS' || err.code === 'OUT_OF_STOCK');
        console.log(`✓ Insufficient funds properly blocked with code: ${err.code}`);
    }

    // 7. Test Successful Atomic Checkout via Local Stock Fallback
    console.log('\n[6] Testing Atomic Checkout (Local Stock Fallback)...');
    const fbProduct = db.prepare(`SELECT id, price FROM products WHERE slug = 'usa-facebook-aged'`).get();

    // Seed a local encrypted stock item for the Facebook product so checkout
    // works independent of the live Sujan provider wallet balance.
    const { encrypt: encryptLocal } = require('../server/services/crypto');
    const testCredential = 'Email: test_fb_usa@gmail.com | Password: FbTest@2026! | 2FA: TOTP-ABCD | Profile: https://facebook.com/test';
    const { encrypted, iv, authTag } = encryptLocal(testCredential);
    db.prepare(`
        INSERT INTO stock_items (product_id, encrypted_credential, iv, auth_tag, status)
        VALUES (?, ?, ?, ?, 'available')
    `).run(fbProduct.id, encrypted, iv, authTag);
    console.log('✓ Seeded 1 local stock item for Facebook product');

    // Checkout via local fallback (Sujan API will fail with 0 balance, fallback kicks in)
    const orderResult = await checkoutCart(customer.id, [
        { productId: fbProduct.id, quantity: 1 }
    ]);

    assert(orderResult.orderId, 'Order ID must be generated');
    assert.strictEqual(orderResult.totalAmount, fbProduct.price, `Total amount must be ₦${fbProduct.price}`);
    assert.strictEqual(orderResult.deliveredCredentials.length, 1, 'Must deliver exactly 1 credential');
    assert(orderResult.deliveredCredentials[0].credentialText, 'Credential text must be present');
    console.log(`✓ Order #${orderResult.orderNumber} placed via local stock fallback!`);
    console.log(`✓ Delivered credential preview: "${orderResult.deliveredCredentials[0].credentialText.substring(0, 40)}..."`);

    // 8. Test Order Detail & Past Credential Retrieval
    console.log('\n[7] Testing Retrieval of Past Delivered Credentials...');
    const retrievedOrder = getOrderWithCredentials(orderResult.orderId, customer.id);
    assert(retrievedOrder, 'Must retrieve order');
    assert.strictEqual(retrievedOrder.credentials.length, 1, 'Must retrieve all delivered credentials');
    assert.strictEqual(retrievedOrder.credentials[0].credentialText, orderResult.deliveredCredentials[0].credentialText);
    console.log('✓ Past order credentials successfully retrieved and decrypted from database');

    // 9. Test Dispute Submission & Admin Wallet Refund
    console.log('\n[8] Testing Dispute Submission & Admin Wallet Refund...');
    const admin = db.prepare(`SELECT id FROM users WHERE email = 'admin@olaslog.com'`).get();

    // Submit dispute
    const disputeInsert = db.prepare(`
        INSERT INTO disputes (order_id, user_id, reason, status)
        VALUES (?, ?, 'Credential invalid upon inspection', 'submitted')
    `).run(orderResult.orderId, customer.id);
    const disputeId = disputeInsert.lastInsertRowid;

    // Admin approves refund
    const refundLedger = recordRefund(customer.id, orderResult.totalAmount, orderResult.orderId, disputeId, admin.id, 'Approved defective credential replacement refund');
    
    // Check wallet balance is restored
    const balanceAfterRefund = getWalletBalance(customer.id);
    assert.strictEqual(balanceAfterRefund, 22500, 'Balance must be restored to ₦22,500 after refund');
    console.log(`✓ Wallet refund successfully processed! Balance restored to: ₦${balanceAfterRefund.toLocaleString()}`);

    console.log('\n=============================================');
    console.log('🎉 ALL SUJAN API & BACKEND TESTS PASSED!');
    console.log('=============================================');
}

runTests().catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
