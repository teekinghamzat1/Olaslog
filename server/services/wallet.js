const db = require('../db');
require('dotenv').config();

const MIN_FUNDING = parseInt(process.env.MIN_FUNDING_AMOUNT || '100', 10);


/**
 * Calculates current spendable wallet balance in NGN for a user directly from immutable ledger
 * @param {number} userId
 * @returns {number}
 */
function getWalletBalance(userId) {
    const row = db.prepare(`
        SELECT 
            COALESCE(SUM(CASE WHEN type IN ('funding', 'refund') AND status = 'successful' THEN amount ELSE 0 END), 0) -
            COALESCE(SUM(CASE WHEN type = 'purchase' AND status = 'successful' THEN amount ELSE 0 END), 0) as balance
        FROM wallet_transactions
        WHERE user_id = ?
    `).get(userId);
    
    return row ? Math.round(row.balance * 100) / 100 : 0;
}

/**
 * Adds an immutable ledger entry for wallet funding
 * @param {number} userId
 * @param {number} amount
 * @param {string} reference
 * @param {string} paymentChannel
 * @param {string} status 'pending' | 'successful' | 'failed'
 * @param {object} [metadata]
 */
function recordFunding(userId, amount, reference, paymentChannel = 'virtual_bank_account', status = 'pending', metadata = {}) {
    const currentBalance = getWalletBalance(userId);
    const newBalance = status === 'successful' ? currentBalance + amount : currentBalance;

    const stmt = db.prepare(`
        INSERT INTO wallet_transactions 
        (user_id, type, amount, balance_before, balance_after, reference, status, payment_channel, description, metadata)
        VALUES (?, 'funding', ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
        userId,
        amount,
        currentBalance,
        newBalance,
        reference,
        status,
        paymentChannel,
        `Wallet top-up via ${paymentChannel.toUpperCase()}`,
        JSON.stringify(metadata)
    );

    return {
        id: result.lastInsertRowid,
        balance: newBalance,
        reference,
        status
    };
}

/**
 * Marks a funding transaction as successful (or failed) by reference (Idempotent)
 * @param {string} reference
 * @param {string} finalStatus 'successful' | 'failed'
 * @param {object} [extraMetadata]
 */
function completeFunding(reference, finalStatus = 'successful', extraMetadata = {}) {
    const existing = db.prepare(`SELECT * FROM wallet_transactions WHERE reference = ?`).get(reference);
    if (!existing) {
        throw new Error(`Transaction reference ${reference} not found`);
    }

    if (existing.status === 'successful') {
        // Idempotency check: Already completed, do not credit twice
        return {
            alreadyProcessed: true,
            balance: getWalletBalance(existing.user_id),
            transaction: existing
        };
    }

    const currentBalance = getWalletBalance(existing.user_id);
    const newBalance = finalStatus === 'successful' ? currentBalance + existing.amount : currentBalance;

    let mergedMetadata = {};
    try {
        mergedMetadata = JSON.parse(existing.metadata || '{}');
    } catch (_) {}
    mergedMetadata = { ...mergedMetadata, ...extraMetadata, verifiedAt: new Date().toISOString() };

    db.prepare(`
        UPDATE wallet_transactions
        SET status = ?,
            balance_before = ?,
            balance_after = ?,
            metadata = ?
        WHERE id = ?
    `).run(finalStatus, currentBalance, newBalance, JSON.stringify(mergedMetadata), existing.id);

    return {
        alreadyProcessed: false,
        balance: newBalance,
        transaction: {
            ...existing,
            status: finalStatus,
            balance_before: currentBalance,
            balance_after: newBalance
        }
    };
}

/**
 * Records an approved admin refund to user wallet
 * @param {number} userId
 * @param {number} amount
 * @param {number} orderId
 * @param {number} disputeId
 * @param {number} adminId
 * @param {string} reason
 */
function recordRefund(userId, amount, orderId, disputeId, adminId, reason = '') {
    const currentBalance = getWalletBalance(userId);
    const newBalance = currentBalance + amount;
    const reference = `REF-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    const metadata = {
        orderId,
        disputeId,
        adminId,
        reason,
        processedAt: new Date().toISOString()
    };

    const stmt = db.prepare(`
        INSERT INTO wallet_transactions
        (user_id, type, amount, balance_before, balance_after, reference, status, payment_channel, description, metadata)
        VALUES (?, 'refund', ?, ?, ?, ?, 'successful', 'admin_refund', ?, ?)
    `);

    const result = stmt.run(
        userId,
        amount,
        currentBalance,
        newBalance,
        reference,
        `Dispute Refund for Order #${orderId}`,
        JSON.stringify(metadata)
    );

    return {
        id: result.lastInsertRowid,
        reference,
        balance: newBalance
    };
}

/**
 * Gets user transaction ledger history
 * @param {number} userId
 * @param {number} [limit=50]
 */
function getTransactions(userId, limit = 50) {
    return db.prepare(`
        SELECT * FROM wallet_transactions
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT ?
    `).all(userId, limit);
}

module.exports = {
    getWalletBalance,
    recordFunding,
    completeFunding,
    recordRefund,
    getTransactions,
    MIN_FUNDING
};

