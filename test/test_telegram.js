'use strict';

const assert = require('assert');
const crypto = require('crypto');
const db = require('../server/db');
const telegramAuth = require('../server/services/telegramAuth');
const telegramBot = require('../server/services/telegramBot');

async function runTelegramTests() {
    console.log('🧪 === Starting Olaslog Telegram Integration Tests ===\n');

    const testBotToken = '123456789:ABCdefGHIjklMNOpqrsTUVwxyz';

    // Helper: generate valid Telegram WebApp initData string
    function generateMockInitData(userObj, authDate = Math.floor(Date.now() / 1000)) {
        const params = new URLSearchParams();
        params.set('auth_date', String(authDate));
        params.set('query_id', 'AAHdF6IQAAAAAN0XohD97aL_');
        params.set('user', JSON.stringify(userObj));

        const pairs = [];
        for (const [k, v] of params.entries()) {
            pairs.push(`${k}=${v}`);
        }
        pairs.sort();
        const dataCheckString = pairs.join('\n');

        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(testBotToken).digest();
        const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

        params.set('hash', hash);
        return params.toString();
    }

    // 1. Test HMAC Signature Verification
    console.log('[1] Testing Telegram WebApp initData HMAC verification...');
    const mockUser = {
        id: 9988776655,
        first_name: 'Ola',
        last_name: 'Market',
        username: 'olamarket2026',
        photo_url: 'https://t.me/i/userpics/ola.jpg'
    };

    const validInitData = generateMockInitData(mockUser);
    const validResult = telegramAuth.validateTelegramInitData(validInitData, testBotToken);

    assert(validResult.valid === true, 'Valid initData should pass validation');
    assert.strictEqual(validResult.user.id, mockUser.id, 'Validated user ID should match');
    assert.strictEqual(validResult.user.username, mockUser.username, 'Validated username should match');
    console.log('  ✓ HMAC-SHA256 signature verification passed');

    // 2. Test Rejection of Tampered Data
    console.log('\n[2] Testing rejection of tampered initData...');
    const tamperedInitData = validInitData.replace('olamarket2026', 'hacker2026');
    const tamperedResult = telegramAuth.validateTelegramInitData(tamperedInitData, testBotToken);
    assert(tamperedResult.valid === false, 'Tampered initData must be rejected');
    console.log('  ✓ Tampered HMAC correctly rejected');

    // 3. Test Rejection of Expired initData
    console.log('\n[3] Testing rejection of expired initData (>24h)...');
    const twoDaysAgo = Math.floor(Date.now() / 1000) - (2 * 86400);
    const expiredInitData = generateMockInitData(mockUser, twoDaysAgo);
    const expiredResult = telegramAuth.validateTelegramInitData(expiredInitData, testBotToken);
    assert(expiredResult.valid === false, 'Expired initData must be rejected');
    assert(expiredResult.error.includes('expired'), 'Error message should indicate expiration');
    console.log('  ✓ Expired initData correctly rejected');

    // 4. Test User Auto-Provisioning & Linking in SQLite
    console.log('\n[4] Testing user auto-provisioning via Telegram...');
    // Clean up test user if exists
    db.prepare('DELETE FROM users WHERE telegram_id = ?').run(String(mockUser.id));

    const createdUser = telegramAuth.findOrCreateTelegramUser(mockUser);
    assert(createdUser && createdUser.id, 'User record must be created');
    assert.strictEqual(createdUser.telegram_id, String(mockUser.id), 'Stored telegram_id must match');
    assert.strictEqual(createdUser.telegram_username, mockUser.username, 'Stored username must match');
    assert.strictEqual(createdUser.full_name, 'Ola Market', 'Full name should be combined');
    console.log(`  ✓ Auto-provisioned user #${createdUser.id} (${createdUser.email})`);

    // 5. Test Finding Existing Telegram User (Idempotency)
    console.log('\n[5] Testing lookup idempotency for existing Telegram user...');
    const fetchedUser = telegramAuth.findOrCreateTelegramUser(mockUser);
    assert.strictEqual(fetchedUser.id, createdUser.id, 'Should retrieve existing user ID without creating duplicate');
    console.log('  ✓ Retrieved existing user successfully');

    // 6. Test Bot Methods Interface
    console.log('\n[6] Verifying Bot Service export methods...');
    assert(typeof telegramBot.startBot === 'function', 'startBot method exists');
    assert(typeof telegramBot.stopBot === 'function', 'stopBot method exists');
    assert(typeof telegramBot.sendMessage === 'function', 'sendMessage method exists');
    assert(typeof telegramBot.notifyUserOrderDelivered === 'function', 'notifyUserOrderDelivered method exists');
    assert(typeof telegramBot.notifyUserWalletFunded === 'function', 'notifyUserWalletFunded method exists');
    console.log('  ✓ All Telegram Bot service methods exported and verified');

    // Cleanup
    db.prepare('DELETE FROM users WHERE telegram_id = ?').run(String(mockUser.id));

    console.log('\n🎉 ALL TELEGRAM TESTS PASSED SUCCESSFULLY!\n');
}

runTelegramTests().catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
