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
            COALESCE(SUM(CASE 
                WHEN type IN ('funding', 'refund', 'credit') AND status = 'successful' THEN amount 
                WHEN type = 'adjustment' AND status = 'successful' AND amount >= 0 THEN amount
                ELSE 0 END), 0) -
            COALESCE(SUM(CASE 
                WHEN type IN ('purchase', 'debit') AND status = 'successful' THEN amount 
                WHEN type = 'adjustment' AND status = 'successful' AND amount < 0 THEN ABS(amount)
                ELSE 0 END), 0) as balance
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

/**
 * Admin manual adjustment of a user's wallet balance
 * @param {number} userId - The target user ID
 * @param {number} adminId - The administrator performing the adjustment
 * @param {object} options - { action: 'credit' | 'debit' | 'set', amount: number, newBalance?: number, reason?: string }
 */
function adjustUserBalance(userId, adminId, { action, amount, newBalance, reason }) {
    const user = db.prepare('SELECT id, email, full_name FROM users WHERE id = ?').get(userId);
    if (!user) {
        throw new Error('User not found');
    }

    const currentBalance = getWalletBalance(userId);
    let targetBalance = currentBalance;
    let delta = 0;
    let txType = 'funding';
    let channel = 'admin_credit';
    let desc = '';

    if (action === 'credit') {
        delta = Math.round(parseFloat(amount) * 100) / 100;
        if (isNaN(delta) || delta <= 0) {
            throw new Error('Credit amount must be greater than ₦0');
        }
        targetBalance = Math.round((currentBalance + delta) * 100) / 100;
        txType = 'funding';
        channel = 'admin_credit';
        desc = reason ? `Admin Credit: ${reason}` : 'Admin manual balance credit';
    } else if (action === 'debit') {
        delta = Math.round(parseFloat(amount) * 100) / 100;
        if (isNaN(delta) || delta <= 0) {
            throw new Error('Debit amount must be greater than ₦0');
        }
        if (delta > currentBalance) {
            throw new Error(`Debit amount (₦${delta.toLocaleString()}) exceeds user's current balance (₦${currentBalance.toLocaleString()})`);
        }
        targetBalance = Math.round((currentBalance - delta) * 100) / 100;
        txType = 'debit';
        channel = 'admin_debit';
        desc = reason ? `Admin Debit: ${reason}` : 'Admin manual balance debit';
    } else if (action === 'set') {
        const target = Math.round(parseFloat(newBalance !== undefined && newBalance !== '' ? newBalance : amount) * 100) / 100;
        if (isNaN(target) || target < 0) {
            throw new Error('Target balance must be a non-negative number');
        }
        const diff = Math.round((target - currentBalance) * 100) / 100;
        if (diff === 0) {
            throw new Error('Target balance is identical to the current balance');
        }
        targetBalance = target;
        if (diff > 0) {
            delta = diff;
            txType = 'funding';
            channel = 'admin_credit';
            desc = reason ? `Admin Balance Adjustment (+₦${delta.toLocaleString()}): ${reason}` : `Admin adjusted balance to ₦${target.toLocaleString()}`;
        } else {
            delta = Math.abs(diff);
            txType = 'debit';
            channel = 'admin_debit';
            desc = reason ? `Admin Balance Adjustment (-₦${delta.toLocaleString()}): ${reason}` : `Admin adjusted balance to ₦${target.toLocaleString()}`;
        }
    } else {
        throw new Error('Invalid adjustment action. Must be credit, debit, or set');
    }

    const timestamp = Date.now();
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const reference = `ADJ-${timestamp}-${randomSuffix}`;

    const metadata = {
        adminId,
        action,
        delta,
        reason: reason || '',
        adjustedAt: new Date().toISOString()
    };

    const runTx = db.transaction(() => {
        const stmt = db.prepare(`
            INSERT INTO wallet_transactions
            (user_id, type, amount, balance_before, balance_after, reference, status, payment_channel, description, metadata)
            VALUES (?, ?, ?, ?, ?, ?, 'successful', ?, ?, ?)
        `);
        const result = stmt.run(
            userId,
            txType,
            delta,
            currentBalance,
            targetBalance,
            reference,
            channel,
            desc,
            JSON.stringify(metadata)
        );

        return {
            id: result.lastInsertRowid,
            reference,
            balanceBefore: currentBalance,
            balanceAfter: targetBalance,
            amount: delta,
            type: txType,
            channel,
            description: desc,
            user
        };
    });

    return runTx();
}

module.exports = {
    getWalletBalance,
    recordFunding,
    completeFunding,
    recordRefund,
    getTransactions,
    adjustUserBalance,
    MIN_FUNDING
};


