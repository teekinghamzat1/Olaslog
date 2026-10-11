'use strict';

const assert = require('assert');
const db = require('../server/db');
const phoneVerify = require('../server/services/phoneVerify');
const { getWalletBalance } = require('../server/services/wallet');

async function runTests() {
    console.log('🧪 Starting Phone Verification Integration Tests...');

    // Test 1: Pricing Calculation
    console.log('\n--- Test 1: Pricing Engine Calculation ---');
    const settings = phoneVerify.getSettings();
    console.log('Settings:', settings);
    assert.strictEqual(typeof settings.usdRate, 'number', 'usdRate should be a number');
    assert.strictEqual(typeof settings.marginPercent, 'number', 'marginPercent should be a number');

    const testPriceNgn = phoneVerify.calculateNgnPrice(0.60, { usdRate: 1500, marginPercent: 25, minPriceNgn: 800 });
    // 0.60 * 1500 * 1.25 = 1125 -> ceil to 50 = 1150
    assert.strictEqual(testPriceNgn, 1150, `Expected 1150 NGN, got ${testPriceNgn}`);
    console.log(`✅ Pricing calculated correctly: $0.60 USD -> ₦${testPriceNgn} NGN`);

    // Test 2: Services List with fallback metadata
    console.log('\n--- Test 2: Services Listing & Metadata Enrichment ---');
    const services = await phoneVerify.listServices();
    assert(Array.isArray(services), 'Services should be an array');
    assert(services.length > 0, 'Services list should not be empty');
    const whatsApp = services.find(s => s.name === 'WhatsApp');
    assert(whatsApp, 'WhatsApp should be present in services list');
    assert.strictEqual(whatsApp.category, 'Social');
    console.log(`✅ Loaded ${services.length} services. Sample WhatsApp price: ${whatsApp.priceFormatted}`);

    // Test 3: Phone number formatting
    console.log('\n--- Test 3: US Phone Number Display Formatting ---');
    const formatted = phoneVerify.formatUsPhoneNumber('15302286946');
    assert.strictEqual(formatted, '+1 (530) 228-6946', `Expected formatted number, got ${formatted}`);
    console.log(`✅ Phone number formatted cleanly: 15302286946 -> ${formatted}`);

    // Test 4: Database Tables Verification
    console.log('\n--- Test 4: Database Schema Integrity ---');
    const tableCheck = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='phone_verifications'`).get();
    assert(tableCheck, 'phone_verifications table must exist in SQLite database');

    const settingsTableCheck = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='verification_settings'`).get();
    assert(settingsTableCheck, 'verification_settings table must exist in SQLite database');
    console.log('✅ phone_verifications and verification_settings tables exist in database');

    // Test 5: Simulated Webhook Incoming Message
    console.log('\n--- Test 5: Webhook Incoming Message & OTP Parsing ---');
    // Create a temporary user if needed
    let testUser = db.prepare(`SELECT id FROM users WHERE email = 'test_verify_user@olaslog.com'`).get();
    if (!testUser) {
        const res = db.prepare(`
            INSERT INTO users (email, password_hash, full_name, phone, role, is_verified)
            VALUES ('test_verify_user@olaslog.com', 'dummy_hash', 'Verify Tester', '+234800000000', 'customer', 1)
        `).run();
        testUser = { id: res.lastInsertRowid };
    }

    const testReqId = `TEST-REQ-${Date.now()}`;
    db.prepare(`
        INSERT INTO phone_verifications
        (user_id, request_id, service_name, phone_number, cost_usd, cost_ngn, status, expires_at)
        VALUES (?, ?, 'Telegram', '15302286946', 0.80, 1500, 'reserved', datetime('now', '+15 minutes'))
    `).run(testUser.id, testReqId);

    // Call webhook event
    await phoneVerify.handleWebhookEvent({
        event: 'incoming_message',
        id: testReqId,
        reply: 'Your Telegram code is 78291. Do not share it with anyone.',
        pin: '78291',
        from: 'Telegram'
    });

    const updated = db.prepare(`SELECT * FROM phone_verifications WHERE request_id = ?`).get(testReqId);
    assert.strictEqual(updated.status, 'completed', 'Verification status should be completed');
    assert.strictEqual(updated.otp_code, '78291', 'OTP code should be 78291');
    assert(updated.sms_reply.includes('Your Telegram code is 78291'), 'SMS reply should be stored');
    console.log('✅ Webhook successfully stored OTP PIN: ' + updated.otp_code);

    // Test 6: Wallet Cancellation & Instant 100% Refund
    console.log('\n--- Test 6: Cancel & Instant 100% Wallet Refund ---');
    const initialBalance = getWalletBalance(testUser.id);
    const cancelReqId = `TEST-CANCEL-${Date.now()}`;

    const insertRes = db.prepare(`
        INSERT INTO phone_verifications
        (user_id, request_id, service_name, phone_number, cost_usd, cost_ngn, status, expires_at)
        VALUES (?, ?, 'Google', '18503814729', 0.50, 1000, 'reserved', datetime('now', '+15 minutes'))
    `).run(testUser.id, cancelReqId);

    const cancelResult = await phoneVerify.cancelAndRefund(insertRes.lastInsertRowid, testUser.id);
    assert.strictEqual(cancelResult.success, true);
    assert.strictEqual(cancelResult.refundAmount, 1000);

    const newBalance = getWalletBalance(testUser.id);
    assert.strictEqual(newBalance, initialBalance + 1000, 'User wallet balance should be credited with 1000 NGN');
    console.log(`✅ Cancelled and refunded ₦1,000 back to wallet. New Balance: ₦${newBalance}`);

    // Cleanup test records
    db.prepare(`DELETE FROM phone_verifications WHERE user_id = ?`).run(testUser.id);
    db.prepare(`DELETE FROM wallet_transactions WHERE user_id = ?`).run(testUser.id);
    db.prepare(`DELETE FROM users WHERE id = ?`).run(testUser.id);

    console.log('\n🎉 ALL PHONE VERIFICATION INTEGRATION TESTS PASSED SUCCESSFULLY!\n');
}

runTests().catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
