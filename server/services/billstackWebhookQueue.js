const db = require('../db');
const billstackService = require('./billstack');
const emailService = require('./email');
const telegram = require('./telegram');

let timer = null;
let processing = false;

function enqueueWebhook(event, rawBody) {
    const data = event?.data || {};
    const providerReference = data.wiaxy_ref || data.transaction_ref || data.merchant_reference;
    const eventKey = providerReference
        ? `payment:${providerReference}`
        : `sha256:${require('crypto').createHash('sha256').update(String(rawBody)).digest('hex')}`;

    const result = db.prepare(`
        INSERT OR IGNORE INTO billstack_webhook_events
            (event_key, event_type, payload_json, status, attempts, next_attempt_at)
        VALUES (?, ?, ?, 'pending', 0, CURRENT_TIMESTAMP)
    `).run(eventKey, event?.event || 'unknown', JSON.stringify(event));

    const row = db.prepare('SELECT id, status FROM billstack_webhook_events WHERE event_key = ?').get(eventKey);
    if (!row) throw new Error('Webhook event could not be persisted');

    return { id: row.id, inserted: result.changes > 0, status: row.status };
}

async function processOne(row) {
    const claim = db.prepare(`
        UPDATE billstack_webhook_events
        SET status = 'processing', processing_started_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'pending'
    `).run(row.id);

    if (!claim.changes) return;

    try {
        const event = JSON.parse(row.payload_json);
        let result = null;

        if (event?.event === 'PAYMENT_NOTIFICATION' && event?.data) {
            result = await billstackService.processIncomingPayment(event.data);
            console.log('[BillStack Webhook Queue] Payment processed:', result.message,
                '| User:', result.user?.id, '| Balance:', result.balance);

            if (!result.alreadyProcessed && result.user?.id) {
                const userRow = db.prepare('SELECT email, full_name FROM users WHERE id = ?').get(result.user.id);
                if (userRow) {
                    const amount = Number.parseFloat(event.data.amount) || 0;
                    const reference = event.data.wiaxy_ref || event.data.transaction_ref || event.data.reference;

                    emailService.sendWalletFundedEmail(
                        { email: userRow.email, fullName: userRow.full_name },
                        { amount, newBalance: result.balance, reference, channel: 'virtual_bank_account' }
                    ).catch(err => console.error('[BillStack Webhook Queue] Funding email failed:', err.message));

                    telegram.notifyWalletFunded({
                        fullName: userRow.full_name,
                        email: userRow.email,
                        userId: result.user.id,
                        amount,
                        newBalance: result.balance,
                        reference
                    }).catch(err => console.error('[BillStack Webhook Queue] Telegram alert failed:', err.message));
                }
            }
        } else {
            console.log('[BillStack Webhook Queue] Recorded unhandled event type:', event?.event);
        }

        db.prepare(`
            UPDATE billstack_webhook_events
            SET status = 'processed', processed_at = CURRENT_TIMESTAMP,
                processing_started_at = NULL, last_error = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(row.id);
    } catch (err) {
        const attempts = (row.attempts || 0) + 1;
        const delaySeconds = Math.min(3600, 30 * (2 ** Math.min(attempts - 1, 7)));
        db.prepare(`
            UPDATE billstack_webhook_events
            SET status = 'pending', attempts = ?, last_error = ?,
                next_attempt_at = datetime('now', ?),
                processing_started_at = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(attempts, String(err.message || err).slice(0, 1000), `+${delaySeconds} seconds`, row.id);

        console.error('[BillStack Webhook Queue] Processing failed; retry scheduled:',
            row.id, err.message);
    }
}

async function processPendingWebhooks() {
    if (processing) return;
    processing = true;

    try {
        // Recover jobs left in "processing" by a crashed process after a 5-minute lease.
        db.prepare(`
            UPDATE billstack_webhook_events
            SET status = 'pending', processing_started_at = NULL,
                next_attempt_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE status = 'processing'
              AND processing_started_at < datetime('now', '-5 minutes')
        `).run();

        const rows = db.prepare(`
            SELECT id, payload_json, attempts
            FROM billstack_webhook_events
            WHERE status = 'pending' AND next_attempt_at <= CURRENT_TIMESTAMP
            ORDER BY id ASC
            LIMIT 25
        `).all();

        for (const row of rows) {
            await processOne(row);
        }
    } catch (err) {
        console.error('[BillStack Webhook Queue] Worker error:', err.message);
    } finally {
        processing = false;
    }
}

function startWebhookWorker() {
    if (timer) return;
    // Recover and process queued events on startup, then poll for retries.
    processPendingWebhooks();
    timer = setInterval(processPendingWebhooks, 15000);
    console.log('[BillStack Webhook Queue] Worker started (15-second poll).');
}

function stopWebhookWorker() {
    if (timer) clearInterval(timer);
    timer = null;
}

module.exports = {
    enqueueWebhook,
    processPendingWebhooks,
    startWebhookWorker,
    stopWebhookWorker
};
