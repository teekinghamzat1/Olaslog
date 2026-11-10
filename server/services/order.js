const db = require('../db');
const crypto = require('crypto');
const { getWalletBalance, getLedgerBalance } = require('./wallet');
const { encrypt, decrypt } = require('./crypto');
const sujanService = require('./sujan');
const emailService = require('./email');
const telegram = require('./telegram');
const telegramBot = require('./telegramBot');

function recordSupplierUncertainty(userId, item, error) {
    try {
        db.prepare(`
            INSERT INTO audit_logs (admin_id, action, target_entity, target_id, details)
            VALUES (NULL, 'SUPPLIER_ORDER_UNCERTAIN', 'CHECKOUT', ?, ?)
        `).run(
            String(userId),
            JSON.stringify({
                productId: item.product.id,
                sujanProductId: item.product.sujan_product_id,
                quantity: item.quantity,
                supplierOrderId: error.sujanOrderId || null,
                supplierStatus: error.sujanStatus || null,
                message: error.message,
                recordedAt: new Date().toISOString()
            })
        );
    } catch (auditError) {
        console.error('[Order] Could not record uncertain supplier checkout:', auditError.message);
    }
}

/**
 * Performs atomic checkout for a cart with Sujan Logs Marketplace API integration
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

    // Until supplier idempotency/reconciliation is available, allow at most one
    // supplier-backed line per checkout. This prevents a later supplier failure
    // from leaving earlier remote orders fulfilled but absent from our DB.
    const supplierLineCount = validatedItems.filter(item =>
        item.product.sujan_product_id !== null
        && item.product.sujan_product_id !== undefined
        && Number(item.product.sujan_product_id) > 0
    ).length;

    if (supplierLineCount > 0 && validatedItems.length > 1) {
        const err = new Error(
            'Please purchase supplier-fulfilled products one at a time for now. Local-stock products can still be checked out together.'
        );
        err.code = 'CHECKOUT_SPLIT_REQUIRED';
        throw err;
    }

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

    // Reserve the customer's money durably before any supplier request.
    // BEGIN IMMEDIATE serializes competing wallet reservations in SQLite.
    const checkoutId = crypto.randomUUID();
    const reserveFunds = db.transaction(() => {
        const spendable = getWalletBalance(userId);
        if (spendable < totalCost) {
            const shortfall = Math.round((totalCost - spendable) * 100) / 100;
            const err = new Error('Insufficient wallet balance');
            err.code = 'INSUFFICIENT_FUNDS';
            err.shortfall = shortfall;
            err.required = totalCost;
            err.currentBalance = spendable;
            throw err;
        }
        db.prepare(`
            INSERT INTO wallet_reservations (checkout_id, user_id, amount, status)
            VALUES (?, ?, ?, 'active')
        `).run(checkoutId, userId, totalCost);
        db.prepare(`
            INSERT INTO checkout_attempts (checkout_id, user_id, amount, status, request_json)
            VALUES (?, ?, ?, 'reserved', ?)
        `).run(checkoutId, userId, totalCost, JSON.stringify(validatedItems.map(v => ({
            productId: v.product.id, quantity: v.quantity, inventoryItemIds: v.inventoryItemIds
        }))));
    }).immediate;
    reserveFunds();

    const updateAttempt = (status, extra = {}) => {
        db.prepare(`
            UPDATE checkout_attempts
            SET status = ?, supplier_order_id = COALESCE(?, supplier_order_id),
                error_message = ?, updated_at = CURRENT_TIMESTAMP
            WHERE checkout_id = ?
        `).run(status, extra.supplierOrderId || null, extra.error || null, checkoutId);
    };
    const releaseReservation = (reason) => {
        const release = db.transaction(() => {
            db.prepare(`
                UPDATE wallet_reservations SET status = 'released', resolved_at = CURRENT_TIMESTAMP
                WHERE checkout_id = ? AND status = 'active'
            `).run(checkoutId);
            updateAttempt('failed', { error: reason || 'Checkout failed before supplier confirmation' });
        });
        release.immediate();
    };

    // Step 3: Fulfill items from the correct source.
    // Supplier-backed products must never silently fall back to local stock:
    // a timeout may mean the supplier accepted the order but its response was lost.
    const fulfillmentResults = [];

    for (const valItem of validatedItems) {
        const hasSujanProduct = valItem.product.sujan_product_id !== null
            && valItem.product.sujan_product_id !== undefined
            && Number(valItem.product.sujan_product_id) > 0;

        if (hasSujanProduct) {
            updateAttempt('supplier_pending');
            try {
                const sujanRes = await sujanService.placeOrder({
                    productId: Number(valItem.product.sujan_product_id),
                    quantity: valItem.quantity,
                    inventoryItemIds: valItem.inventoryItemIds
                });

                const sujanOrderData = sujanRes.data || sujanRes;
                const sujanItems = Array.isArray(sujanOrderData.items) ? sujanOrderData.items : [];
                const keys = Array.isArray(sujanOrderData.keys) ? sujanOrderData.keys : [];
                const sujanOrderId = String(sujanOrderData.id || sujanOrderData.order_id || '');
                const deliveredCount = sujanItems.length || keys.length;
                const credentialsAreComplete = sujanItems.length > 0
                    ? sujanItems.every(entry => entry && typeof (entry.credential || entry.key) === 'string'
                        && (entry.credential || entry.key).trim().length > 0)
                    : keys.every(key => typeof key === 'string' && key.trim().length > 0);

                // Without a supplier order ID, Olaslog cannot correlate a later
                // webhook or investigate an uncertain fulfilment. Never mark it paid.
                if (!sujanOrderId || deliveredCount !== valItem.quantity || !credentialsAreComplete) {
                    const uncertainErr = new Error(
                        `Supplier response for ${valItem.product.name} could not be safely verified (order ID present: ${Boolean(sujanOrderId)}, credentials received: ${deliveredCount}, expected: ${valItem.quantity}, credentials complete: ${credentialsAreComplete}). Do not retry until the supplier order is checked.`
                    );
                    uncertainErr.code = 'SUPPLIER_UNCERTAIN';
                    uncertainErr.sujanOrderId = sujanOrderId;
                    throw uncertainErr;
                }

                updateAttempt('supplier_confirmed', { supplierOrderId: sujanOrderId });
                fulfillmentResults.push({
                    item: valItem,
                    source: 'sujan',
                    sujanOrderId,
                    productName: sujanOrderData.product || valItem.product.name,
                    items: sujanItems,
                    keys
                });
            } catch (sujanErr) {
                if (sujanErr.code === 'SUPPLIER_UNCERTAIN') {
                    updateAttempt('supplier_uncertain', { supplierOrderId: sujanErr.sujanOrderId, error: sujanErr.message });
                    recordSupplierUncertainty(userId, valItem, sujanErr);
                    throw sujanErr;
                }

                console.error(
                    `Sujan API order failed for product ${valItem.product.id}; local fallback is disabled to prevent duplicate fulfilment:`,
                    sujanErr.message
                );
                const supplierErr = new Error(
                    `The supplier could not confirm this order. Do not retry yet; check the supplier order status first. Details: ${sujanErr.message}`
                );
                supplierErr.code = 'SUPPLIER_UNCERTAIN';
                supplierErr.sujanStatus = sujanErr.status || null;
                updateAttempt('supplier_uncertain', { error: supplierErr.message });
                recordSupplierUncertainty(userId, valItem, supplierErr);
                throw supplierErr;
            }
            continue;
        }

        // Products without a Sujan product ID are local-inventory products.
        let stockRows;
        if (Array.isArray(valItem.inventoryItemIds) && valItem.inventoryItemIds.length > 0) {
            const selectedIds = [...new Set(valItem.inventoryItemIds)];
            if (selectedIds.length !== valItem.quantity) {
                const selectionErr = new Error('Selected inventory contains duplicate account IDs.');
                selectionErr.code = 'OUT_OF_STOCK';
                releaseReservation(selectionErr.message);
                throw selectionErr;
            }
            const placeholders = selectedIds.map(() => '?').join(', ');
            stockRows = db.prepare(`
                SELECT id, product_id, encrypted_credential, iv, auth_tag
                FROM stock_items
                WHERE product_id = ?
                  AND status = 'available'
                  AND id IN (${placeholders})
            `).all(valItem.product.id, ...selectedIds);
        } else {
            stockRows = db.prepare(`
                SELECT id, product_id, encrypted_credential, iv, auth_tag
                FROM stock_items
                WHERE product_id = ? AND status = 'available'
                ORDER BY id ASC
                LIMIT ?
            `).all(valItem.product.id, valItem.quantity);
        }

        if (stockRows.length !== valItem.quantity) {
            const stockErr = new Error('The selected local accounts are no longer available. Refresh the product and try again.');
            stockErr.code = 'OUT_OF_STOCK';
            releaseReservation(stockErr.message);
            throw stockErr;
        }

        fulfillmentResults.push({
            item: valItem,
            source: 'local',
            stockRows
        });
    }

    // Step 4: Run local DB updates in SQLite ACID transaction (atomic wallet debit + order save)
    const executeCheckoutTransaction = db.transaction(() => {
        // Read the ledger balance again inside the same transaction as the debit.
        const ledgerBalance = getLedgerBalance(userId);
        const reservation = db.prepare(`
            SELECT amount, status FROM wallet_reservations WHERE checkout_id = ? AND user_id = ?
        `).get(checkoutId, userId);
        if (!reservation || reservation.status !== 'active' || Math.abs(reservation.amount - totalCost) > 0.001) {
            throw new Error('Checkout wallet reservation is missing or no longer active.');
        }
        if (ledgerBalance < totalCost) {
            throw new Error('Reserved wallet funds are no longer available. Checkout was stopped.');
        }

        // Generate unique internal order number and wallet reference
        const timestamp = Date.now();
        const randomSuffix = Math.floor(1000 + Math.random() * 9000);
        const orderNumber = `ORD-${timestamp}-${randomSuffix}`;
        const walletRef = `PUR-${timestamp}-${randomSuffix}`;

        // Deduct wallet balance via immutable ledger entry
        const currentBalance = ledgerBalance;
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

        // Collect all Sujan order IDs
        const sujanOrderIds = fulfillmentResults
            .filter(f => f.sujanOrderId)
            .map(f => f.sujanOrderId)
            .join(',');

        // Create Order
        const orderResult = db.prepare(`
            INSERT INTO orders (order_number, sujan_order_id, user_id, total_amount, status)
            VALUES (?, ?, ?, ?, 'completed')
        `).run(orderNumber, sujanOrderIds || null, userId, totalCost);
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

            if (source === 'sujan') {
                // Sujan Logs API format: items[].credential; fallback to keys[] array
                const sujanItems = fulfillment.items || [];
                const keys = fulfillment.keys || [];

                if (sujanItems.length > 0) {
                    // Classic Sujan Logs Marketplace format
                    for (const sujanItem of sujanItems) {
                        const rawCred = sujanItem.credential || sujanItem.key || 'No credential provided';
                        const publicData = sujanItem.public_data || `Account #${sujanItem.id || 'AUTO'}`;
                        const enc = encrypt(rawCred);

                        db.prepare(`
                            INSERT INTO delivered_credentials
                            (order_id, order_item_id, product_id, stock_item_id, sujan_item_id, public_data, encrypted_credential, iv, auth_tag)
                            VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)
                        `).run(
                            orderId,
                            orderItemId,
                            item.product.id,
                            sujanItem.id || null,
                            publicData,
                            enc.encrypted,
                            enc.iv,
                            enc.authTag
                        );

                        deliveredCredentials.push({
                            productId: item.product.id,
                            productName: sujanItem.product_name || fulfillment.productName || item.product.name,
                            publicData: publicData,
                            credentialText: rawCred
                        });
                    }
                } else {
                    // Fallback: keys[] array format
                    for (let idx = 0; idx < keys.length; idx++) {
                        const rawKey = keys[idx] || 'No key provided';
                        const publicData = `Key ${idx + 1} of ${keys.length}`;
                        const enc = encrypt(rawKey);
                        const sujanItemId = fulfillment.sujanOrderId ? `${fulfillment.sujanOrderId}-${idx + 1}` : null;

                        db.prepare(`
                            INSERT INTO delivered_credentials
                            (order_id, order_item_id, product_id, stock_item_id, sujan_item_id, public_data, encrypted_credential, iv, auth_tag)
                            VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)
                        `).run(
                            orderId,
                            orderItemId,
                            item.product.id,
                            sujanItemId,
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
                }
            } else if (source === 'local') {
                for (const stockRow of fulfillment.stockRows) {
                    const stockUpdate = db.prepare(`
                        UPDATE stock_items
                        SET status = 'sold', order_id = ?, sold_at = CURRENT_TIMESTAMP
                        WHERE id = ? AND status = 'available'
                    `).run(orderId, stockRow.id);

                    if (stockUpdate.changes !== 1) {
                        const stockErr = new Error('One or more selected accounts were purchased by another customer. Please refresh and try again.');
                        stockErr.code = 'OUT_OF_STOCK';
                        throw stockErr;
                    }

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

        db.prepare(`
            UPDATE wallet_reservations SET status = 'committed', resolved_at = CURRENT_TIMESTAMP
            WHERE checkout_id = ? AND status = 'active'
        `).run(checkoutId);
        db.prepare(`
            UPDATE checkout_attempts SET status = 'completed', updated_at = CURRENT_TIMESTAMP
            WHERE checkout_id = ?
        `).run(checkoutId);

        return {
            orderId,
            orderNumber,
            sujanOrderIds,
            totalAmount: totalCost,
            remainingBalance: newBalance,
            createdAt: new Date().toISOString(),
            deliveredCredentials
        };
    });

    let result;
    try {
        result = executeCheckoutTransaction();
    } catch (transactionError) {
        // If a supplier order may already exist, keep the reservation for manual
        // reconciliation. Local-only failures can safely release the hold.
        const supplierWasContacted = validatedItems.some(v =>
            v.product.sujan_product_id !== null && v.product.sujan_product_id !== undefined
            && Number(v.product.sujan_product_id) > 0
        );
        if (!supplierWasContacted) releaseReservation(transactionError.message);
        else updateAttempt('supplier_uncertain', { error: transactionError.message });
        throw transactionError;
    }

    // Send purchase confirmation email & Telegram delivery (non-blocking)
    try {
        const userRow = db.prepare('SELECT email, full_name, telegram_id FROM users WHERE id = ?').get(userId);
        if (userRow) {
            emailService.sendPurchaseEmail(
                { email: userRow.email, fullName: userRow.full_name },
                {
                    orderNumber: result.orderNumber,
                    totalAmount: result.totalAmount,
                    remainingBalance: result.remainingBalance,
                    items: result.deliveredCredentials
                }
            ).catch(err => {
                console.error('[Order] Failed to send purchase email:', err.message);
            });

            // Instant Telegram DM delivery
            if (userRow.telegram_id) {
                telegramBot.notifyUserOrderDelivered({
                    telegramId: userRow.telegram_id,
                    orderNumber: result.orderNumber,
                    totalAmount: result.totalAmount,
                    deliveredItems: result.deliveredCredentials
                }).catch(err => {
                    console.error('[Order] Failed to send Telegram order delivery:', err.message);
                });
            }
        }
    } catch (deliveryErr) {
        console.error('[Order] Error triggering order notifications:', deliveryErr.message);
    }

    // Check for low stock alerts on local inventory (non-blocking)
    try {
        for (const fulfillment of fulfillmentResults) {
            if (fulfillment.source === 'local') {
                const prodId = fulfillment.item.product.id;
                const prodName = fulfillment.item.product.name;
                const stockRow = db.prepare(`SELECT COUNT(*) as count FROM stock_items WHERE product_id = ? AND status = 'available'`).get(prodId);
                const remaining = stockRow ? stockRow.count : 0;
                if (remaining <= 3) {
                    telegram.notifyLowStock({
                        productName: prodName,
                        productId: prodId,
                        remaining
                    });
                }
            }
        }
    } catch (stockErr) {
        console.warn('[Telegram] Low stock notification check error:', stockErr.message);
    }

    return result;
}

/**
 * Finalizes a supplier checkout from a signed completion webhook when the
 * original request received supplier confirmation but could not commit locally.
 * It only acts on a durable active reservation and is safe to retry.
 */
