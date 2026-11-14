const bcrypt = require('bcryptjs');
const db = require('./index');
const { recordFunding } = require('../services/wallet');

/**
 * This is a destructive development reset, NOT a production seed or migration.
 * It deletes users, wallet history, orders, delivered credentials and inventory.
 * Require both an explicit development environment and an opt-in flag.
 */
function assertSafeSeedEnvironment() {
    if (process.env.NODE_ENV !== 'development') {
        throw new Error('Refusing to run destructive seed: NODE_ENV must be exactly "development".');
    }
    if (process.env.ALLOW_DESTRUCTIVE_SEED !== 'true') {
        throw new Error('Refusing to run destructive seed: set ALLOW_DESTRUCTIVE_SEED=true only when you intend to reset a development database.');
    }
}

function seedDatabase() {
    assertSafeSeedEnvironment();

    const runSeed = db.transaction(() => {
        console.log('Seeding Olaslog development database...');

        // This reset intentionally removes user-related development data.
        // It must never run against a production database.
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

        // 1. Create development users
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

        console.log('Created development admin and customer users');

        // 2. Pre-fund the demo customer wallet for local testing
        recordFunding(
            customerId,
            15000,
            `WAL-SEED-${Date.now()}`,
            'billstack',
            'successful',
            { note: 'Development-only starter wallet balance' }
        );

        // 3. Audit log
        db.prepare(`
            INSERT INTO audit_logs (admin_id, action, target_entity, details)
            VALUES (?, 'SYSTEM_SEED', 'DATABASE', 'Initialized development users and wallet.')
        `).run(adminId);

        console.log('Development seed completed successfully.');
    });

    runSeed();
}

if (require.main === module) {
    try {
        seedDatabase();
    } catch (err) {
        console.error('[Seed] Aborted:', err.message);
        process.exitCode = 1;
    }
}

module.exports = { seedDatabase };
