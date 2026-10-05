/**
 * Olaslog - Automated Catalog Sync Scheduler
 *
 * Automatically syncs, updates, and ingests live products and categories from
 * the provider API (Sujan Logs Marketplace / Rakib) on a configurable schedule.
 *
 * Features:
 * - Recurring timer (defaults to every 15 minutes, configurable via CATALOG_SYNC_INTERVAL_MINUTES)
 * - Safe startup delay: allows server and database to initialize before first sync
 * - Concurrency mutex: prevents overlapping sync executions
 * - Auto-markup & price retention: respects manual_price_override
 * - Audit logging: records sync history into SQLite audit_logs
 * - Manual trigger & status reporting API for Admin Dashboard
 */

const sujanService = require('./sujan');
require('dotenv').config();

const DEFAULT_INTERVAL_MINUTES = 15;
const parsedInterval = parseInt(process.env.CATALOG_SYNC_INTERVAL_MINUTES || '', 10);
const INTERVAL_MINUTES = (!isNaN(parsedInterval) && parsedInterval >= 1)
    ? parsedInterval
    : DEFAULT_INTERVAL_MINUTES;

let syncTimer = null;
let isSyncing = false;
let lastSyncAt = null;
let lastSyncStatus = 'never'; // 'never' | 'success' | 'failed' | 'in_progress'
let lastSyncDurationMs = 0;
let lastSyncStats = null;
let lastSyncError = null;
let nextSyncAt = null;
let syncCount = 0;

/**
 * Execute a catalog sync run with timing, locking, and audit logging
 *
 * @param {string} triggeredBy - 'startup' | 'scheduler' | 'manual'
 * @param {number|null} adminId - Optional admin user ID if triggered manually
 * @returns {Promise<Object>}
 */
async function runCatalogSync(triggeredBy = 'scheduler', adminId = null) {
    if (isSyncing) {
        return {
            success: false,
            in_progress: true,
            message: 'Catalog synchronization is already in progress'
        };
    }

    isSyncing = true;
    const startTime = Date.now();

    try {
        console.log(`[SyncScheduler] 🔄 Starting catalog sync (triggered by: ${triggeredBy})...`);
        const res = await sujanService.syncCatalogFromSujan();
        const durationMs = Date.now() - startTime;

        lastSyncAt = new Date();
        lastSyncDurationMs = durationMs;
        lastSyncStatus = res.success ? 'success' : 'failed';
        lastSyncStats = res;
        lastSyncError = res.success ? null : (res.message || 'Sync completed with notice');
        syncCount++;

        // Persist sync event to SQLite audit_logs
        try {
            const db = require('../db');
            db.prepare(`
                INSERT INTO audit_logs (admin_id, action, target_entity, target_id, details)
                VALUES (?, 'catalog_sync', 'products', 'provider_api', ?)
            `).run(
                adminId || null,
                JSON.stringify({
                    triggered_by: triggeredBy,
                    duration_ms: durationMs,
                    status: lastSyncStatus,
                    products_synced: res.productsSynced || 0,
                    products_added: res.productsAdded || 0,
                    products_updated: res.productsUpdated || 0,
                    categories_synced: res.categoriesSynced || 0,
                    total_provider_products: res.totalCatalogCount || 0
                })
            );
        } catch (dbErr) {
            console.warn('[SyncScheduler] Could not record sync audit log:', dbErr.message);
        }

        if (res.success) {
            console.log(
                `[SyncScheduler] ✅ Catalog sync complete (${durationMs}ms): ` +
                `+${res.productsAdded || 0} new, ~${res.productsUpdated || 0} updated, ` +
                `+${res.categoriesSynced || 0} categories, ${res.totalCatalogCount || 0} total.`
            );
        } else {
            console.warn(`[SyncScheduler] ⚠️ Catalog sync completed with notice: ${res.message} (${durationMs}ms)`);
        }

        return {
            success: res.success,
            stats: res,
            durationMs,
            lastSyncAt: lastSyncAt.toISOString(),
            triggeredBy
        };
    } catch (err) {
        const durationMs = Date.now() - startTime;
        lastSyncAt = new Date();
        lastSyncDurationMs = durationMs;
        lastSyncStatus = 'failed';
        lastSyncError = err.message;
        console.error(`[SyncScheduler] ❌ Catalog sync failed after ${durationMs}ms:`, err.message);

        return {
            success: false,
            error: err.message,
            durationMs,
            lastSyncAt: lastSyncAt.toISOString(),
            triggeredBy
        };
    } finally {
        isSyncing = false;
        if (syncTimer) {
            nextSyncAt = new Date(Date.now() + INTERVAL_MINUTES * 60 * 1000);
        }
    }
}

/**
 * Start the recurring automated background sync job
 *
 * @param {number|null} customIntervalMinutes
 * @returns {Object}
 */
function startSyncJob(customIntervalMinutes = null) {
    if (syncTimer) {
        clearInterval(syncTimer);
        syncTimer = null;
    }

    const interval = (customIntervalMinutes && customIntervalMinutes >= 1)
        ? customIntervalMinutes
        : INTERVAL_MINUTES;
    const intervalMs = interval * 60 * 1000;

    console.log(`[SyncScheduler] ⏱️ Initializing automated catalog sync job (every ${interval} minutes).`);

    // Initial startup sync with slight delay to ensure DB and HTTP server have settled
    setTimeout(() => {
        runCatalogSync('startup').catch(err => {
            console.warn('[SyncScheduler] Startup sync notice:', err.message);
        });
    }, 1500);

    // Recurring periodic interval
    syncTimer = setInterval(() => {
        runCatalogSync('scheduler').catch(err => {
            console.warn('[SyncScheduler] Scheduled sync error:', err.message);
        });
    }, intervalMs);

    nextSyncAt = new Date(Date.now() + intervalMs);

    return {
        active: true,
        intervalMinutes: interval,
        nextSyncAt: nextSyncAt.toISOString()
    };
}

/**
 * Stop the recurring background sync job (useful for graceful shutdown or tests)
 */
function stopSyncJob() {
    if (syncTimer) {
        clearInterval(syncTimer);
        syncTimer = null;
        nextSyncAt = null;
        console.log('[SyncScheduler] ⏹️ Stopped automated catalog sync job.');
    }
}

/**
 * Return current sync scheduler status and statistics
 *
 * @returns {Object}
 */
function getSyncStatus() {
    return {
        isSyncing,
        jobActive: Boolean(syncTimer),
        intervalMinutes: INTERVAL_MINUTES,
        lastSyncAt: lastSyncAt ? lastSyncAt.toISOString() : null,
        lastSyncStatus,
        lastSyncDurationMs,
        lastSyncStats,
        lastSyncError,
        nextSyncAt: nextSyncAt ? nextSyncAt.toISOString() : null,
        syncCount
    };
}

module.exports = {
    startSyncJob,
    stopSyncJob,
    runCatalogSync,
    getSyncStatus,
    INTERVAL_MINUTES
};
