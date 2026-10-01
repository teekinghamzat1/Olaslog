const db = require('../db');
const { getWalletBalance } = require('./wallet');
const { encrypt, decrypt } = require('./crypto');
const rakibService = require('./rakib');

/**
 * Performs atomic checkout for a cart with Rakib Socials API integration
 * @param {number} userId
 * @param {Array<{ productId: number, quantity: number, inventoryItemIds?: number[] }>} items
 * @returns {Promise<object>} completed order with decrypted credentials
 */
async function checkoutCart(userId, items) {
    if (!items || !items.length) {
        throw new Error('Cart is empty');
    }

    // Step 1: Pre-calculate total and validate products
    let totalCost = 0;
    const validatedItems = [];

    for (const item of items) {
        const prodId = Number(item.productId);
        const product = db.prepare(`SELECT * FROM products WHERE id = ? AND is_active = 1`).get(prodId);
        if (!product) {
            throw new Error(`Product #${prodId} is not available`);
        }

        let qty = 1;
        let specificItemIds = null;

        if (Array.isArray(item.inventoryItemIds) && item.inventoryItemIds.length > 0) {
            specificItemIds = item.inventoryItemIds.map(Number);
            qty = specificItemIds.length;
        } else {
            qty = parseInt(item.quantity, 10);
            if (isNaN(qty) || qty <= 0) {
                throw new Error(`Invalid quantity for product ${product.name}`);
            }
        }

        const subtotal = product.price * qty;
        totalCost += subtotal;

        validatedItems.push({
            product,
            quantity: qty,
            inventoryItemIds: specificItemIds,
            unitPrice: product.price,
            subtotal
        });
    }

    totalCost = Math.round(totalCost * 100) / 100;

    // Step 2: Check wallet balance
    const currentBalance = getWalletBalance(userId);
    if (currentBalance < totalCost) {
        const shortfall = Math.round((totalCost - currentBalance) * 100) / 100;
        const err = new Error('Insufficient wallet balance');
        err.code = 'INSUFFICIENT_FUNDS';
        err.shortfall = shortfall;
        err.required = totalCost;
        err.currentBalance = currentBalance;
        throw err;
    }

    // Step 3: Fulfill items via Rakib Socials API (or local stock fallback)
    const fulfillmentResults = [];

    for (const valItem of validatedItems) {
        const targetRakibId = valItem.product.rakib_product_id || valItem.product.sujan_product_id || valItem.product.id;

        try {
            // Place order with Rakib Socials API (POST /buy)
            const rakibRes = await rakibService.buyProduct({
                productId: targetRakibId,
                quantity: valItem.quantity
            });

            const rakibOrderData = rakibRes.data || rakibRes;
            const keys = rakibOrderData.keys || [];

            fulfillmentResults.push({
                item: valItem,
                source: 'rakib',
                rakibOrderId: String(rakibOrderData.order_id || ''),
                productName: rakibOrderData.product || valItem.product.name,
                keys: keys
            });
        } catch (rakibErr) {
            console.warn(`Rakib API order failed for product ${valItem.product.id}, attempting local stock fallback:`, rakibErr.message);
            
            // Check if local stock rows exist as fallback
            const stockRows = db.prepare(`
                SELECT id, product_id, encrypted_credential, iv, auth_tag
                FROM stock_items
                WHERE product_id = ? AND status = 'available'
                LIMIT ?
            `).all(valItem.product.id, valItem.quantity);

            if (stockRows.length >= valItem.quantity) {
                fulfillmentResults.push({
                    item: valItem,
                    source: 'local',
                    stockRows
                });
            } else {
                const stockErr = new Error(`Order could not be fulfilled: ${rakibErr.message || 'Out of stock'}`);
                stockErr.code = 'OUT_OF_STOCK';
                throw stockErr;
            }
        }
    }

    // Step 4: Run local DB updates in SQLite ACID transaction (atomic wallet debit + order save)
    const executeCheckoutTransaction = db.transaction(() => {
        // Generate unique internal order number and wallet reference
        const timestamp = Date.now();
        const randomSuffix = Math.floor(1000 + Math.random() * 9000);
        const orderNumber = `ORD-${timestamp}-${randomSuffix}`;
        const walletRef = `PUR-${timestamp}-${randomSuffix}`;

        // Deduct wallet balance via immutable ledger entry
        const newBalance = Math.round((currentBalance - totalCost) * 100) / 100;
        db.prepare(`
            INSERT INTO wallet_transactions
            (user_id, type, amount, balance_before, balance_after, reference, status, payment_channel, description, metadata)
            VALUES (?, 'purchase', ?, ?, ?, ?, 'successful', 'wallet', ?, ?)
        `).run(
            userId,
            totalCost,
            currentBalance,
            newBalance,
            walletRef,
            `Purchase of ${validatedItems.length} item(s) - ${orderNumber}`,
            JSON.stringify({ orderNumber, totalCost })
        );

        // Collect all Rakib order IDs
        const rakibOrderIds = fulfillmentResults
            .filter(f => f.rakibOrderId)
            .map(f => f.rakibOrderId)
            .join(',');

        // Create Order
        const orderResult = db.prepare(`
            INSERT INTO orders (order_number, rakib_order_id, sujan_order_id, user_id, total_amount, status)
            VALUES (?, ?, ?, ?, ?, 'completed')
        `).run(orderNumber, rakibOrderIds || null, rakibOrderIds || null, userId, totalCost);
        const orderId = orderResult.lastInsertRowid;

        const deliveredCredentials = [];

        // Save order items & encrypt credentials
        for (const fulfillment of fulfillmentResults) {
            const { item, source } = fulfillment;

            const orderItemResult = db.prepare(`
                INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal)
                VALUES (?, ?, ?, ?, ?)
            `).run(orderId, item.product.id, item.quantity, item.unitPrice, item.subtotal);
            const orderItemId = orderItemResult.lastInsertRowid;

            if (source === 'rakib') {
                const keys = fulfillment.keys || [];
                for (let idx = 0; idx < keys.length; idx++) {
                    const rawKey = keys[idx] || 'No key provided';
                    const publicData = `Key ${idx + 1} of ${keys.length}`;
                    const enc = encrypt(rawKey);
                    const rakibItemId = fulfillment.rakibOrderId ? `${fulfillment.rakibOrderId}-${idx + 1}` : null;

                    db.prepare(`
                        INSERT INTO delivered_credentials
                        (order_id, order_item_id, product_id, stock_item_id, rakib_item_id, sujan_item_id, public_data, encrypted_credential, iv, auth_tag)
                        VALUES (?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?)
                    `).run(
                        orderId,
                        orderItemId,
                        item.product.id,
                        rakibItemId,
                        publicData,
                        enc.encrypted,
                        enc.iv,
                        enc.authTag
                    );

                    deliveredCredentials.push({
                        productId: item.product.id,
                        productName: fulfillment.productName || item.product.name,
                        publicData: publicData,
                        credentialText: rawKey
                    });
                }
            } else if (source === 'local') {
                for (const stockRow of fulfillment.stockRows) {
                    db.prepare(`
                        UPDATE stock_items
                        SET status = 'sold', order_id = ?, sold_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                    `).run(orderId, stockRow.id);

                    db.prepare(`
                        INSERT INTO delivered_credentials
                        (order_id, order_item_id, product_id, stock_item_id, encrypted_credential, iv, auth_tag)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                    `).run(
                        orderId,
                        orderItemId,
                        item.product.id,
                        stockRow.id,
                        stockRow.encrypted_credential,
                        stockRow.iv,
                        stockRow.auth_tag
                    );

                    const decrypted = decrypt(stockRow.encrypted_credential, stockRow.iv, stockRow.auth_tag);
                    deliveredCredentials.push({
                        productId: item.product.id,
                        productName: item.product.name,
                        stockItemId: stockRow.id,
                        credentialText: decrypted
                    });
                }
            }
        }

        return {
            orderId,
            orderNumber,
            rakibOrderIds,
            sujanOrderIds: rakibOrderIds,
            totalAmount: totalCost,
            remainingBalance: newBalance,
            createdAt: new Date().toISOString(),
            deliveredCredentials
        };
    });

    return executeCheckoutTransaction();
}

