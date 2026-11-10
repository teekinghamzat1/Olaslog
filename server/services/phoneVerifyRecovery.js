'use strict';

const db = require('../db');

function listUnresolvedAttempts(limit = 200) {
    const safeLimit = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 200));
    return db.prepare(`
        SELECT a.*, u.email AS user_email, u.full_name AS user_name,
               r.amount AS held_amount, r.status AS reservation_status
        FROM phone_verification_attempts a
        JOIN users u ON u.id = a.user_id
        LEFT JOIN wallet_reservations r ON r.checkout_id = a.attempt_id
        WHERE a.status IN ('provider_pending', 'provider_uncertain', 'provider_confirmed')
          AND a.recovery_status IN ('open', 'investigating')
        ORDER BY a.created_at ASC
        LIMIT ?
    `).all(safeLimit);
}

function markInvestigating(attemptId, note) {
    const cleanNote = String(note || '').trim();
    if (cleanNote.length < 5) throw new Error('Add a short investigation note (at least 5 characters).');
    const result = db.prepare(`
        UPDATE phone_verification_attempts
        SET recovery_status = 'investigating', resolution_note = ?, updated_at = CURRENT_TIMESTAMP
        WHERE attempt_id = ? AND status IN ('provider_pending', 'provider_uncertain', 'provider_confirmed')
          AND recovery_status IN ('open', 'investigating')
    `).run(cleanNote, attemptId);
    if (result.changes !== 1) throw new Error('This attempt is no longer available for review.');
    return { note: cleanNote };
}

function resolveNoIssue(attemptId, adminId, providerConfirmedNoNumber, note) {
    const cleanNote = String(note || '').trim();
    if (providerConfirmedNoNumber !== true || cleanNote.length < 10) {
        throw new Error('Confirm that the provider issued no number and add evidence in the note (at least 10 characters).');
    }
    return db.transaction(() => {
        const attempt = db.prepare(`
            SELECT * FROM phone_verification_attempts
            WHERE attempt_id = ? AND status IN ('provider_pending', 'provider_uncertain', 'provider_confirmed')
              AND recovery_status IN ('open', 'investigating')
        `).get(attemptId);
        if (!attempt) throw new Error('This attempt is already resolved or does not exist.');
        const reservation = db.prepare(`
            SELECT * FROM wallet_reservations WHERE checkout_id = ? AND user_id = ?
        `).get(attempt.attempt_id, attempt.user_id);
        if (!reservation || reservation.status !== 'active') throw new Error('No active wallet hold exists for this attempt.');

        const released = db.prepare(`
            UPDATE wallet_reservations SET status = 'released', resolved_at = CURRENT_TIMESTAMP
            WHERE checkout_id = ? AND user_id = ? AND status = 'active'
        `).run(attempt.attempt_id, attempt.user_id);
        if (released.changes !== 1) throw new Error('Wallet hold was already resolved.');

        const updated = db.prepare(`
            UPDATE phone_verification_attempts
            SET status = 'rejected', recovery_status = 'resolved_no_issue',
                resolution_note = ?, resolved_by = ?, resolved_at = CURRENT_TIMESTAMP,
                error_message = 'Administrator confirmed provider issued no number',
                updated_at = CURRENT_TIMESTAMP
            WHERE attempt_id = ? AND recovery_status IN ('open', 'investigating')
        `).run(cleanNote, adminId, attempt.attempt_id);
        if (updated.changes !== 1) throw new Error('Attempt was already resolved.');
        return { userId: attempt.user_id, amount: reservation.amount, attemptId: attempt.attempt_id };
    }).immediate();
}

module.exports = { listUnresolvedAttempts, markInvestigating, resolveNoIssue };
