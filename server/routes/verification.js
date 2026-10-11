'use strict';

const express = require('express');
const router = express.Router();
const { authenticate, optionalAuth } = require('../middleware/auth');
const phoneVerify = require('../services/phoneVerify');

// 1. Get available services with NGN pricing and live availability
router.get('/services', optionalAuth, async (req, res) => {
    try {
        const forceRefresh = req.query.refresh === 'true';
        const services = await phoneVerify.listServices(forceRefresh);
        const settings = phoneVerify.getSettings();

        return res.json({
            success: true,
            services,
            config: {
                isConfigured: settings.isConfigured,
                usdRate: settings.usdRate,
                marginPercent: settings.marginPercent,
                minPriceNgn: settings.minPriceNgn
            }
        });
    } catch (err) {
        console.error('Failed to fetch verification services:', err);
        return res.status(500).json({ success: false, error: 'Could not load verification services' });
    }
});

// 2. Get current user's active verification (if any)
router.get('/active', authenticate, async (req, res) => {
    try {
        const active = phoneVerify.getActiveVerification(req.user.id);
        if (!active) {
            return res.json({ success: true, active: null });
        }

        // Fresh status check
        const liveStatus = await phoneVerify.getVerificationStatus(active.id, req.user.id);
        return res.json({ success: true, active: liveStatus });
    } catch (err) {
        console.error('Error fetching active verification:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 3. Purchase / Request an MDN phone number
router.post('/request', authenticate, async (req, res) => {
    try {
        const { service, areacode, state, markup, mdn } = req.body;
        if (!service) {
            return res.status(400).json({ success: false, error: 'Service name is required' });
        }

        const result = await phoneVerify.requestNumber({
            userId: req.user.id,
            service,
            areacode,
            state,
            markup,
            mdn
        });

        return res.status(201).json({
            success: true,
            message: 'Phone number assigned successfully! Waiting for incoming SMS code.',
            verification: result
        });
    } catch (err) {
        if (err.code === 'INSUFFICIENT_FUNDS') {
            return res.status(402).json({
                success: false,
                code: 'INSUFFICIENT_FUNDS',
                error: err.message,
                required: err.required,
                currentBalance: err.currentBalance,
                shortfall: err.shortfall,
                fundingUrl: '/#wallet'
            });
        }

        console.error('Phone verification request failed:', err.message);
        return res.status(400).json({ success: false, error: err.message || 'Failed to request verification number' });
    }
});

// 4. Check status & poll for SMS / OTP code
router.get('/order/:id', authenticate, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) {
            return res.status(400).json({ success: false, error: 'Invalid order ID' });
        }

        const status = await phoneVerify.getVerificationStatus(id, req.user.id);
        return res.json({ success: true, verification: status });
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
});

// 5. Cancel number & get instant 100% wallet refund
router.post('/order/:id/cancel', authenticate, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) {
            return res.status(400).json({ success: false, error: 'Invalid order ID' });
        }

        const result = await phoneVerify.cancelAndRefund(id, req.user.id);
        return res.json(result);
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
});

// 6. User verification order history
router.get('/history', authenticate, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit || '50', 10);
        const history = phoneVerify.getUserVerifications(req.user.id, limit);
        return res.json({ success: true, history });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Failed to retrieve verification history' });
    }
});

// 7. Webhook endpoint for USPhoneVerify (application/x-www-form-urlencoded or JSON)
router.post('/webhook', async (req, res) => {
    try {
        console.log('📥 [PhoneVerify Webhook Received]:', req.body);
        const result = await phoneVerify.handleWebhookEvent(req.body);
        // USPhoneVerify requires HTTP 200 response code
        return res.status(200).send('OK');
    } catch (err) {
        console.error('Error processing PhoneVerify webhook:', err);
        return res.status(200).send('OK'); // Always return 200 so provider does not endlessly retry failed hooks
    }
});

// GET webhook health check
router.get('/webhook', (req, res) => {
    res.status(200).json({
        status: true,
        message: 'Olaslog USPhoneVerify webhook endpoint is live and accepting POST notifications'
    });
});

module.exports = router;
