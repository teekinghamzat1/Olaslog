const crypto = require('crypto');
require('dotenv').config();

const API_BASE_URL = process.env.SUJAN_API_BASE_URL || 'https://api.sujanlogsmarketplace.com/v1';
const API_KEY = process.env.SUJAN_API_KEY || '';
const WEBHOOK_SECRET = process.env.SUJAN_WEBHOOK_SECRET || '';

const isPlaceholderKey = !API_KEY || API_KEY === 'rs_your_secret_key_here' || API_KEY.startsWith('mock_');

// Mock data generator for sandbox/fallback mode
const mockDatabase = {
    balance: {
        balance_minor: 45000000, // ₦450,000.00
        currency: 'NGN'
    },
    products: [
        {
            id: 1,
            name: 'Google Voice PVA (2022 Aged)',
            platform: 'Google Voice',
            category_slug: 'voice-numbers',
            price_minor: 350000, // ₦3,500.00
            currency: 'NGN',
            available_stock: 14,
            description: 'Aged 2022 US Google Voice account with permanent real US phone number, recovery email included.'
        },
        {
            id: 2,
            name: 'TextPlus USA Phone Verified',
            platform: 'TextPlus',
            category_slug: 'messaging-numbers',
            price_minor: 120000, // ₦1,200.00
            currency: 'NGN',
            available_stock: 28,
            description: 'Verified TextPlus account with US (+1) number. Ideal for WhatsApp, Telegram & OTP verifications.'
        },
        {
            id: 3,
            name: 'Talkatone Verified Account',
            platform: 'Talkatone',
            category_slug: 'messaging-numbers',
            price_minor: 150000, // ₦1,500.00
            currency: 'NGN',
            available_stock: 9,
            description: 'Pre-activated Talkatone account ready for unlimited US/Canada calls and SMS.'
        },
        {
            id: 4,
            name: 'ExpressVPN Premium 1-Month',
            platform: 'ExpressVPN',
            category_slug: 'vpn-privacy',
            price_minor: 450000, // ₦4,500.00
            currency: 'NGN',
            available_stock: 6,
            description: 'Ultra-fast private VPN credentials with access to 94+ countries and unlimited bandwidth.'
        },
        {
            id: 5,
            name: 'USA Facebook 200 Friend Aged',
            platform: 'Facebook',
            category_slug: 'social-profiles',
            price_minor: 350000, // ₦3,500.00
            currency: 'NGN',
            available_stock: 12,
            description: 'USA profile with 200+ friends, 2FA recovery secret, full cookies and recovery email included.'
        }
    ],
    stockOptions: {
        1: [
            { id: 201, public_data: 'Year: 2022 | Area Code: (415) San Francisco, CA', preview: { location: '(415) San Francisco, CA', year: 2022, profile_url: '' } },
            { id: 202, public_data: 'Year: 2022 | Area Code: (212) New York, NY', preview: { location: '(212) New York, NY', year: 2022, profile_url: '' } },
            { id: 203, public_data: 'Year: 2023 | Area Code: (312) Chicago, IL', preview: { location: '(312) Chicago, IL', year: 2023, profile_url: '' } },
            { id: 204, public_data: 'Year: 2022 | Area Code: (305) Miami, FL', preview: { location: '(305) Miami, FL', year: 2022, profile_url: '' } },
            { id: 205, public_data: 'Year: 2021 | Area Code: (702) Las Vegas, NV', preview: { location: '(702) Las Vegas, NV', year: 2021, profile_url: '' } }
        ],
        2: [
            { id: 301, public_data: 'Year: 2024 | Location: Dallas, Texas (+1-469)', preview: { location: 'Dallas, TX (+1-469)', year: 2024, profile_url: '' } },
            { id: 302, public_data: 'Year: 2024 | Location: Atlanta, Georgia (+1-404)', preview: { location: 'Atlanta, GA (+1-404)', year: 2024, profile_url: '' } },
            { id: 303, public_data: 'Year: 2023 | Location: Los Angeles, CA (+1-323)', preview: { location: 'Los Angeles, CA (+1-323)', year: 2023, profile_url: '' } }
        ],
        3: [
            { id: 401, public_data: 'Year: 2023 | Area: Phoenix, AZ (+1-602)', preview: { location: 'Phoenix, AZ (+1-602)', year: 2023, profile_url: '' } },
            { id: 402, public_data: 'Year: 2024 | Area: Seattle, WA (+1-206)', preview: { location: 'Seattle, WA (+1-206)', year: 2024, profile_url: '' } }
        ],
        4: [
            { id: 501, public_data: 'Plan: 1-Month Pro | Devices: 5 Concurrent', preview: { location: 'Global 94 Countries', year: 2024, profile_url: '' } },
            { id: 502, public_data: 'Plan: 1-Month Pro | Devices: 5 Concurrent', preview: { location: 'Global 94 Countries', year: 2024, profile_url: '' } }
        ],
        5: [
            { id: 1045, public_data: 'Year: 2021 | Location: (213) California | Facebook Link: https://facebook.com/profile.php?id=1000849201', preview: { location: '(213) California', year: 2021, profile_url: 'https://facebook.com/profile.php?id=1000849201' } },
            { id: 1046, public_data: 'Year: 2023 | Location: (713) Texas | Facebook Link: https://facebook.com/profile.php?id=1000928192', preview: { location: '(713) Texas', year: 2023, profile_url: 'https://facebook.com/profile.php?id=1000928192' } }
        ]
    }
};

