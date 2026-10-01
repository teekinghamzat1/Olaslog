process.env.NODE_ENV = 'test';
const assert = require('assert');
const db = require('../server/db');
const { seedDatabase } = require('../server/db/seed');
const { getWalletBalance, recordFunding, completeFunding, recordRefund } = require('../server/services/wallet');
const { checkoutCart, getOrderWithCredentials } = require('../server/services/order');
const { encrypt, decrypt } = require('../server/services/crypto');
const { MIN_FUNDING } = require('../server/services/wallet');

const korapayService = require('../server/services/korapay');
const rakibService = require('../server/services/rakib');

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

    // Test Korapay Standard Checkout initialization
    const checkoutInit = await korapayService.initializeCheckout(customer.id, customer.email, customer.full_name, 2500);
    assert(checkoutInit.success && checkoutInit.reference && checkoutInit.checkoutUrl, 'Checkout init should return reference and checkoutUrl');
    console.log(`✓ Korapay standard checkout initialized: ${checkoutInit.reference}`);

    // Verify checkout funding
    const verifyResult = await korapayService.verifyPayment(checkoutInit.reference);
    assert.strictEqual(verifyResult.balance, 17500, 'Balance should increase to ₦17,500 after ₦2,500 top-up');
    console.log(`✓ Balance after verified top-up: ₦${verifyResult.balance.toLocaleString()}`);

    // Test idempotency (verifying same reference again must not double credit)
    const duplicateVerify = await korapayService.verifyPayment(checkoutInit.reference);
    assert.strictEqual(duplicateVerify.alreadyProcessed, true, 'Duplicate completion must be flagged as already processed');
    assert.strictEqual(duplicateVerify.balance, 17500, 'Balance must remain ₦17,500 and not double-credit');
    console.log('✓ Korapay checkout verification idempotency verified (no double crediting)');

    // 4b. Test Korapay Dedicated Virtual Bank Account & Webhooks (when enabled)
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

    // 5. Test Rakib Socials API Integration: Balance, Catalog & Stock Previews
    console.log('\n[4] Testing Rakib Socials Marketplace API Service...');
    const rakibBal = await rakibService.getBalance();
    assert(rakibBal.success && rakibBal.data, 'Rakib balance query should succeed');
    const balNum = parseFloat(rakibBal.data.balance || rakibBal.data.balance_minor / 100 || 0);
    console.log(`✓ Rakib API balance: ₦${balNum.toLocaleString()} (${rakibBal.data.currency || 'NGN'})`);

    const stockPreview = await rakibService.getProductStock(128);
    assert(stockPreview.success && stockPreview.data, 'Rakib stock preview must return data');
    console.log(`✓ Rakib stock preview: fulfillment_type="${stockPreview.data.fulfillment_type}", available_stock=${stockPreview.data.available_stock}`);

    // 6. Test Insufficient Funds Check
    console.log('\n[5] Testing Insufficient Funds Prevention...');
    let testProd = db.prepare(`SELECT id, price FROM products LIMIT 1`).get();
    if (!testProd) {
        // Fallback product if table was just cleared
        testProd = { id: 1, price: 4500 };
    }
    try {
        // Try to buy 100 accounts (exceeds balance)
        await checkoutCart(customer.id, [{ productId: testProd.id, quantity: 100 }]);
        assert.fail('Should have failed with INSUFFICIENT_FUNDS');
    } catch (err) {
        assert(err.code === 'INSUFFICIENT_FUNDS' || err.code === 'OUT_OF_STOCK');
        console.log(`✓ Insufficient funds properly blocked with code: ${err.code}`);
    }

    // 7. Test Successful Atomic Checkout via Local Stock Fallback
    console.log('\n[6] Testing Atomic Checkout (Local Stock Fallback)...');
    let fbProduct = db.prepare(`SELECT id, price FROM products WHERE is_active = 1 LIMIT 1`).get();
    if (!fbProduct) {
        // Ensure a product exists for checkout test
        const cat = db.prepare(`SELECT id FROM product_categories LIMIT 1`).get();
        const catId = cat ? cat.id : 1;
        const insertRes = db.prepare(`
            INSERT INTO products (category_id, name, slug, price, is_active)
            VALUES (?, 'Test Account Product', 'test-account-prod', 3500, 1)
        `).run(catId);
        fbProduct = { id: insertRes.lastInsertRowid, price: 3500 };
    }

    // Seed a local encrypted stock item for the product
    const { encrypt: encryptLocal } = require('../server/services/crypto');
    const testCredential = 'Email: test_account@gmail.com | Password: Secret@2026! | Key: RAKIB-XXXX-YYYY';
    const { encrypted, iv, authTag } = encryptLocal(testCredential);
    db.prepare(`
        INSERT INTO stock_items (product_id, encrypted_credential, iv, auth_tag, status)
        VALUES (?, ?, ?, ?, 'available')
    `).run(fbProduct.id, encrypted, iv, authTag);
    console.log('✓ Seeded 1 local stock item for checkout test');

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
    console.log('🎉 ALL RAKIB API & BACKEND TESTS PASSED!');
    console.log('=============================================');
}

runTests().catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
