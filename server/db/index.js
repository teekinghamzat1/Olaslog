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
} catch (migErr) {
    console.warn('DB Migration notice:', migErr.message);
}

module.exports = db;
