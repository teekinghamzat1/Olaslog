const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const cors = require('cors');
require('dotenv').config();

// Ensure DB is initialized
require('./db');

const rakibService = require('./services/rakib');

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
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Static directories
app.use(express.static(path.resolve(__dirname, '../public')));
app.use('/uploads', express.static(path.resolve(__dirname, '../uploads')));

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

app.listen(PORT, async () => {
    console.log(`====================================================`);
    console.log(`🚀 Olaslog Marketplace Server running on port ${PORT}`);
    console.log(`👉 http://localhost:${PORT}`);
    console.log(`====================================================`);

    // Auto-sync catalog and prices from Rakib Socials on startup
    try {
        const syncRes = await rakibService.syncCatalogFromRakib();
        console.log(`📦 Auto-synced Rakib Socials catalog: ${syncRes.productsSynced} products in ${syncRes.categoriesSynced} categories.`);
    } catch (e) {
        console.warn('Initial Rakib catalog sync notice:', e.message);
    }
});

module.exports = app;
