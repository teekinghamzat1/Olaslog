const express = require('express');
const router = express.Router();
const db = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { encrypt, decrypt } = require('../services/crypto');
const { recordRefund, getWalletBalance } = require('../services/wallet');
const { getOrderWithCredentials } = require('../services/order');
const sujanService = require('../services/sujan');

// Enforce admin auth on all sub-routes
router.use(authenticate, requireAdmin);

// Helper to record audit log
function logAudit(adminId, action, targetEntity, targetId, details) {
    try {
        db.prepare(`
            INSERT INTO audit_logs (admin_id, action, target_entity, target_id, details)
            VALUES (?, ?, ?, ?, ?)
        `).run(adminId, action, targetEntity, String(targetId), details);
    } catch (e) {
        console.error('Audit logging failed:', e);
    }
}

// 1. Dashboard Metrics & KPI Overview
router.get('/metrics', async (req, res) => {
    try {
        const totalRevenue = db.prepare(`SELECT COALESCE(SUM(total_amount), 0) as rev FROM orders WHERE status = 'completed'`).get().rev;
        const totalOrders = db.prepare(`SELECT COUNT(*) as count FROM orders WHERE status = 'completed'`).get().count;
        const totalUsers = db.prepare(`SELECT COUNT(*) as count FROM users WHERE role = 'customer'`).get().count;
        const pendingDisputes = db.prepare(`SELECT COUNT(*) as count FROM disputes WHERE status IN ('submitted', 'under_review')`).get().count;
        
        let sujanBalance = null;
        try {
            const balRes = await sujanService.getBalance();
            sujanBalance = balRes.data;
        } catch (e) {
            console.warn('Admin metrics: could not fetch Sujan balance', e.message);
        }

        const stockStats = db.prepare(`
            SELECT 
                COUNT(*) as total_items,
                SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) as available_items,
                SUM(CASE WHEN status = 'sold' THEN 1 ELSE 0 END) as sold_items
            FROM stock_items
        `).get();

        const topProducts = db.prepare(`
            SELECT p.name, COUNT(oi.id) as units_sold, SUM(oi.subtotal) as total_sales
            FROM order_items oi
            JOIN products p ON oi.product_id = p.id
            GROUP BY p.id
            ORDER BY units_sold DESC
            LIMIT 5
        `).all();

        return res.json({
            success: true,
            metrics: {
                totalRevenue,
                totalOrders,
                totalUsers,
                pendingDisputes,
                sujanBalance,
                stock: stockStats,
                topProducts
            }
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Failed to fetch admin metrics' });
    }
});

// Sujan API Health & Balance
router.get('/sujan/status', async (req, res) => {
    try {
        const balanceData = await sujanService.getBalance();
        return res.json({
            success: true,
            status: {
                isLive: !sujanService.isPlaceholderKey,
                baseUrl: process.env.SUJAN_API_BASE_URL || 'https://api.sujanlogsmarketplace.com/v1',
                balance: balanceData.data,
                isSandbox: balanceData.is_sandbox
            }
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Failed to fetch Sujan API status' });
    }
});

// 2. Product Management
router.get('/products', (req, res) => {
    try {
        const products = db.prepare(`
            SELECT 
                p.*,
                c.name as category_name,
                c.slug as category_slug,
                (SELECT COUNT(*) FROM stock_items s WHERE s.product_id = p.id AND s.status = 'available') as available_stock,
                (SELECT COUNT(*) FROM stock_items s WHERE s.product_id = p.id AND s.status = 'sold') as sold_stock
            FROM products p
            JOIN product_categories c ON p.category_id = c.id
            ORDER BY c.name ASC, p.name ASC
        `).all();

        return res.json({ success: true, products });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Failed to fetch products' });
    }
});

// Trigger catalog sync from Sujan API on demand
router.post('/products/sync-sujan', async (req, res) => {
    try {
        const syncResult = await sujanService.syncCatalogFromSujan();
        logAudit(req.user.id, 'SYNC_SUJAN_CATALOG', 'CATALOG', 0, `Synced ${syncResult.productsSynced} products from Sujan`);
        return res.json({ success: true, result: syncResult });
    } catch (err) {
        console.error('Sujan sync error:', err);
        return res.status(500).json({ success: false, error: err.message || 'Failed to sync from Sujan API' });
    }
});

// Quick Manual Price Update for Admin
router.put('/products/:id/price', (req, res) => {
    try {
        const { price, resetToDefault } = req.body;
        const productId = req.params.id;

        const product = db.prepare(`SELECT * FROM products WHERE id = ?`).get(productId);
        if (!product) {
            return res.status(404).json({ success: false, error: 'Product not found' });
        }

        if (resetToDefault) {
            // Reset to default auto price: Sujan base price + ₦1,000 markup
            const sujanBase = product.sujan_base_price || product.price;
            const newPrice = sujanBase + 1000;
            db.prepare(`
                UPDATE products 
                SET price = ?, manual_price_override = 0, updated_at = CURRENT_TIMESTAMP 
                WHERE id = ?
            `).run(newPrice, productId);

            logAudit(req.user.id, 'RESET_PRODUCT_PRICE', 'PRODUCT', productId, `Reset price to default (Base ₦${sujanBase} + ₦1,000 = ₦${newPrice})`);
            return res.json({ success: true, message: `Price reset to default ₦${newPrice.toLocaleString()}`, newPrice, manualOverride: 0 });
        }

        const numericPrice = parseFloat(price);
        if (isNaN(numericPrice) || numericPrice < 0) {
            return res.status(400).json({ success: false, error: 'Valid price is required' });
        }

        db.prepare(`
            UPDATE products 
            SET price = ?, manual_price_override = 1, updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?
        `).run(numericPrice, productId);

        logAudit(req.user.id, 'SET_MANUAL_PRICE', 'PRODUCT', productId, `Set manual price to ₦${numericPrice}`);
        return res.json({ success: true, message: `Price updated to ₦${numericPrice.toLocaleString()}`, newPrice: numericPrice, manualOverride: 1 });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message || 'Failed to update price' });
    }
});

router.post('/products', (req, res) => {
    try {
        const { categoryId, name, slug, description, price, imageUrl, minQty, maxQty, isActive } = req.body;
        if (!categoryId || !name || !price) {
            return res.status(400).json({ success: false, error: 'Category, name, and price are required' });
        }

        const generatedSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

        const result = db.prepare(`
            INSERT INTO products (category_id, name, slug, description, price, manual_price_override, image_url, min_order_qty, max_order_qty, is_active)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
        `).run(
            categoryId,
            name,
            generatedSlug,
            description || '',
            parseFloat(price),
            imageUrl || '',
            minQty ? parseInt(minQty, 10) : 1,
            maxQty ? parseInt(maxQty, 10) : 50,
            isActive !== undefined ? (isActive ? 1 : 0) : 1
        );

        logAudit(req.user.id, 'CREATE_PRODUCT', 'PRODUCT', result.lastInsertRowid, `Created product "${name}" with price ₦${price}`);

        return res.status(201).json({ success: true, message: 'Product created successfully', id: result.lastInsertRowid });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message || 'Failed to create product' });
    }
});

