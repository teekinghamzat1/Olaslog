const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { encrypt, decrypt } = require('../services/crypto');
const { recordRefund, getWalletBalance, adjustUserBalance } = require('../services/wallet');
const { getOrderWithCredentials } = require('../services/order');
const sujanService = require('../services/sujan');
const syncScheduler = require('../services/syncScheduler');
const emailService = require('../services/email');

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
        
        let rakibBalance = null;
        try {
            const balRes = await sujanService.getBalance();
            rakibBalance = balRes.data;
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
                completedOrdersCount: totalOrders,       // alias for frontend
                totalUsers,
                totalCustomersCount: totalUsers,         // alias for frontend
                pendingDisputes,
                pendingDisputesCount: pendingDisputes,   // alias for frontend
                availableStockCount: stockStats ? (stockStats.available_items || 0) : 0, // alias for frontend
                rakibBalance,
                sujanBalance: rakibBalance, // backwards compatibility
                stock: stockStats,
                topProducts
            }
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Failed to fetch admin metrics' });
    }
});

// Sujan API Health & Balance
router.get(['/rakib/status', '/rakib-status', '/sujan/status', '/sujan-status'], async (req, res) => {
    try {
        const balanceData = await sujanService.getBalance();
        return res.json({
            success: true,
            status: {
                isLive: !sujanService.isPlaceholderKey,
                baseUrl: process.env.SUJAN_API_BASE_URL || 'https://api.sujanlogsmarketplace.com/v1',
                balance: balanceData.data,
                isSandbox: balanceData.is_sandbox
            },
            sandbox: balanceData.is_sandbox,
            balance: balanceData.data
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
router.post(['/products/sync-rakib', '/products/sync-sujan'], async (req, res) => {
    try {
        const syncResult = await sujanService.syncCatalogFromSujan();
        logAudit(req.user.id, 'SYNC_SUJAN_CATALOG', 'CATALOG', 0, `Synced ${syncResult.productsSynced} products from Sujan Logs Marketplace`);
        return res.json({ success: true, result: syncResult, message: `Synced ${syncResult.productsSynced} products from Sujan Logs Marketplace` });
    } catch (err) {
        console.error('Sujan sync error:', err);
        return res.status(500).json({ success: false, error: err.message || 'Failed to sync from Sujan Logs Marketplace' });
    }
});

// Quick Manual Price Update for Admin
router.put('/products/:id/price', (req, res) => {
    try {
        const { price, resetToDefault, resetToDefaultFormula } = req.body;
        const productId = req.params.id;

        const product = db.prepare(`SELECT * FROM products WHERE id = ?`).get(productId);
        if (!product) {
            return res.status(404).json({ success: false, error: 'Product not found' });
        }

        if (resetToDefault || resetToDefaultFormula) {
            // Reset to default auto price: Wholesale base price + ₦1,000 markup
            const wholesaleBase = product.rakib_base_price || product.sujan_base_price || product.price;
            const newPrice = wholesaleBase + 1000;
            db.prepare(`
                UPDATE products 
                SET price = ?, manual_price_override = 0, updated_at = CURRENT_TIMESTAMP 
                WHERE id = ?
            `).run(newPrice, productId);

            logAudit(req.user.id, 'RESET_PRODUCT_PRICE', 'PRODUCT', productId, `Reset price to default (Base ₦${wholesaleBase} + ₦1,000 = ₦${newPrice})`);
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

router.post('/users/:id/adjust-balance', (req, res) => {
    try {
        const userId = parseInt(req.params.id, 10);
        if (isNaN(userId)) {
            return res.status(400).json({ success: false, error: 'Invalid user ID' });
        }

        const { action, amount, newBalance, reason } = req.body;
        if (!action || !['credit', 'debit', 'set'].includes(action)) {
            return res.status(400).json({ success: false, error: 'Action must be credit, debit, or set' });
        }

        const result = adjustUserBalance(userId, req.user.id, { action, amount, newBalance, reason });

        logAudit(
            req.user.id,
            'ADJUST_USER_BALANCE',
            'USER',
            userId,
            `Adjusted balance for ${result.user.email} (${action.toUpperCase()}): ₦${result.balanceBefore.toLocaleString()} ➔ ₦${result.balanceAfter.toLocaleString()} (Ref: ${result.reference}). Reason: ${reason || 'N/A'}`
        );

        return res.json({
            success: true,
            message: `User balance successfully updated to ₦${result.balanceAfter.toLocaleString()}`,
            data: {
                userId,
                reference: result.reference,
                balanceBefore: result.balanceBefore,
                balanceAfter: result.balanceAfter,
                amount: result.amount,
                action,
                description: result.description
            }
        });
    } catch (err) {
        console.error('Balance adjustment error:', err);
        return res.status(400).json({ success: false, error: err.message || 'Failed to adjust balance' });
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

// 10. Administrator & Staff Management
router.get('/administrators', (req, res) => {
    try {
        const admins = db.prepare(`
            SELECT id, email, full_name, phone, role, is_banned, is_verified, created_at, updated_at
            FROM users
            WHERE role IN ('admin', 'support')
            ORDER BY id ASC
        `).all();

        return res.json({ success: true, administrators: admins });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Failed to fetch administrators' });
    }
});

router.post('/administrators', (req, res) => {
    try {
        const { email, password, fullName, phone, role } = req.body;
        if (!email || !password || !fullName) {
            return res.status(400).json({ success: false, error: 'Email, password, and full name are required' });
        }

        if (password.length < 6) {
            return res.status(400).json({ success: false, error: 'Password must be at least 6 characters long' });
        }

        const assignedRole = role === 'support' ? 'support' : 'admin';

        const existing = db.prepare(`SELECT id, role FROM users WHERE email = ?`).get(email.toLowerCase().trim());
        if (existing) {
            return res.status(400).json({ success: false, error: 'A user with this email address already exists' });
        }

        const passwordHash = bcrypt.hashSync(password, 10);
        const result = db.prepare(`
            INSERT INTO users (email, password_hash, full_name, phone, role, is_verified, is_banned)
            VALUES (?, ?, ?, ?, ?, 1, 0)
        `).run(email.toLowerCase().trim(), passwordHash, fullName.trim(), phone ? phone.trim() : null, assignedRole);

        const newAdminId = result.lastInsertRowid;

        logAudit(
            req.user.id,
            'CREATE_ADMIN',
            'USER',
            newAdminId,
            `Created administrator ${email.toLowerCase().trim()} with role ${assignedRole}`
        );

        return res.status(201).json({
            success: true,
            message: `Administrator ${fullName} created successfully`,
            administrator: {
                id: newAdminId,
                email: email.toLowerCase().trim(),
                full_name: fullName.trim(),
                phone: phone ? phone.trim() : null,
                role: assignedRole,
                is_banned: 0,
                created_at: new Date().toISOString()
            }
        });
    } catch (err) {
        console.error('Create admin error:', err);
        return res.status(500).json({ success: false, error: err.message || 'Failed to create administrator' });
    }
});

router.put('/administrators/:id', (req, res) => {
    try {
        const targetId = parseInt(req.params.id, 10);
        const admin = db.prepare(`SELECT id, email, full_name, role FROM users WHERE id = ? AND role IN ('admin', 'support')`).get(targetId);
        if (!admin) {
            return res.status(404).json({ success: false, error: 'Administrator not found' });
        }

        const { fullName, phone, role } = req.body;
        if (!fullName) {
            return res.status(400).json({ success: false, error: 'Full name is required' });
        }

        let assignedRole = admin.role;
        if (role && ['admin', 'support'].includes(role)) {
            if (targetId === req.user.id && role !== 'admin') {
                return res.status(400).json({ success: false, error: 'You cannot demote your own administrator account' });
            }
            assignedRole = role;
        }

        db.prepare(`
            UPDATE users
            SET full_name = ?, phone = ?, role = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(fullName.trim(), phone ? phone.trim() : null, assignedRole, targetId);

        logAudit(
            req.user.id,
            'UPDATE_ADMIN',
            'USER',
            targetId,
            `Updated administrator profile for ${admin.email} (Role: ${assignedRole})`
        );

        return res.json({
            success: true,
            message: 'Administrator profile updated successfully'
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Failed to update administrator' });
    }
});

router.post('/administrators/:id/reset-password', (req, res) => {
    try {
        const targetId = parseInt(req.params.id, 10);
        const { newPassword } = req.body;
        if (!newPassword || newPassword.length < 6) {
            return res.status(400).json({ success: false, error: 'Password must be at least 6 characters long' });
        }

        const admin = db.prepare(`SELECT id, email FROM users WHERE id = ? AND role IN ('admin', 'support')`).get(targetId);
        if (!admin) {
            return res.status(404).json({ success: false, error: 'Administrator not found' });
        }

        const passwordHash = bcrypt.hashSync(newPassword, 10);
        db.prepare(`UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(passwordHash, targetId);

        logAudit(
            req.user.id,
            'RESET_ADMIN_PASSWORD',
            'USER',
            targetId,
            `Reset password for administrator ${admin.email}`
        );

        return res.json({
            success: true,
            message: `Password successfully updated for ${admin.email}`
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Failed to reset administrator password' });
    }
});

router.post('/administrators/:id/toggle-status', (req, res) => {
    try {
        const targetId = parseInt(req.params.id, 10);
        if (targetId === req.user.id) {
            return res.status(400).json({ success: false, error: 'You cannot suspend your own active administrator account' });
        }

        const admin = db.prepare(`SELECT id, email, is_banned, role FROM users WHERE id = ? AND role IN ('admin', 'support')`).get(targetId);
        if (!admin) {
            return res.status(404).json({ success: false, error: 'Administrator not found' });
        }

        const newStatus = admin.is_banned ? 0 : 1;
        db.prepare(`UPDATE users SET is_banned = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(newStatus, targetId);

        logAudit(
            req.user.id,
            newStatus ? 'SUSPEND_ADMIN' : 'REACTIVATE_ADMIN',
            'USER',
            targetId,
            `${newStatus ? 'Suspended' : 'Reactivated'} administrator ${admin.email}`
        );

        return res.json({
            success: true,
            message: `Administrator has been ${newStatus ? 'suspended' : 'reactivated'}`
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Failed to toggle administrator status' });
    }
});

router.delete('/administrators/:id', (req, res) => {
    try {
        const targetId = parseInt(req.params.id, 10);
        if (targetId === req.user.id) {
            return res.status(400).json({ success: false, error: 'You cannot delete your own administrator account' });
        }

        const admin = db.prepare(`SELECT id, email, role FROM users WHERE id = ? AND role IN ('admin', 'support')`).get(targetId);
        if (!admin) {
            return res.status(404).json({ success: false, error: 'Administrator not found' });
        }

        const adminCount = db.prepare(`SELECT COUNT(*) as c FROM users WHERE role = 'admin' AND is_banned = 0`).get().c;
        if (adminCount <= 1 && admin.role === 'admin') {
            return res.status(400).json({ success: false, error: 'Cannot delete the only remaining active administrator' });
        }

        db.prepare(`DELETE FROM users WHERE id = ?`).run(targetId);

        logAudit(
            req.user.id,
            'DELETE_ADMIN',
            'USER',
            targetId,
            `Deleted administrator account ${admin.email} (Role: ${admin.role})`
        );

        return res.json({
            success: true,
            message: `Administrator ${admin.email} has been permanently deleted`
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Failed to delete administrator' });
    }
});


// ─── Catalog Sync Scheduler Admin Routes ─────────────────────────────────────

/**
 * GET /api/admin/sync/status
 * Returns current sync scheduler state, last run stats and next scheduled run.
 */
router.get('/sync/status', (req, res) => {
    try {
        const status = syncScheduler.getSyncStatus();
        return res.json({ success: true, sync: status });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Failed to fetch sync status' });
    }
});

/**
 * POST /api/admin/sync/trigger
 * Immediately triggers a full catalog sync from the provider API.
 * If a sync is already running, returns 409 Conflict.
 */
router.post('/sync/trigger', async (req, res) => {
    try {
        const result = await syncScheduler.runCatalogSync('manual', req.user.id);

        if (result.in_progress) {
            return res.status(409).json({
                success: false,
                message: result.message || 'A catalog sync is already running'
            });
        }

        logAudit(
            req.user.id,
            'manual_catalog_sync',
            'products',
            'provider_api',
            JSON.stringify({
                triggered_by: 'admin_dashboard',
                duration_ms: result.durationMs,
                status: result.success ? 'success' : 'failed',
                stats: result.stats
            })
        );

        return res.json({
            success: result.success,
            message: result.success
                ? `Catalog sync completed in ${result.durationMs}ms`
                : `Sync completed with notice: ${result.error || 'unknown'}`,
            result
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Failed to trigger catalog sync' });
    }
});

/**
 * POST /api/admin/sync/stop
 * Stops the recurring background sync scheduler.
 * Body: { restart: true } optionally restarts it.
 */
router.post('/sync/stop', (req, res) => {
    try {
        const { restart, intervalMinutes } = req.body || {};

        syncScheduler.stopSyncJob();

        if (restart) {
            const interval = parseInt(intervalMinutes, 10);
            const job = syncScheduler.startSyncJob((!isNaN(interval) && interval >= 1) ? interval : null);
            return res.json({
                success: true,
                message: `Sync scheduler restarted (every ${job.intervalMinutes} min)`,
                job
            });
        }

        return res.json({ success: true, message: 'Sync scheduler stopped' });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Failed to stop sync scheduler' });
    }
});

// ─── Email & SMTP Management ──────────────────────────────────────────────────

/**
 * GET /api/admin/email/settings
 * Returns current SMTP configuration and list of templates
 */
router.get('/email/settings', (req, res) => {
    try {
        const settings = emailService.getEmailSettings();
        const templates = emailService.getAllTemplates();

        // Return settings with password masked if set
        const safeSettings = {
            ...settings,
            pass: settings.pass ? '••••••••' : '',
            hasPass: Boolean(settings.pass)
        };

        return res.json({
            success: true,
            settings: safeSettings,
            templates
        });
    } catch (err) {
        console.error('[Admin] Failed to fetch email settings:', err);
        return res.status(500).json({ success: false, error: 'Failed to fetch email settings' });
    }
});

/**
 * PUT /api/admin/email/settings
 * Updates SMTP configuration
 */
router.put('/email/settings', (req, res) => {
    try {
        const { host, port, secure, user, pass, from, fromName } = req.body;

        const updated = emailService.saveEmailSettings({
            smtp_host: host,
            smtp_port: port,
            smtp_secure: secure,
            smtp_user: user,
            smtp_pass: pass,
            email_from: from,
            email_from_name: fromName
        });

        logAudit(
            req.user.id,
            'update_smtp_settings',
            'email_settings',
            'smtp',
            `Updated SMTP host: ${host || 'cleared'}, user: ${user || 'cleared'}`
        );

        return res.json({
            success: true,
            message: 'Email & SMTP settings saved successfully',
            settings: {
                ...updated,
                pass: updated.pass ? '••••••••' : '',
                hasPass: Boolean(updated.pass)
            }
        });
    } catch (err) {
        console.error('[Admin] Failed to save email settings:', err);
        return res.status(500).json({ success: false, error: 'Failed to save email settings: ' + err.message });
    }
});

/**
 * GET /api/admin/email/templates
 * Returns all email templates
 */
router.get('/email/templates', (req, res) => {
    try {
        const templates = emailService.getAllTemplates();
        return res.json({ success: true, templates });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Failed to fetch email templates' });
    }
});

/**
 * PUT /api/admin/email/templates/:key
 * Updates the customizable content of an email template
 */
router.put('/email/templates/:key', (req, res) => {
    try {
        const { key } = req.params;
        const { subject, headline, body, extra } = req.body;

        const updated = emailService.saveTemplate(key, { subject, headline, body, extra });

        logAudit(
            req.user.id,
            'update_email_template',
            'email_templates',
            key,
            `Updated content for template: ${key}`
        );

        return res.json({
            success: true,
            message: `Template "${updated.name}" updated successfully`,
            template: updated
        });
    } catch (err) {
        console.error('[Admin] Failed to save email template:', err);
        return res.status(500).json({ success: false, error: err.message || 'Failed to update template' });
    }
});

/**
 * POST /api/admin/email/templates/:key/reset
 * Resets a template back to factory defaults
 */
router.post('/email/templates/:key/reset', (req, res) => {
    try {
        const { key } = req.params;
        const reset = emailService.resetTemplateToDefault(key);

        logAudit(
            req.user.id,
            'reset_email_template',
            'email_templates',
            key,
            `Reset template to default: ${key}`
        );

        return res.json({
            success: true,
            message: `Template "${reset.name}" reset to factory default`,
            template: reset
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message || 'Failed to reset template' });
    }
});

/**
 * POST /api/admin/email/test
 * Sends a live test email for any template to verify SMTP and inbox appearance
 */
router.post('/email/test', async (req, res) => {
    try {
        const { templateKey, recipientEmail } = req.body;

        if (!templateKey) {
            return res.status(400).json({ success: false, error: 'Template key is required (welcome, wallet_funded, or purchase)' });
        }
        if (!recipientEmail || !recipientEmail.includes('@')) {
            return res.status(400).json({ success: false, error: 'A valid recipient email address is required' });
        }

        const result = await emailService.sendTestEmail(templateKey, recipientEmail.trim());

        logAudit(
            req.user.id,
            'send_test_email',
            'email',
            templateKey,
            `Sent test email to: ${recipientEmail}`
        );

        return res.json({
            success: true,
            message: `Test email (${templateKey}) successfully delivered to ${recipientEmail}! Check your inbox.`,
            result
        });
    } catch (err) {
        console.error('[Admin] Test email error:', err);
        return res.status(400).json({
            success: false,
            error: err.message || 'Failed to send test email. Check your SMTP configuration.'
        });
    }
});

module.exports = router;