/**
 * In-memory cookie/CSRF token cache
 * The provider API (Laravel) requires a valid XSRF-TOKEN cookie + X-XSRF-TOKEN header on POST requests.
 * We obtain these by hitting any GET endpoint first, then carry them forward.
 */
const csrfCache = {
    xsrfToken: null,
    sessionCookie: null,
    fetchedAt: 0,
    TTL_MS: 30 * 60 * 1000 // refresh every 30 minutes
};

async function ensureCsrfToken() {
    const now = Date.now();
    if (csrfCache.xsrfToken && csrfCache.sessionCookie && (now - csrfCache.fetchedAt) < csrfCache.TTL_MS) {
        return; // still fresh — both token AND session cookie are present
    }

    // Hit a safe GET endpoint to obtain the XSRF-TOKEN and session cookies
    const res = await fetch(`${API_BASE_URL}/products`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${process.env.SUJAN_API_KEY || API_KEY}`,
            'Accept': 'application/json',
            'X-Requested-With': 'XMLHttpRequest'
        }
    });

    const rawCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const jar = {};
    for (const c of rawCookies) {
        const [pair] = c.split(';');
        const eqIdx = pair.indexOf('=');
        if (eqIdx < 0) continue;
        const name = pair.slice(0, eqIdx).trim();
        const val  = pair.slice(eqIdx + 1).trim();
        jar[name] = val;
    }

    if (jar['XSRF-TOKEN']) {
        csrfCache.xsrfToken    = decodeURIComponent(jar['XSRF-TOKEN']);
        csrfCache.sessionCookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
        csrfCache.fetchedAt     = now;
        console.log('[CSRF] Token fetched successfully. Length:', csrfCache.xsrfToken.length);
    } else {
        console.warn('[CSRF] GET /products returned no XSRF-TOKEN cookie. Cookies received:', Object.keys(jar));
    }
}

/**
 * Generic fetch wrapper for Sujan Logs API
 * Automatically handles CSRF tokens for mutating requests.
 */
async function sujanFetch(endpoint, options = {}) {
    const url = `${API_BASE_URL}${endpoint}`;
    const method = (options.method || 'GET').toUpperCase();
    const isMutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

    // Obtain a fresh CSRF token before any state-changing request
    if (isMutating && !isPlaceholderKey) {
        try {
            await ensureCsrfToken();
        } catch (e) {
            console.warn('[CSRF] Could not prefetch CSRF token:', e.message);
        }
    }

    const headers = {
        'Authorization': `Bearer ${process.env.SUJAN_API_KEY || API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        ...(options.headers || {})
    };

    // Attach CSRF credentials for mutating requests
    if (isMutating && csrfCache.xsrfToken) {
        headers['X-XSRF-TOKEN'] = csrfCache.xsrfToken;
        headers['Cookie']       = csrfCache.sessionCookie;
        console.log('[CSRF] Attaching token to', method, endpoint, '| token length:', csrfCache.xsrfToken.length);
    } else if (isMutating) {
        console.warn('[CSRF] No token cached for', method, endpoint, '- sending without CSRF headers');
    }

    const response = await fetch(url, {
        ...options,
        headers
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
        const error = new Error(data?.message || `Sujan API error (${response.status})`);
        error.status = response.status;
        error.code = data?.error_code || 'SUJAN_API_ERROR';
        error.details = data;
        throw error;
    }

    return data;
}

/**
 * Check balance on Sujan Logs API
 */
async function getBalance() {
    if (isPlaceholderKey) {
        return {
            success: true,
            is_sandbox: true,
            data: mockDatabase.balance
        };
    }

    try {
        const res = await sujanFetch('/balance', { method: 'GET' });
        return {
            success: true,
            is_sandbox: false,
            data: res.data || res
        };
    } catch (err) {
        console.warn('Sujan API getBalance failed, using sandbox fallback:', err.message);
        return {
            success: true,
            is_sandbox: true,
            data: mockDatabase.balance
        };
    }
}

/**
 * List catalog products with live stock counts
 */
async function getProducts() {
    if (isPlaceholderKey) {
        // No real API key — return empty, let DB-synced products serve as catalog
        console.warn('Provider API key not configured. Product catalog served from local DB only.');
        return {
            success: true,
            is_sandbox: true,
            data: []
        };
    }

    try {
        const res = await sujanFetch('/products', { method: 'GET' });
        return {
            success: true,
            is_sandbox: false,
            data: Array.isArray(res.data) ? res.data : (Array.isArray(res) ? res : [])
        };
    } catch (err) {
        // API failed but key is real — return empty so stock counts gracefully fall back
        console.warn('Provider API getProducts failed, stock counts will use local DB fallback:', err.message);
        return {
            success: false,
            is_sandbox: false,
            data: []
        };
    }
}

/**
 * Retrieve single product details
 */
async function getProduct(id) {
    if (isPlaceholderKey) {
        const product = mockDatabase.products.find(p => p.id == id);
        if (!product) throw new Error('Product not found in catalog');
        return {
            success: true,
            is_sandbox: true,
            data: product
        };
    }

    try {
        const res = await sujanFetch(`/products/${id}`, { method: 'GET' });
        return {
            success: true,
            is_sandbox: false,
            data: res.data || res
        };
    } catch (err) {
        console.warn(`Sujan API getProduct(${id}) failed, using sandbox fallback:`, err.message);
        const product = mockDatabase.products.find(p => p.id == id);
        if (product) {
            return { success: true, is_sandbox: true, data: product };
        }
        throw err;
    }
}

/**
 * Fetch available stock count & public account preview options
 * GET /products/{id}/stock
 */
async function getProductStock(id) {
    if (isPlaceholderKey) {
        // No real API key — return empty stock
        return {
            success: true,
            is_sandbox: true,
            data: {
                product_id: Number(id),
                fulfillment_type: 'api',
                available_stock: 0,
                options: []
            }
        };
    }

    try {
        const res = await sujanFetch(`/products/${id}/stock`, { method: 'GET' });
        return {
            success: true,
            is_sandbox: false,
            data: res.data || res
        };
    } catch (err) {
        // API failed — return empty so local DB stock count is used as fallback in the route
        console.warn(`Provider API getProductStock(${id}) failed, falling back to local DB stock count:`, err.message);
        return {
            success: false,
            is_sandbox: false,
            data: {
                product_id: Number(id),
                fulfillment_type: 'local',
                available_stock: null,
                options: []
            }
        };
    }
}

/**
 * Get product pricing
 */
async function getProductPricing(id) {
    if (isPlaceholderKey) {
        const product = mockDatabase.products.find(p => p.id == id);
        return {
            success: true,
            is_sandbox: true,
            data: {
                product_id: Number(id),
                price_minor: product ? product.price_minor : 350000,
                currency: 'NGN'
            }
        };
    }

    try {
        const res = await sujanFetch(`/products/${id}/pricing`, { method: 'GET' });
        return {
            success: true,
            is_sandbox: false,
            data: res.data || res
        };
    } catch (err) {
        console.warn(`Sujan API getProductPricing(${id}) failed, using sandbox fallback:`, err.message);
        const product = mockDatabase.products.find(p => p.id == id);
        return {
            success: true,
            is_sandbox: true,
            data: {
                product_id: Number(id),
                price_minor: product ? product.price_minor : 350000,
                currency: 'NGN'
            }
        };
    }
}

/**
 * Place an atomic order with Sujan Logs Marketplace
 * Options:
 * 1) Specific accounts: { product_id, inventory_item_ids: [1045, 1046] }
 * 2) Quantity based: { product_id, quantity: 3 }
 */
async function placeOrder({ productId, quantity, inventoryItemIds }) {
    const payload = {
        product_id: Number(productId)
    };

    if (Array.isArray(inventoryItemIds) && inventoryItemIds.length > 0) {
        payload.inventory_item_ids = inventoryItemIds.map(Number);
    } else {
        payload.quantity = Number(quantity) || 1;
    }

    if (isPlaceholderKey) {
        // Generate simulated instant fulfillment
        const count = payload.inventory_item_ids ? payload.inventory_item_ids.length : payload.quantity;
        const product = mockDatabase.products.find(p => p.id == productId) || {
            name: 'Digital Account Product',
            platform: 'Universal',
            price_minor: 350000
        };

        const availableOptions = mockDatabase.stockOptions[productId] || [];
        const items = [];

        for (let i = 0; i < count; i++) {
            const optId = payload.inventory_item_ids ? payload.inventory_item_ids[i] : (availableOptions[i]?.id || (1000 + i));
            const publicData = availableOptions.find(o => o.id == optId)?.public_data || `USA Account #AUTO-${1000 + i}`;
            
            // Realistic credential format
            const randomUser = `user_${Math.random().toString(36).substring(2, 9)}`;
            const randomPass = `Sec!${Math.random().toString(36).substring(2, 10)}`;
            const twoFa = `JBSWY3DPEHPK3PXP`;
            const email = `${randomUser}@gmail.com`;
            const credString = `${randomUser}|${randomPass}|${twoFa}|${email}|recovery_${Math.random().toString(36).substring(2, 8)}`;

            items.push({
                id: 8900 + Math.floor(Math.random() * 1000),
                product_id: Number(productId),
                product_name: product.name,
                platform: product.platform,
                price_minor: product.price_minor,
                public_data: publicData,
                credential: credString
            });
        }

        const totalMinor = items.reduce((sum, it) => sum + it.price_minor, 0);

        return {
            message: 'Order completed.',
            data: {
                id: 4800 + Math.floor(Math.random() * 5000),
                status: 'completed',
                total_amount_minor: totalMinor,
                currency: 'NGN',
                created_at: new Date().toISOString(),
                items
            }
        };
    }

    try {
        const res = await sujanFetch('/orders', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        return res;
    } catch (err) {
        console.error('Sujan API placeOrder error:', err.message);
        throw err;
    }
}

/**
 * Retrieve order details and credentials by Sujan order ID
 */
async function getOrder(orderId) {
    if (isPlaceholderKey) {
        return {
            data: {
                id: orderId,
                status: 'completed',
                total_amount_minor: 700000,
                currency: 'NGN',
                items: []
            }
        };
    }

    return await sujanFetch(`/orders/${orderId}`, { method: 'GET' });
}

/**
 * Verify Webhook Signature (HMAC-SHA256)
 */
function verifyWebhookSignature(payloadString, signatureHeader, secret = WEBHOOK_SECRET) {
    if (!secret || !signatureHeader) return false;
    try {
        const calculated = crypto
            .createHmac('sha256', secret)
            .update(payloadString)
            .digest('hex');
        return crypto.timingSafeEqual(Buffer.from(calculated), Buffer.from(signatureHeader));
    } catch (e) {
        return false;
    }
}

/**
 * Synchronize all categories and products from Sujan Logs Marketplace
 * - Imports all categories from Sujan API
 * - Creates/updates products under their respective categories
 * - Sets default selling price to (Sujan Base Price + ₦1,000 markup) unless manual_price_override = 1
 * - Preserves any manual price set by admin
 */
async function syncCatalogFromSujan() {
    const db = require('../db');
    const catalogRes = await getProducts();
    const sujanProducts = catalogRes.data || [];

    if (!Array.isArray(sujanProducts) || !sujanProducts.length) {
        return { success: false, message: 'No products returned from provider' };
    }

    // ─── Description sanitizer ──────────────────────────────────────────────────
    // Supplier descriptions are often raw internal notes (e.g. "User/Password/2FA",
    // "Only Redem Code", "Synced from supplier API") that must never reach customers.
    const INTERNAL_DESC_PATTERNS = [
        /synced from (supplier|provider|api)/i,
        /^(user|username|email)\/(password|pass)\/(2fa|hotmail|outlook)/i,
        /^(email|username|user)\|(password|pass)\|(2fa)/i,
        /only redem(ption)? code/i,
        /only redeem code/i,
        /^email\/password(\/\w+)?$/i,
        /^user\/password(\/\w+)?$/i,
        /^(connect|use) hma vpn/i,
        /iphone not working/i,
        /^username\|password\|/i,
    ];

    function isInternalDesc(desc) {
        if (!desc || desc.trim().length < 10) return true;
        return INTERNAL_DESC_PATTERNS.some(p => p.test(desc.trim()));
    }

    function generateFriendlyDesc(name) {
        const n = name.toUpperCase();
        if (n.includes('VPN')) return 'Premium VPN subscription credentials. Instant automated delivery upon purchase. Follow the usage guide for activation instructions.';
        if (n.includes('TIKTOK')) return 'Verified TikTok account with full 2FA access. Instant automated delivery. Follow the usage guide for setup and login instructions.';
        if (n.includes('INSTAGRAM')) return 'Verified Instagram account with full 2FA access. Instant automated delivery. Follow usage guidelines for safe login.';
        if (n.includes('FACEBOOK') || n.includes(' FB ')) return 'Verified Facebook account with login credentials. Instant automated delivery. Use the recommended VPN for first login.';
        if (n.includes('TWITTER') || n.includes(' X ')) return 'Verified X (Twitter) account with full 2FA access. Instant automated delivery upon payment.';
        if (n.includes('GMAIL')) return 'Aged Gmail account with login credentials. Instant automated delivery. Comes with email, password and 2FA details.';
        if (n.includes('GOOGLE VOICE')) return 'US Google Voice account with real phone number. Instant automated delivery. Follow login instructions carefully for best results.';
        if (n.includes('PROXY') || n.includes('PROXIES')) return 'Residential proxy package with fast and anonymous IPs. Instant automated delivery of connection details upon payment.';
        if (n.includes('TEXTPLUS') || n.includes('NEXTPLUS') || n.includes('TEXTING')) return 'US texting app account with a real US phone number. Instant automated delivery. Follow the included login guide.';
        return 'Verified digital account credentials with instant automated delivery upon successful purchase. Follow the usage guide for best results.';
    }
    // ────────────────────────────────────────────────────────────────────────────

    // Category icon mapping helper
    const categoryIcons = {
        'IP & PROXY': '🌐',
        '1 MONTH PAID VPN': '🛡️',
        '7 DAYS PAID VPN': '🔒',
        '20 Days Vpn': '⚡',
        'INSTAGRAM': '📸',
        'TIKTOK': '🎵',
        'Follower Tiktok': '👥',
        'Clone X Twitter': '🐦',
        'USA TEXTING APP': '💬',
        'USA GMAIL': '📧',
        'USA REAL Facebook': '👤'
    };

    let categoriesSynced = 0;
    let productsSynced = 0;

    const findCategoryStmt = db.prepare(`SELECT id FROM product_categories WHERE slug = ? OR name = ?`);
    const insertCategoryStmt = db.prepare(`
        INSERT INTO product_categories (name, slug, icon, rules_guide_markdown)
        VALUES (?, ?, ?, ?)
    `);

    const findProductBySujanIdStmt = db.prepare(`SELECT * FROM products WHERE sujan_product_id = ?`);
    const insertProductStmt = db.prepare(`
        INSERT INTO products (
            sujan_product_id, category_id, name, slug, description,
            price, sujan_base_price, manual_price_override,
            image_url, min_order_qty, max_order_qty, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 1, 50, 1)
    `);
    const updateProductAutoPriceStmt = db.prepare(`
        UPDATE products
        SET category_id = ?, name = ?, description = ?, sujan_base_price = ?,
            price = ?, is_active = 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `);
    const updateProductManualPriceStmt = db.prepare(`
        UPDATE products
        SET category_id = ?, name = ?, description = ?, sujan_base_price = ?,
            is_active = 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `);

    for (const sp of sujanProducts) {
        // 1. Resolve category
        const catName = sp.category?.name || sp.platform?.name || 'General Digital Accounts';
        const catSlug = (sp.category?.slug || sp.platform?.slug || catName.toLowerCase().replace(/[^a-z0-9]+/g, '-')).replace(/(^-|-$)/g, '');

        let existingCat = findCategoryStmt.get(catSlug, catName);
        let categoryId = existingCat ? existingCat.id : null;

        if (!categoryId) {
            const icon = categoryIcons[catName] || '📦';
            const defaultRules = `### ⚠️ Important Usage Rules for ${catName}\n- Verify credentials upon delivery.\n- Use recommended proxies or VPN matching country/profile requirements.\n- Do not spam or violate carrier/platform policies.`;
            const catRes = insertCategoryStmt.run(catName, catSlug, icon, defaultRules);
            categoryId = catRes.lastInsertRowid;
            categoriesSynced++;
        }

        // 2. Base price from Sujan (converted from minor units NGN kobo to Naira)
        const basePriceMinor = Number(sp.price_minor || 0);
        const sujanBasePrice = basePriceMinor > 0 ? basePriceMinor / 100 : (Number(sp.price) || 0);
        const defaultSellingPrice = sujanBasePrice + 1000; // ₦1,000 margin added to Sujan price

        // 3. Product image default based on category
        const imageUrl = sp.image_url || `https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=300&auto=format&fit=crop&q=60`;

        const existingProd = findProductBySujanIdStmt.get(sp.id);

        if (!existingProd) {
            const generatedSlug = `sujan-${sp.id}-${(sp.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`;
            // Sanitize description — never expose raw supplier notes to customers
            const rawDesc = sp.description || '';
            const cleanDesc = isInternalDesc(rawDesc) ? generateFriendlyDesc(sp.name) : rawDesc;
            insertProductStmt.run(
                sp.id,
                categoryId,
                sp.name,
                generatedSlug,
                cleanDesc,
                defaultSellingPrice,
                sujanBasePrice,
                imageUrl
            );
            productsSynced++;
        } else {
            // Sanitize incoming description — preserve existing clean DB description if new one is internal/blank
            const rawDesc = sp.description || '';
            const incomingIsInternal = isInternalDesc(rawDesc);
            const existingIsInternal = isInternalDesc(existingProd.description);
            let finalDesc;
            if (!incomingIsInternal) {
                finalDesc = rawDesc; // new description from provider is clean, use it
            } else if (!existingIsInternal) {
                finalDesc = existingProd.description; // keep existing clean description
            } else {
                finalDesc = generateFriendlyDesc(sp.name); // both are internal, generate fresh
            }

            // Update product
            if (existingProd.manual_price_override === 1) {
                // Keep the admin's manual price intact, just record the latest base price
                updateProductManualPriceStmt.run(
                    categoryId,
                    sp.name,
                    finalDesc,
                    sujanBasePrice,
                    existingProd.id
                );
            } else {
                // Auto price: base price + ₦1,000 markup
                updateProductAutoPriceStmt.run(
                    categoryId,
                    sp.name,
                    finalDesc,
                    sujanBasePrice,
                    defaultSellingPrice,
                    existingProd.id
                );
            }
            productsSynced++;
        }
    }

    return {
        success: true,
        categoriesSynced,
        productsSynced,
        totalCatalogCount: sujanProducts.length
    };
}

module.exports = {
    getBalance,
    getProducts,
    getProduct,
    getProductStock,
    getProductPricing,
    placeOrder,
    getOrder,
    verifyWebhookSignature,
    syncCatalogFromSujan,
    isPlaceholderKey
};