router.put('/products/:id', (req, res) => {
    try {
        const { categoryId, name, description, price, imageUrl, minQty, maxQty, isActive } = req.body;

        db.prepare(`
            UPDATE products
            SET category_id = ?, name = ?, description = ?, price = ?, manual_price_override = 1, image_url = ?, min_order_qty = ?, max_order_qty = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(
            categoryId,
            name,
            description,
            parseFloat(price),
            imageUrl,
            parseInt(minQty || 1, 10),
            parseInt(maxQty || 50, 10),
            isActive ? 1 : 0,
            req.params.id
        );

        logAudit(req.user.id, 'UPDATE_PRODUCT', 'PRODUCT', req.params.id, `Updated product "${name}" and set manual price ₦${price}`);

        return res.json({ success: true, message: 'Product updated successfully' });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message || 'Failed to update product' });
    }
});

router.delete('/products/:id', (req, res) => {
    try {
        const { permanent } = req.query;
        const productId = req.params.id;

        if (permanent === 'true') {
            const hasOrders = db.prepare(`SELECT COUNT(*) as count FROM order_items WHERE product_id = ?`).get(productId);
            if (hasOrders && hasOrders.count > 0) {
                db.prepare(`UPDATE products SET is_active = 0 WHERE id = ?`).run(productId);
                logAudit(req.user.id, 'DEACTIVATE_PRODUCT', 'PRODUCT', productId, 'Deactivated product with order history');
                return res.json({ success: true, message: 'Product archived/deactivated (has previous order history)' });
            }
            db.prepare(`DELETE FROM stock_items WHERE product_id = ?`).run(productId);
            db.prepare(`DELETE FROM products WHERE id = ?`).run(productId);
            logAudit(req.user.id, 'DELETE_PRODUCT', 'PRODUCT', productId, 'Permanently deleted product');
            return res.json({ success: true, message: 'Product deleted permanently' });
        } else {
            db.prepare(`UPDATE products SET is_active = 0 WHERE id = ?`).run(productId);
            logAudit(req.user.id, 'DEACTIVATE_PRODUCT', 'PRODUCT', productId, 'Deactivated product');
            return res.json({ success: true, message: 'Product deactivated' });
        }
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message || 'Failed to delete product' });
    }
});

// 3. Category Management (Including Rules & Guide Block)
router.get('/categories', (req, res) => {
    try {
        const categories = db.prepare(`
            SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) as product_count
            FROM product_categories c
            ORDER BY c.id ASC
        `).all();
        return res.json({ success: true, categories });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Failed to fetch categories' });
    }
});

router.post('/categories', (req, res) => {
    try {
        const { name, slug, icon, rulesGuide } = req.body;
        if (!name) {
            return res.status(400).json({ success: false, error: 'Category name is required' });
        }
        const finalSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const result = db.prepare(`
            INSERT INTO product_categories (name, slug, icon, rules_guide_markdown)
            VALUES (?, ?, ?, ?)
        `).run(name, finalSlug, icon || '📦', rulesGuide || '');

        logAudit(req.user.id, 'CREATE_CATEGORY', 'CATEGORY', result.lastInsertRowid, `Created category "${name}"`);
        return res.status(201).json({ success: true, message: 'Category created', id: result.lastInsertRowid });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message || 'Failed to create category' });
    }
});

router.put('/categories/:id', (req, res) => {
    try {
        const { name, icon, rulesGuide } = req.body;
        db.prepare(`
            UPDATE product_categories
            SET name = ?, icon = ?, rules_guide_markdown = ?
            WHERE id = ?
        `).run(name, icon, rulesGuide, req.params.id);

        logAudit(req.user.id, 'UPDATE_CATEGORY', 'CATEGORY', req.params.id, `Updated category "${name}"`);
        return res.json({ success: true, message: 'Category updated successfully' });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Failed to update category' });
    }
});

// 4. Stock Management (Single & Bulk CSV Upload)
router.get('/stock', (req, res) => {
    try {
        const { productId, status } = req.query;
        let query = `
            SELECT s.id, s.product_id, s.status, s.order_id, s.sold_at, s.created_at,
                   s.encrypted_credential, s.iv, s.auth_tag,
                   p.name as product_name, p.price,
                   u.email as added_by_email
            FROM stock_items s
            JOIN products p ON s.product_id = p.id
            LEFT JOIN users u ON s.added_by = u.id
            WHERE 1=1
        `;
        const params = [];
        if (productId) {
            query += ` AND s.product_id = ?`;
            params.push(productId);
        }
        if (status) {
            query += ` AND s.status = ?`;
            params.push(status);
        }
        query += ` ORDER BY s.id DESC LIMIT 100`;

        const rows = db.prepare(query).all(...params);

        const stock = rows.map(r => {
            const preview = decrypt(r.encrypted_credential, r.iv, r.auth_tag);
            return {
                id: r.id,
                productId: r.product_id,
                product_id: r.product_id,
                productName: r.product_name,
                product_name: r.product_name,
                status: r.status,
                orderId: r.order_id,
                order_id: r.order_id,
                soldAt: r.sold_at,
                sold_at: r.sold_at,
                createdAt: r.created_at,
                created_at: r.created_at,
                addedBy: r.added_by_email,
                credentialPreview: preview,
                credential_text: preview
            };
        });

        return res.json({ success: true, stock });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Failed to fetch stock items' });
    }
});

// Add Single Stock Item
router.post('/stock/manual', (req, res) => {
    try {
        const { productId, credentialText } = req.body;
        if (!productId || !credentialText) {
            return res.status(400).json({ success: false, error: 'Product ID and credential text are required' });
        }

        const enc = encrypt(credentialText.trim());
        const result = db.prepare(`
            INSERT INTO stock_items (product_id, encrypted_credential, iv, auth_tag, status, added_by)
            VALUES (?, ?, ?, ?, 'available', ?)
        `).run(productId, enc.encrypted, enc.iv, enc.authTag, req.user.id);

        logAudit(req.user.id, 'ADD_STOCK_MANUAL', 'STOCK_ITEM', result.lastInsertRowid, `Added 1 credential for Product #${productId}`);

        return res.status(201).json({ success: true, message: 'Stock item added successfully', id: result.lastInsertRowid });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Failed to add stock item' });
    }
});

