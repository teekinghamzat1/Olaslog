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
const { getWalletBalance } = require('../server/services/wallet');
const { encrypt } = require('../server/services/crypto');
const sujanService = require('../server/services/sujan');
const emailService = require('../server/services/email');
const telegram = require('../server/services/telegram');
const telegramBot = require('../server/services/telegramBot');
const { checkoutCart } = require('../server/services/order');

// Hard-disable outbound notifications for this test process.
emailService.sendPurchaseEmail = async () => ({ skipped: true });
telegram.notifyLowStock = async () => ({ skipped: true });
telegramBot.notifyUserOrderDelivered = async () => ({ skipped: true });

async function run() {
    // This runs only in a fresh, disposable CI database.
    seedDatabase();

    const customer = db.prepare("SELECT id FROM users WHERE email = 'customer@olaslog.com'").get();
    assert(customer, 'Seeded test customer must exist');

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
    console.log('PASS: supplier timeout fails closed, preserves local stock, and records a reconciliation audit');

    console.log('ALL OFFLINE CHECKOUT TESTS PASSED. No provider, payment, email, or Telegram API calls were made.');
}

run().catch(error => {
    console.error('OFFLINE CHECKOUT TEST FAILED:', error);
    process.exitCode = 1;
});
