const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.resolve(__dirname, 'database.sqlite');
const db = new Database(dbPath);

// Enable WAL mode and foreign keys for high performance & reliability
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize schema
const schemaPath = path.resolve(__dirname, 'schema.sql');
const schema = fs.readFileSync(schemaPath, 'utf8');
db.exec(schema);

// Lightweight migrations for Sujan integration
try {
    const productCols = db.prepare("PRAGMA table_info(products)").all().map(c => c.name);
    if (!productCols.includes('sujan_product_id')) {
        db.exec("ALTER TABLE products ADD COLUMN sujan_product_id INTEGER;");
    }
    if (!productCols.includes('reseller_markup_percent')) {
        db.exec("ALTER TABLE products ADD COLUMN reseller_markup_percent REAL DEFAULT 15;");
    }

    const orderCols = db.prepare("PRAGMA table_info(orders)").all().map(c => c.name);
    if (!orderCols.includes('sujan_order_id')) {
        db.exec("ALTER TABLE orders ADD COLUMN sujan_order_id TEXT;");
    }

    const credCols = db.prepare("PRAGMA table_info(delivered_credentials)").all();
    const stockItemCol = credCols.find(c => c.name === 'stock_item_id');
    if (stockItemCol && stockItemCol.notnull === 1) {
        // Recreate delivered_credentials with nullable stock_item_id
        db.exec(`
            CREATE TABLE IF NOT EXISTS delivered_credentials_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_id INTEGER NOT NULL,
                order_item_id INTEGER NOT NULL,
                product_id INTEGER NOT NULL,
                stock_item_id INTEGER,
                sujan_item_id INTEGER,
                public_data TEXT,
                encrypted_credential TEXT NOT NULL,
                iv TEXT NOT NULL,
                auth_tag TEXT NOT NULL,
                delivered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
                FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON DELETE CASCADE,
                FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
                FOREIGN KEY (stock_item_id) REFERENCES stock_items(id) ON DELETE SET NULL
            );
            INSERT INTO delivered_credentials_new (id, order_id, order_item_id, product_id, stock_item_id, encrypted_credential, iv, auth_tag, delivered_at)
            SELECT id, order_id, order_item_id, product_id, stock_item_id, encrypted_credential, iv, auth_tag, delivered_at FROM delivered_credentials;
            DROP TABLE delivered_credentials;
            ALTER TABLE delivered_credentials_new RENAME TO delivered_credentials;
        `);
    }

    const updatedCredCols = db.prepare("PRAGMA table_info(delivered_credentials)").all().map(c => c.name);
    if (!updatedCredCols.includes('sujan_item_id')) {
        db.exec("ALTER TABLE delivered_credentials ADD COLUMN sujan_item_id INTEGER;");
    }
    if (!updatedCredCols.includes('public_data')) {
        db.exec("ALTER TABLE delivered_credentials ADD COLUMN public_data TEXT;");
    }

    // Pricing control migrations
    const currentProductCols = db.prepare("PRAGMA table_info(products)").all().map(c => c.name);
    if (!currentProductCols.includes('sujan_base_price')) {
        db.exec("ALTER TABLE products ADD COLUMN sujan_base_price REAL;");
    }
    if (!currentProductCols.includes('manual_price_override')) {
        db.exec("ALTER TABLE products ADD COLUMN manual_price_override INTEGER DEFAULT 0;");
    }

    // Rakib API provider migrations
    if (!currentProductCols.includes('rakib_product_id')) {
        db.exec("ALTER TABLE products ADD COLUMN rakib_product_id INTEGER;");
    }
    if (!currentProductCols.includes('rakib_base_price')) {
        db.exec("ALTER TABLE products ADD COLUMN rakib_base_price REAL;");
    }
    // Sync existing Sujan IDs/prices to Rakib fields if empty
    db.exec(`
        UPDATE products SET rakib_product_id = sujan_product_id WHERE rakib_product_id IS NULL AND sujan_product_id IS NOT NULL;
        UPDATE products SET rakib_base_price = sujan_base_price WHERE rakib_base_price IS NULL AND sujan_base_price IS NOT NULL;
    `);

    const currentOrderCols = db.prepare("PRAGMA table_info(orders)").all().map(c => c.name);
    if (!currentOrderCols.includes('rakib_order_id')) {
        db.exec("ALTER TABLE orders ADD COLUMN rakib_order_id TEXT;");
        db.exec("UPDATE orders SET rakib_order_id = sujan_order_id WHERE rakib_order_id IS NULL AND sujan_order_id IS NOT NULL;");
    }

    const currentDeliveredCredCols = db.prepare("PRAGMA table_info(delivered_credentials)").all().map(c => c.name);
    if (!currentDeliveredCredCols.includes('rakib_item_id')) {
        db.exec("ALTER TABLE delivered_credentials ADD COLUMN rakib_item_id TEXT;");
    }

    // Korapay Virtual Bank Accounts table migration
    db.exec(`
        CREATE TABLE IF NOT EXISTS user_virtual_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL UNIQUE,
            account_name TEXT NOT NULL,
            account_number TEXT NOT NULL,
            bank_code TEXT NOT NULL,
            bank_name TEXT NOT NULL,
            account_reference TEXT UNIQUE NOT NULL,
            unique_id TEXT,
            account_status TEXT DEFAULT 'active',
            currency TEXT DEFAULT 'NGN',
            bvn TEXT,
            nin TEXT,
            is_mock INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_vba_account_number ON user_virtual_accounts(account_number);
        CREATE INDEX IF NOT EXISTS idx_vba_account_reference ON user_virtual_accounts(account_reference);
    `);

    // Migration to allow 'debit' and 'adjustment' in wallet_transactions
    const txTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='wallet_transactions'").get();
    if (txTableSql && txTableSql.sql && (!txTableSql.sql.includes('debit') || !txTableSql.sql.includes('adjustment'))) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS wallet_transactions_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                type TEXT CHECK(type IN ('funding', 'purchase', 'refund', 'adjustment', 'debit')) NOT NULL,
                amount REAL NOT NULL,
                balance_before REAL NOT NULL,
                balance_after REAL NOT NULL,
                reference TEXT UNIQUE NOT NULL,
                status TEXT CHECK(status IN ('pending', 'successful', 'failed')) DEFAULT 'pending',
                payment_channel TEXT DEFAULT 'internal',
                description TEXT,
                metadata TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            INSERT INTO wallet_transactions_new (id, user_id, type, amount, balance_before, balance_after, reference, status, payment_channel, description, metadata, created_at)
            SELECT id, user_id, type, amount, balance_before, balance_after, reference, status, payment_channel, description, metadata, created_at FROM wallet_transactions;
            DROP TABLE wallet_transactions;
            ALTER TABLE wallet_transactions_new RENAME TO wallet_transactions;
            CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user ON wallet_transactions(user_id, status);
        `);
        console.log('🔄 Migrated wallet_transactions table to support adjustment and debit ledger types');
    }

    // Auto-bootstrap default admin if none exists
    const adminCheck = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
    if (!adminCheck) {
        const bcrypt = require('bcryptjs');
        const adminPasswordHash = bcrypt.hashSync('Admin@12345', 10);
        db.prepare(`
            INSERT INTO users (email, password_hash, full_name, phone, role, is_verified)
            VALUES ('admin@olaslog.com', ?, 'System Administrator', '+2348011223344', 'admin', 1)
        `).run(adminPasswordHash);
        console.log('🛡️ Auto-initialized default admin account (admin@olaslog.com)');
    }
} catch (migErr) {
    console.warn('DB Migration notice:', migErr.message);
}

module.exports = db;