// Bulk Upload Stock Items (Newline or CSV delimited)
router.post('/stock/bulk', (req, res) => {
    try {
        const { productId, bulkText } = req.body;
        if (!productId || !bulkText) {
            return res.status(400).json({ success: false, error: 'Product ID and bulk text are required' });
        }

        const lines = bulkText
            .split('\n')
            .map(l => l.trim())
            .filter(l => l.length > 0);

        if (lines.length === 0) {
            return res.status(400).json({ success: false, error: 'No valid credential lines found' });
        }

        const insertBulk = db.transaction(() => {
            const stmt = db.prepare(`
                INSERT INTO stock_items (product_id, encrypted_credential, iv, auth_tag, status, added_by)
                VALUES (?, ?, ?, ?, 'available', ?)
            `);

            let count = 0;
            for (const line of lines) {
                const enc = encrypt(line);
                stmt.run(productId, enc.encrypted, enc.iv, enc.authTag, req.user.id);
                count++;
            }
            return count;
        });

        const addedCount = insertBulk();

        logAudit(req.user.id, 'BULK_UPLOAD_STOCK', 'PRODUCT', productId, `Bulk added ${addedCount} credentials to Product #${productId}`);

        return res.status(201).json({
            success: true,
            message: `Successfully uploaded and encrypted ${addedCount} stock items`,
            count: addedCount
        });
    } catch (err) {
        console.error('Bulk stock upload error:', err);
        return res.status(500).json({ success: false, error: 'Failed to process bulk stock upload' });
    }
});