/**
 * Retrieves an order and all its delivered credentials (decrypted)
 * @param {number} orderId
 * @param {number} [userId]
 */
function getOrderWithCredentials(orderId, userId = null) {
    let orderQuery = `SELECT * FROM orders WHERE id = ?`;
    const params = [orderId];
    if (userId) {
        orderQuery += ` AND user_id = ?`;
        params.push(userId);
    }
    const order = db.prepare(orderQuery).get(...params);
    if (!order) return null;

    const items = db.prepare(`
        SELECT oi.*, p.name as product_name, p.image_url, c.name as category_name
        FROM order_items oi
        JOIN products p ON oi.product_id = p.id
        JOIN product_categories c ON p.category_id = c.id
        WHERE oi.order_id = ?
    `).all(orderId);

    const credRows = db.prepare(`
        SELECT dc.*, p.name as product_name
        FROM delivered_credentials dc
        JOIN products p ON dc.product_id = p.id
        WHERE dc.order_id = ?
    `).all(orderId);

    const credentials = credRows.map(row => ({
        id: row.id,
        productId: row.product_id,
        productName: row.product_name,
        stockItemId: row.stock_item_id,
        rakibItemId: row.rakib_item_id || row.sujan_item_id,
        sujanItemId: row.sujan_item_id,
        publicData: row.public_data,
        deliveredAt: row.delivered_at,
        credentialText: decrypt(row.encrypted_credential, row.iv, row.auth_tag)
    }));

    const dispute = db.prepare(`SELECT * FROM disputes WHERE order_id = ?`).get(orderId);

    return {
        ...order,
        items,
        credentials,
        dispute: dispute || null
    };
}

module.exports = {
    checkoutCart,
    getOrderWithCredentials
};
