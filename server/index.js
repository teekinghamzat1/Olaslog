const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const cors = require('cors');
require('dotenv').config();

// Ensure DB is initialized
require('./db');

const syncScheduler = require('./services/syncScheduler');
const telegramBot = require('./services/telegramBot');

const authRoutes = require('./routes/auth');
const productRoutes = require('./routes/products');
const walletRoutes = require('./routes/wallet');
const checkoutRoutes = require('./routes/checkout');
const orderRoutes = require('./routes/orders');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable trust proxy for Nginx reverse proxy
app.set('trust proxy', 1);

// Middlewares
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({
    limit: '10mb',
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Static directories
app.use(express.static(path.resolve(__dirname, '../public')));
app.use('/uploads', express.static(path.resolve(__dirname, '../uploads')));

// Webhook route aliases for BillStack (supports /api/wallet/webhook, /api/webhook, and /webhook)
app.get(['/api/webhook', '/webhook'], (req, res) => {
    res.status(200).json({ status: true, message: 'Olaslog BillStack webhook endpoint is live and reachable' });
});
app.post(['/api/webhook', '/webhook'], (req, res, next) => {
    req.url = '/webhook';
    walletRoutes(req, res, next);
});

// Mount API Routes
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/checkout', checkoutRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/admin', adminRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', platform: 'Olaslog Digital Products Marketplace', time: new Date().toISOString() });
});

// Single Page Application Fallback for client-side routing
app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) {
        return next();
    }
    if (req.path === '/admin' || req.path.startsWith('/admin')) {
        return res.sendFile(path.resolve(__dirname, '../public/admin.html'));
    }
    res.sendFile(path.resolve(__dirname, '../public/index.html'));
});

// Global Error Handler
app.use((err, req, res, next) => {
    console.error('Unhandled server error:', err);
    res.status(500).json({ success: false, error: 'Internal server error occurred' });
});

const server = app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🚀 Olaslog Marketplace Server running on port ${PORT}`);
    console.log(`👉 http://localhost:${PORT}`);
    console.log(`====================================================`);

    // Start automated recurring catalog sync from Sujan Logs Marketplace
    const job = syncScheduler.startSyncJob();
    console.log(`📦 Catalog sync scheduler started — running every ${job.intervalMinutes} min. Next: ${job.nextSyncAt}`);

    // Start Telegram Interactive Bot service
    telegramBot.startBot();
});

// Graceful shutdown — stop the sync scheduler and telegram bot before exiting
process.on('SIGTERM', () => {
    syncScheduler.stopSyncJob();
    telegramBot.stopBot();
    server.close(() => {
        console.log('[Server] Gracefully shut down.');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    syncScheduler.stopSyncJob();
    telegramBot.stopBot();
    server.close(() => {
        console.log('[Server] Gracefully shut down (SIGINT).');
        process.exit(0);
    });
});

module.exports = app;