// Delete or pull un-sold stock item
router.delete('/stock/:id', (req, res) => {
    try {
        const item = db.prepare(`SELECT * FROM stock_items WHERE id = ?`).get(req.params.id);
        if (!item) {
            return res.status(404).json({ success: false, error: 'Stock item not found' });
        }
        if (item.status === 'sold') {
            return res.status(400).json({ success: false, error: 'Cannot delete an already sold stock item' });
        }

        db.prepare(`DELETE FROM stock_items WHERE id = ?`).run(req.params.id);
        logAudit(req.user.id, 'DELETE_STOCK_ITEM', 'STOCK_ITEM', req.params.id, `Removed unsold credential #${req.params.id}`);

        return res.json({ success: true, message: 'Stock item removed' });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Failed to delete stock item' });
    }
});

// 5. Order Management
router.get('/orders', (req, res) => {
    try {
        const { status, search } = req.query;
        let query = `
            SELECT o.*, u.email as user_email, u.full_name as user_name,
                   (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) as item_count,
                   (SELECT d.status FROM disputes d WHERE d.order_id = o.id) as dispute_status
            FROM orders o
            JOIN users u ON o.user_id = u.id
            WHERE 1=1
        `;
        const params = [];
        if (status) {
            query += ` AND o.status = ?`;
            params.push(status);
        }
        if (search) {
            query += ` AND (o.order_number LIKE ? OR u.email LIKE ?)`;
            params.push(`%${search}%`, `%${search}%`);
        }
        query += ` ORDER BY o.id DESC LIMIT 100`;

        const orders = db.prepare(query).all(...params).map(o => ({
            ...o,
            customer_name: o.user_name || o.full_name || 'Customer',
            customer_email: o.user_email || o.email,
            customerName: o.user_name || o.full_name || 'Customer',
            customerEmail: o.user_email || o.email
        }));
        return res.json({ success: true, orders });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Failed to fetch orders' });
    }
});

