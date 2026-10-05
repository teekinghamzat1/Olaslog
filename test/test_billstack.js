const assert = require('assert');
const crypto = require('crypto');
const db = require('../server/db');
const billstackService = require('../server/services/billstack');
const { getWalletBalance } = require('../server/services/wallet');

async function runBillStackTests() {
    console.log('--- Testing BillStack Virtual Account Service ---');

    // 1. Check supported banks
    assert(Array.isArray(billstackService.SUPPORTED_BANKS), 'SUPPORTED_BANKS should be an array');
    assert(billstackService.SUPPORTED_BANKS.some(b => b.id === '9PSB'), '9PSB should be supported');
    assert(billstackService.SUPPORTED_BANKS.some(b => b.id === 'PALMPAY'), 'PALMPAY should be supported');
    console.log('✓ Supported banks verified:', billstackService.SUPPORTED_BANKS.map(b => b.id).join(', '));

    // Get a test user
    const user = db.prepare(`SELECT id, email, full_name FROM users WHERE role = 'customer' LIMIT 1`).get();
    assert(user, 'Test customer user must exist');

    // Clean up any existing virtual accounts for this test user
    db.prepare(`DELETE FROM user_virtual_accounts WHERE user_id = ?`).run(user.id);

    // 2. Test PalmPay validation
    try {
        await billstackService.createOrGetVirtualAccount(user.id, { bankId: 'PALMPAY' });
        assert.fail('PalmPay without NIN/BVN should throw PALMPAY_ID_REQUIRED');
    } catch (err) {
        assert.strictEqual(err.code, 'PALMPAY_ID_REQUIRED', 'Error code should be PALMPAY_ID_REQUIRED');
        console.log('✓ PalmPay requires idType & idNumber properly enforced');
    }

    // 3. Test 9PSB account generation (mock mode)
    const result = await billstackService.createOrGetVirtualAccount(user.id, { bankId: '9PSB', phone: '08012345678' });
    assert(result.success, 'createOrGetVirtualAccount should succeed');
    assert(result.data, 'Virtual account data should exist');
    assert(result.data.account_number, 'Account number must be generated');
    assert.strictEqual(result.data.bank_code, '9PSB');
    console.log(`✓ Generated 9PSB Virtual Account: ${result.data.account_number} (${result.data.account_name})`);

    // 4. Test Retrieval
    const retrieved = billstackService.getVirtualAccount(user.id);
    assert(retrieved, 'Should retrieve stored virtual account');
    assert.strictEqual(retrieved.account_number, result.data.account_number);
    console.log('✓ Stored virtual account retrieval confirmed');

    // 5. Test Webhook Payment Processing
    const balanceBefore = getWalletBalance(user.id);
    const transferRef = `BSTK_TX_${Date.now()}`;
    const webhookPayload = {
        event: 'PAYMENT_NOTIFICATION',
        reference: transferRef,
        amount: 3000,
        currency: 'NGN',
        accountNumber: result.data.account_number,
        bankCode: '9PSB',
        customer: {
            email: user.email,
            phone: '08012345678'
        }
    };

    const paymentResult = await billstackService.processIncomingPayment(webhookPayload);
    assert.strictEqual(paymentResult.alreadyProcessed, false, 'Payment should be processed');

    const balanceAfter = getWalletBalance(user.id);
    assert.strictEqual(balanceAfter, balanceBefore + 3000, 'Balance must increase by 3000');
    console.log(`✓ Wallet credited successfully: ₦${balanceBefore.toLocaleString()} -> ₦${balanceAfter.toLocaleString()}`);

    // 6. Test Webhook Idempotency (duplicate payment notification)
    const dupResult = await billstackService.processIncomingPayment(webhookPayload);
    assert.strictEqual(dupResult.alreadyProcessed, true, 'Duplicate webhook must not double credit');
    const balanceAfterDup = getWalletBalance(user.id);
    assert.strictEqual(balanceAfterDup, balanceAfter, 'Balance must remain unchanged on duplicate webhook');
    console.log('✓ BillStack webhook idempotency verified (no double crediting)');

    console.log('\n=============================================');
    console.log('🎉 ALL BILLSTACK TESTS PASSED!');
    console.log('=============================================\n');
}

runBillStackTests().catch(err => {
    console.error('Test error:', err);
    process.exit(1);
});