function completeSupplierCheckoutFromWebhook(sujanOrderId, orderData) {
    const attempt = db.prepare(`
        SELECT * FROM checkout_attempts
        WHERE supplier_order_id = ? AND status IN ('supplier_confirmed', 'supplier_uncertain')
        ORDER BY id DESC LIMIT 1
    `).get(String(sujanOrderId));
    if (!attempt) return null;

    const existingOrder = db.prepare('SELECT id, order_number FROM orders WHERE sujan_order_id = ?').get(String(sujanOrderId));
    if (existingOrder) return { alreadyCompleted: true, orderId: existingOrder.id };

    let requestedItems;
    try { requestedItems = JSON.parse(attempt.request_json); }
    catch (_) { throw new Error('Stored checkout request cannot be read'); }
    if (!Array.isArray(requestedItems) || requestedItems.length !== 1) {
        throw new Error('Supplier recovery only supports one stored supplier product line');
    }

    const eventItems = Array.isArray(orderData?.items) ? orderData.items : [];
    const expectedQuantity = Number(requestedItems[0].quantity);
    if (!eventItems.length || eventItems.length !== expectedQuantity) {
        throw new Error('Supplier completion does not contain the expected number of credentials');
    }
    if (!eventItems.every(item => item && typeof (item.credential || item.key) === 'string'
        && String(item.credential || item.key).trim().length > 0)) {
        throw new Error('Supplier completion contains an empty credential');
    }

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(requestedItems[0].productId));
    if (!product) throw new Error('The product for this supplier checkout no longer exists');

    const finalize = db.transaction(() => {
        const freshAttempt = db.prepare('SELECT * FROM checkout_attempts WHERE checkout_id = ?').get(attempt.checkout_id);
        if (!freshAttempt || !['supplier_confirmed', 'supplier_uncertain'].includes(freshAttempt.status)) {
            const completed = db.prepare('SELECT id FROM orders WHERE sujan_order_id = ?').get(String(sujanOrderId));
            if (completed) return { alreadyCompleted: true, orderId: completed.id };
            throw new Error('Supplier checkout is no longer awaiting reconciliation');
        }

        const reservation = db.prepare(`
            SELECT * FROM wallet_reservations WHERE checkout_id = ? AND user_id = ? AND status = 'active'
        `).get(attempt.checkout_id, attempt.user_id);
        if (!reservation || Math.abs(reservation.amount - attempt.amount) > 0.001) {
            throw new Error('The customer's wallet reservation is missing');
        }
        const ledgerBalance = getLedgerBalance(attempt.user_id);
        if (ledgerBalance < attempt.amount) throw new Error('Reserved funds are no longer available');

        const timestamp = Date.now();
        const orderNumber = `ORD-${timestamp}-${Math.floor(1000 + Math.random() * 9000)}`;
        const newBalance = Math.round((ledgerBalance - attempt.amount) * 100) / 100;
        const walletRef = `PUR-${timestamp}-${Math.floor(1000 + Math.random() * 9000)}`;

        db.prepare(`
            INSERT INTO wallet_transactions
            (user_id, type, amount, balance_before, balance_after, reference, status, payment_channel, description, metadata)
            VALUES (?, 'purchase', ?, ?, ?, ?, 'successful', 'wallet', ?, ?)
        `).run(attempt.user_id, attempt.amount, ledgerBalance, newBalance, walletRef,
            `Recovered supplier purchase - ${orderNumber}`,
            JSON.stringify({ orderNumber, totalCost: attempt.amount, supplierOrderId: String(sujanOrderId), recoveredFromWebhook: true }));

        const orderResult = db.prepare(`
            INSERT INTO orders (order_number, sujan_order_id, user_id, total_amount, status)
            VALUES (?, ?, ?, ?, 'completed')
        `).run(orderNumber, String(sujanOrderId), attempt.user_id, attempt.amount);
        const orderId = orderResult.lastInsertRowid;
        const qty = expectedQuantity;
        const itemResult = db.prepare(`
            INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal)
            VALUES (?, ?, ?, ?, ?)
        `).run(orderId, product.id, qty, product.price, attempt.amount);
        const orderItemId = itemResult.lastInsertRowid;

        for (let index = 0; index < eventItems.length; index++) {
            const supplierItem = eventItems[index];
            const credential = String(supplierItem.credential || supplierItem.key);
            const encrypted = encrypt(credential);
            db.prepare(`
                INSERT INTO delivered_credentials
                (order_id, order_item_id, product_id, stock_item_id, sujan_item_id, public_data, encrypted_credential, iv, auth_tag)
                VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)
            `).run(orderId, orderItemId, product.id,
                supplierItem.id === undefined || supplierItem.id === null ? String(sujanOrderId) + '-' + (index + 1) : String(supplierItem.id),
                supplierItem.public_data || ('Account #' + (supplierItem.id || 'AUTO')),
                encrypted.encrypted, encrypted.iv, encrypted.authTag);
        }

        db.prepare(`
            UPDATE wallet_reservations SET status = 'committed', resolved_at = CURRENT_TIMESTAMP
            WHERE checkout_id = ? AND status = 'active'
        `).run(attempt.checkout_id);
        db.prepare(`
            UPDATE checkout_attempts SET status = 'completed', error_message = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE checkout_id = ?
        `).run(attempt.checkout_id);

        return { alreadyCompleted: false, orderId, orderNumber };
    });
    return finalize.immediate();
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
    completeSupplierCheckoutFromWebhook,
    getOrderWithCredentials
};