router.get('/orders/:id', (req, res) => {
    try {
        const order = getOrderWithCredentials(req.params.id);
        if (!order) {
            return res.status(404).json({ success: false, error: 'Order not found' });
        }
        const user = db.prepare(`SELECT id, email, full_name, phone FROM users WHERE id = ?`).get(order.user_id);
        return res.json({ success: true, order, user });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Failed to fetch order detail' });
    }
});

// 6. Dispute Resolution Queue
router.get('/disputes', (req, res) => {
    try {
        const disputes = db.prepare(`
            SELECT d.*, o.order_number, o.total_amount, u.email as user_email, u.full_name as user_name
            FROM disputes d
            JOIN orders o ON d.order_id = o.id
            JOIN users u ON d.user_id = u.id
            ORDER BY 
                CASE d.status 
                    WHEN 'submitted' THEN 1 
                    WHEN 'under_review' THEN 2 
                    ELSE 3 
                END, 
                d.id DESC
        `).all();

        return res.json({ success: true, disputes });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Failed to fetch disputes' });
    }
});

// Approve (Refund to user wallet) or Reject Dispute
router.post('/disputes/:id/resolve', (req, res) => {
    try {
        const { action, notes } = req.body; // action: 'approve' | 'reject' | 'review'
        const dispute = db.prepare(`SELECT * FROM disputes WHERE id = ?`).get(req.params.id);
        if (!dispute) {
            return res.status(404).json({ success: false, error: 'Dispute not found' });
        }

        if (dispute.status === 'approved_refunded') {
            return res.status(400).json({ success: false, error: 'Dispute has already been approved and refunded' });
        }

        if (action === 'approve') {
            const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(dispute.order_id);
            if (!order) {
                return res.status(404).json({ success: false, error: 'Associated order not found' });
            }

            // Atomic refund execution
            const refundTx = db.transaction(() => {
                // Record wallet refund ledger credit
                const ref = recordRefund(dispute.user_id, order.total_amount, order.id, dispute.id, req.user.id, notes || 'Dispute claim approved');

                // Update dispute status
                db.prepare(`
                    UPDATE disputes
                    SET status = 'approved_refunded', admin_notes = ?, resolved_by = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `).run(notes || 'Approved and credited to wallet', req.user.id, dispute.id);

                // Update order status
                db.prepare(`UPDATE orders SET status = 'refunded' WHERE id = ?`).run(order.id);

                logAudit(req.user.id, 'APPROVE_DISPUTE_REFUND', 'DISPUTE', dispute.id, `Approved refund of ₦${order.total_amount} for Order #${order.order_number}`);
                return ref;
            });

            const refResult = refundTx();
            return res.json({
                success: true,
                message: `Dispute approved. ₦${order.total_amount.toLocaleString()} has been refunded to customer's wallet balance.`,
                refundReference: refResult.reference
            });
        } else if (action === 'reject') {
            db.prepare(`
                UPDATE disputes
                SET status = 'rejected', admin_notes = ?, resolved_by = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(notes || 'Dispute rejected by administration', req.user.id, dispute.id);

            logAudit(req.user.id, 'REJECT_DISPUTE', 'DISPUTE', dispute.id, `Rejected dispute for Order #${dispute.order_id}`);

            return res.json({ success: true, message: 'Dispute has been rejected' });
        } else if (action === 'review') {
            db.prepare(`
                UPDATE disputes
                SET status = 'under_review', admin_notes = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(notes || 'Under investigation', dispute.id);

            return res.json({ success: true, message: 'Dispute status set to under review' });
        } else {
            return res.status(400).json({ success: false, error: 'Invalid action' });
        }
    } catch (err) {
        console.error('Resolve dispute error:', err);
        return res.status(500).json({ success: false, error: err.message || 'Failed to resolve dispute' });
    }
});

// 7. User Management
router.get('/users', (req, res) => {
    try {
        const { search } = req.query;
        let query = `
            SELECT 
                u.id, u.email, u.full_name, u.phone, u.role, u.is_verified, u.is_banned, u.created_at,
                (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) as order_count
            FROM users u
            WHERE 1=1
        `;
        const params = [];
        if (search) {
            query += ` AND (u.email LIKE ? OR u.full_name LIKE ?)`;
            params.push(`%${search}%`, `%${search}%`);
        }
        query += ` ORDER BY u.id DESC`;

        const users = db.prepare(query).all(...params);

        // Attach live balance from ledger for each user
        const enrichedUsers = users.map(u => {
            const bal = getWalletBalance(u.id);
            return {
                ...u,
                balance: bal,
                walletBalance: bal
            };
        });

        return res.json({ success: true, users: enrichedUsers });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Failed to fetch users' });
    }
});

router.post('/users/:id/toggle-ban', (req, res) => {
    try {
        const user = db.prepare(`SELECT id, email, is_banned, role FROM users WHERE id = ?`).get(req.params.id);
        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }
        if (user.role === 'admin') {
            return res.status(400).json({ success: false, error: 'Cannot suspend an administrator' });
        }

        const newStatus = user.is_banned ? 0 : 1;
        db.prepare(`UPDATE users SET is_banned = ? WHERE id = ?`).run(newStatus, user.id);

        logAudit(req.user.id, newStatus ? 'BAN_USER' : 'UNBAN_USER', 'USER', user.id, `${newStatus ? 'Banned' : 'Unbanned'} user ${user.email}`);

        return res.json({
            success: true,
            message: `User has been ${newStatus ? 'suspended' : 'reactivated'}`
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Failed to update user status' });
    }
});

// 8. Wallet & Transaction Oversight (Full Ledger)
router.get('/ledger', (req, res) => {
    try {
        const transactions = db.prepare(`
            SELECT t.*, u.email as user_email, u.full_name as user_name
            FROM wallet_transactions t
            JOIN users u ON t.user_id = u.id
            ORDER BY t.id DESC
            LIMIT 100
        `).all();

        return res.json({ success: true, transactions });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Failed to fetch transaction ledger' });
    }
});

// 9. Audit Logs
router.get('/audit-logs', (req, res) => {
    try {
        const logs = db.prepare(`
            SELECT a.*, u.email as admin_email
            FROM audit_logs a
            LEFT JOIN users u ON a.admin_id = u.id
            ORDER BY a.id DESC
            LIMIT 100
        `).all();

        return res.json({ success: true, logs });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Failed to fetch audit logs' });
    }
});

module.exports = router;
