const bcrypt = require('bcryptjs');
const db = require('./index');
const { recordFunding } = require('../services/wallet');

/**
 * Seeds the Olaslog database with:
 * - Admin and demo customer users
 * - Demo wallet balance for testing
 *
 * NOTE: Products and categories are NOT seeded here.
 * They are synced from the provider API on server startup (see syncCatalogFromSujan in sujan.js).
 * Local stock_items are used ONLY as admin-uploaded backup inventory.
 */
function seedDatabase() {
    console.log('Seeding Olaslog Database...');

    // Clean existing user-related tables only (preserve API-synced products/categories)
    db.exec(`
        DELETE FROM delivered_credentials;
        DELETE FROM order_items;
        DELETE FROM orders;
        DELETE FROM disputes;
        DELETE FROM stock_items;
        DELETE FROM wallet_transactions;
        DELETE FROM audit_logs;
        DELETE FROM users;
    `);

    // 1. Create Users
    const adminPasswordHash = bcrypt.hashSync('Admin@12345', 10);
    const customerPasswordHash = bcrypt.hashSync('Customer@12345', 10);

    const adminResult = db.prepare(`
        INSERT INTO users (email, password_hash, full_name, phone, role, is_verified)
        VALUES ('admin@olaslog.com', ?, 'System Administrator', '+2348011223344', 'admin', 1)
    `).run(adminPasswordHash);
    const adminId = adminResult.lastInsertRowid;

    const customerResult = db.prepare(`
        INSERT INTO users (email, password_hash, full_name, phone, role, is_verified)
        VALUES ('customer@olaslog.com', ?, 'Demo Customer', '+2348099887766', 'customer', 1)
    `).run(customerPasswordHash);
    const customerId = customerResult.lastInsertRowid;

    console.log('Created admin & customer users');

    // 2. Pre-fund Customer Wallet with ₦15,000 for instant testing
    recordFunding(
        customerId,
        15000,
        `WAL-SEED-${Date.now()}`,
        'billstack',
        'successful',
        { note: 'Initial starter wallet balance for testing' }
    );
    console.log('Funded demo customer wallet with ₦15,000');

    // 3. Audit Log
    db.prepare(`
        INSERT INTO audit_logs (admin_id, action, target_entity, details)
        VALUES (?, 'SYSTEM_SEED', 'DATABASE', 'Initialized database users and wallet. Products/categories sourced from provider API.')
    `).run(adminId);

    console.log('Seed completed successfully! Products will auto-sync from provider API on server startup.');
}

if (require.main === module) {
    seedDatabase();
}

module.exports = { seedDatabase };
