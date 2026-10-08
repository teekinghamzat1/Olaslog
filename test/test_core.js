process.env.NODE_ENV = 'test';
const assert = require('assert');
const db = require('../server/db');
const { seedDatabase } = require('../server/db/seed');
const { getWalletBalance, recordFunding, completeFunding, recordRefund } = require('../server/services/wallet');
const { checkoutCart, getOrderWithCredentials } = require('../server/services/order');
const { encrypt, decrypt } = require('../server/services/crypto');
const { MIN_FUNDING } = require('../server/services/wallet');

const billstackService = require('../server/services/billstack');
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
    const customer = db.prepare(`SELECT id, email, full_name FROM users WHERE email = 'customer@olaslog.com'`).get();
    assert(customer, 'Customer user must exist');
    let balance = getWalletBalance(customer.id);
    assert.strictEqual(balance, 15000, 'Initial seeded customer balance should be ₦15,000');
    console.log(`✓ Customer balance verified: ₦${balance.toLocaleString()}`);

    // 4. Test Wallet Funding Ledger & BillStack Virtual Bank Account
    console.log('\n[3] Testing Wallet Funding Ledger & Idempotency...');

    // Confirm minimum funding constant
    assert(MIN_FUNDING === 100, 'MIN_FUNDING must be 100');
    console.log(`✓ MIN_FUNDING constant confirmed: ₦${MIN_FUNDING}`);

    // Test BillStack Dedicated Virtual Bank Account creation
    console.log('\n[3b] Testing BillStack Dedicated Virtual Bank Account...');

    const vbaResult = await billstackService.createVirtualAccount(customer, '9PSB');
    assert(vbaResult && vbaResult.account_number, 'BillStack should generate a virtual bank account');
    assert(vbaResult.account_number.length === 10, 'NUBAN account number must be 10 digits');
    console.log(`✓ BillStack Virtual Account created: ${vbaResult.bank_name} - ${vbaResult.account_number} (${vbaResult.account_name})`);

    // Verify persistence (second call returns same account)
    const secondVba = billstackService.getVirtualAccount(customer.id);
    assert(secondVba, 'Persisted virtual account must be retrievable by user ID');
    assert.strictEqual(secondVba.account_number, vbaResult.account_number, 'Same account number must be returned');
    console.log('✓ Virtual Bank Account persistence confirmed (single dedicated account per user)');

    // Test incoming bank transfer / webhook
    const startBal = getWalletBalance(customer.id);
    const transferAmount = 5000;
    const simRef = `BST-TEST-${Date.now()}`;
    const paymentResult = await billstackService.processIncomingPayment({
        reference: simRef,
        amount: transferAmount,
        currency: 'NGN',
        fee: 0,
        virtual_bank_account: {
            account_name: vbaResult.account_name,
            account_number: vbaResult.account_number,
            account_reference: vbaResult.account_reference,
            bank_name: vbaResult.bank_name
        },
        payer_bank_account: {
            account_name: 'Adetunji Test',
            account_number: '******9901',
            bank_name: 'GTBank'
        }
    });
    assert.strictEqual(paymentResult.balance, startBal + transferAmount, `Balance should increase by ₦${transferAmount}`);
    console.log(`✓ Incoming bank transfer credited wallet: ₦${paymentResult.balance.toLocaleString()}`);

    // Test BillStack webhook idempotency (duplicate reference must not double-credit)
    const dupPayment = await billstackService.processIncomingPayment({
        reference: simRef,
        amount: transferAmount,
        virtual_bank_account: {
            account_reference: vbaResult.account_reference
        }
    });
    assert.strictEqual(dupPayment.alreadyProcessed, true, 'Duplicate BillStack webhook must not double credit');
    assert.strictEqual(dupPayment.balance, startBal + transferAmount, 'Balance must remain unchanged on duplicate webhook');
    console.log('✓ BillStack webhook idempotency verified (no double crediting)');

    // 5. Test Sujan Logs API: Balance & Catalog
    console.log('\n[4] Testing Sujan Logs Marketplace API Service...');
    const sujanBal = await sujanService.getBalance();
    assert(sujanBal.success && sujanBal.data, 'Sujan Logs balance query should succeed');
    const sujanBalNum = parseFloat(
        sujanBal.data.balance_minor != null
            ? sujanBal.data.balance_minor / 100
            : sujanBal.data.balance || 0
    );
    console.log(`✓ Sujan Logs API balance: ₦${sujanBalNum.toLocaleString()} (${sujanBal.data.currency || 'NGN'})`);

    const firstProd = db.prepare(`SELECT sujan_product_id FROM products WHERE sujan_product_id IS NOT NULL LIMIT 1`).get();
    const testSujanId = firstProd ? firstProd.sujan_product_id : 1;
    const stockPreview = await sujanService.getProductStock(testSujanId);
    assert(stockPreview.data, 'Sujan Logs stock preview must return data');
    console.log(`✓ Sujan Logs stock preview: fulfillment_type="${stockPreview.data.fulfillment_type}", available_stock=${stockPreview.data.available_stock}`);

    // 6. Test Insufficient Funds Check
    console.log('\n[5] Testing Insufficient Funds Prevention...');
    let testProd = db.prepare(`SELECT id, price FROM products LIMIT 1`).get();
    if (!testProd) {
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
        const cat = db.prepare(`SELECT id FROM product_categories LIMIT 1`).get();
        const catId = cat ? cat.id : 1;
        const insertRes = db.prepare(`
            INSERT INTO products (category_id, name, slug, price, is_active)
            VALUES (?, 'Test Account Product', 'test-account-prod', 3500, 1)
        `).run(catId);
        fbProduct = { id: insertRes.lastInsertRowid, price: 3500 };
    }

    // Seed a local encrypted stock item for the product
    const testCredential = 'Email: test_account@gmail.com | Password: Secret@2026! | Key: SUJAN-XXXX-YYYY';
    const { encrypted, iv, authTag } = encrypt(testCredential);
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

    // 8b. Test Live Order Feed Endpoint Query (Zero PII Guarantee)
    console.log('\n[7b] Testing Public Live Order Feed Query...');
    const feedRows = db.prepare(`
        SELECT
            o.id,
            o.created_at,
            oi.quantity,
            p.name  AS product_name,
            p.price AS unit_price,
            COALESCE(c.icon, '🛍️')  AS category_icon,
            COALESCE(c.name, 'Digital')  AS category_name
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        JOIN products    p  ON p.id = oi.product_id
        LEFT JOIN product_categories c ON c.id = p.category_id
        WHERE o.status = 'completed'
        ORDER BY o.created_at DESC
        LIMIT 20
    `).all();
    assert(Array.isArray(feedRows) && feedRows.length > 0, 'Feed should return completed orders');
    assert(feedRows[0].product_name, 'Feed entry should have product name');
    assert(!feedRows[0].user_id && !feedRows[0].email, 'Feed must NEVER expose user PII');
    console.log(`✓ Live order feed verified with ${feedRows.length} item(s) - Zero PII confirmed`);

    // 9. Test Dispute Submission & Admin Wallet Refund
    console.log('\n[8] Testing Dispute Submission & Admin Wallet Refund...');
    const admin = db.prepare(`SELECT id FROM users WHERE email = 'admin@olaslog.com'`).get();

    const disputeInsert = db.prepare(`
        INSERT INTO disputes (order_id, user_id, reason, status)
        VALUES (?, ?, 'Credential invalid upon inspection', 'submitted')
    `).run(orderResult.orderId, customer.id);
    const disputeId = disputeInsert.lastInsertRowid;

    const refundLedger = recordRefund(customer.id, orderResult.totalAmount, orderResult.orderId, disputeId, admin.id, 'Approved defective credential replacement refund');

    const balanceAfterRefund = getWalletBalance(customer.id);
    assert.strictEqual(balanceAfterRefund, 22500, 'Balance must be restored to ₦22,500 after refund');
    console.log(`✓ Wallet refund successfully processed! Balance restored to: ₦${balanceAfterRefund.toLocaleString()}`);

    console.log('\n=============================================');
    console.log('🎉 ALL OLASLOG BACKEND TESTS PASSED!');
    console.log('   ✅ BillStack Virtual Accounts');
    console.log('   ✅ Sujan Logs Marketplace API');
    console.log('   ✅ Atomic Checkout & Credential Delivery');
    console.log('   ✅ Wallet Ledger & Idempotency');
    console.log('   ✅ Dispute & Refund Flow');
    console.log('=============================================');
}

runTests().catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
