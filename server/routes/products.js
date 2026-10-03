const express = require('express');
const router = express.Router();
const db = require('../db');
const sujanService = require('../services/sujan');

function isValidImageUrl(url) {
    return Boolean(url && !url.includes('clearbit') && !url.includes('unsplash'));
}

// List Categories (Texting App first, then by most sold)
router.get('/categories', (req, res) => {
    try {
        const categories = db.prepare(`
            SELECT 
                c.*, 
                COUNT(DISTINCT p.id) as product_count,
                COALESCE(SUM(CASE WHEN o.status = 'completed' THEN oi.quantity ELSE 0 END), 0) as total_sold
            FROM product_categories c
            LEFT JOIN products p ON p.category_id = c.id AND p.is_active = 1
            LEFT JOIN order_items oi ON oi.product_id = p.id
            LEFT JOIN orders o ON o.id = oi.order_id
            GROUP BY c.id
            ORDER BY 
                CASE 
                    WHEN LOWER(c.name) LIKE '%texting%' OR LOWER(c.slug) LIKE '%texting%' THEN 0 
                    ELSE 1 
                END ASC,
                total_sold DESC,
                product_count DESC,
                c.name ASC
        `).all();

        return res.json({ success: true, categories });
    } catch (err) {
        console.error('Fetch categories error:', err);
        return res.status(500).json({ success: false, error: 'Failed to fetch categories' });
    }
});

// List Products with Live Rakib Stock Counts
router.get('/', async (req, res) => {
    try {
        const { category, search } = req.query;

        let query = `
            SELECT 
                p.id, 
                p.rakib_product_id,
                p.sujan_product_id,
                p.category_id, 
                p.name, 
                p.slug, 
                p.description, 
                p.price, 
                p.rakib_base_price,
                p.sujan_base_price,
                p.reseller_markup_percent,
                p.image_url, 
                p.min_order_qty, 
                p.max_order_qty,
                c.name as category_name,
                c.slug as category_slug,
                c.icon as category_icon,
                c.rules_guide_markdown,
                COALESCE(cat_sales.category_sold, 0) as category_sold,
                COALESCE(prod_sales.product_sold, 0) as product_sold
            FROM products p
            JOIN product_categories c ON p.category_id = c.id
            LEFT JOIN (
                SELECT p2.category_id, SUM(oi2.quantity) as category_sold
                FROM order_items oi2
                JOIN orders o2 ON o2.id = oi2.order_id AND o2.status = 'completed'
                JOIN products p2 ON p2.id = oi2.product_id
                GROUP BY p2.category_id
            ) cat_sales ON cat_sales.category_id = c.id
            LEFT JOIN (
                SELECT oi3.product_id, SUM(oi3.quantity) as product_sold
                FROM order_items oi3
                JOIN orders o3 ON o3.id = oi3.order_id AND o3.status = 'completed'
                GROUP BY oi3.product_id
            ) prod_sales ON prod_sales.product_id = p.id
            WHERE p.is_active = 1
        `;

        const params = [];
        if (category) {
            query += ` AND c.slug = ?`;
            params.push(category);
        }

        if (search) {
            query += ` AND (p.name LIKE ? OR p.description LIKE ?)`;
            params.push(`%${search}%`, `%${search}%`);
        }

        query += ` ORDER BY 
            CASE 
                WHEN LOWER(c.name) LIKE '%texting%' OR LOWER(c.slug) LIKE '%texting%' THEN 0 
                ELSE 1 
            END ASC,
            category_sold DESC,
            product_sold DESC,
            p.id ASC`;

        const products = db.prepare(query).all(...params);

        // Fetch live catalog from Sujan API to sync stock counts
        let sujanProductsMap = new Map();
        let sujanApiAvailable = false;
        try {
            const sujanCatalogRes = await sujanService.getAllProducts();
            const sujanCatalog = Array.isArray(sujanCatalogRes?.data) ? sujanCatalogRes.data : (Array.isArray(sujanCatalogRes) ? sujanCatalogRes : []);
            for (const sp of sujanCatalog) {
                sujanProductsMap.set(Number(sp.id), sp);
            }
            sujanApiAvailable = sujanCatalog.length > 0;
            console.log(`[Products] Sujan API overlay loaded ${sujanCatalog.length} products into map.`);
        } catch (e) {
            console.warn('[Products] Could not fetch Sujan catalog for stock overlay:', e.message);
        }

        const enrichedProducts = products.map(p => {
            let stockCount = 0;
            let isAutoFulfilled = false;
            let inStock = false;
            const targetSujanId = p.sujan_product_id || p.rakib_product_id || p.id;
            const sujanItem = sujanProductsMap.get(Number(targetSujanId));

            if (sujanItem) {
                stockCount = parseInt(sujanItem.available_stock ?? sujanItem.stock, 10);
                if (isNaN(stockCount)) stockCount = 0;
                isAutoFulfilled = sujanItem.fulfillment_type === 'external_auto' || sujanItem.fulfillment_type === 'api';
                // The Sujan API does not return an `in_stock` boolean — derive it:
                // For auto-fulfilled products (external_auto/api), available_stock=999 means always in stock.
                // For regular products, trust available_stock > 0.
                inStock = isAutoFulfilled ? true : (sujanItem.in_stock !== false && stockCount > 0);
            } else if (p.sujan_product_id) {
                // Product has a Sujan ID but API overlay missed it (API down or ID mismatch).
                // If the Sujan API returned data for other products but not this one, it's a real mismatch.
                // If the API was completely unavailable, default to in-stock to avoid false "Sold out" banners.
                console.warn(`[Products] sujan_product_id=${p.sujan_product_id} not found in API overlay map (map size: ${sujanProductsMap.size}). Defaulting to in-stock.`);
                isAutoFulfilled = true;
                stockCount = 999;
                inStock = true;
            } else {
                // No Sujan ID — fallback to local stock_items table
                const localStock = db.prepare(`SELECT COUNT(*) as count FROM stock_items WHERE product_id = ? AND status = 'available'`).get(p.id);
                stockCount = localStock ? localStock.count : (p.stock_count || 0);
                inStock = stockCount > 0;
            }

            return {
                id: p.id,
                rakibProductId: targetSujanId,
                sujanProductId: targetSujanId, // backwards compatibility
                name: p.name,
                slug: p.slug,
                description: p.description,
                price: p.price,
                imageUrl: isValidImageUrl(p.image_url)
                    ? p.image_url
                    : sujanService.resolveProductLogoUrl(p.name, p.category_name),
                minQty: p.min_order_qty || 1,
                maxQty: p.max_order_qty || 50,
                stockCount,
                isAutoFulfilled,
                inStock,
                hasOptions: sujanItem?.fulfillment_type === 'local',
                categorySold: p.category_sold || 0,
                productSold: p.product_sold || 0,
                category: {
                    id: p.category_id,
                    name: p.category_name,
                    slug: p.category_slug,
                    icon: p.category_icon,
                    rulesGuide: p.rules_guide_markdown
                }
            };
        });

        // Ensure sorting: Texting App category first, then most sold categories;
        // within each category, in-stock products first, followed by sales volume
        enrichedProducts.sort((a, b) => {
            const aIsTexting = /texting/i.test(a.category?.name || '') || /texting/i.test(a.category?.slug || '');
            const bIsTexting = /texting/i.test(b.category?.name || '') || /texting/i.test(b.category?.slug || '');
            if (aIsTexting !== bIsTexting) return aIsTexting ? -1 : 1;

            if (b.categorySold !== a.categorySold) {
                return (b.categorySold || 0) - (a.categorySold || 0);
            }

            // In-stock products prioritized within category
            const aInStock = a.inStock ? 1 : 0;
            const bInStock = b.inStock ? 1 : 0;
            if (bInStock !== aInStock) return bInStock - aInStock;

            // Product sales volume
            if (b.productSold !== a.productSold) {
                return (b.productSold || 0) - (a.productSold || 0);
            }

            return a.id - b.id;
        });

        return res.json({
            success: true,
            products: enrichedProducts
        });
    } catch (err) {
        console.error('Fetch products error:', err);
        return res.status(500).json({ success: false, error: 'Failed to fetch products' });
    }
});

// Preview Available Accounts Before Purchase
// GET /api/products/:id/stock
router.get('/:id/stock', async (req, res) => {
    try {
        const product = db.prepare(`
            SELECT p.*, c.name as category_name, c.slug as category_slug
            FROM products p
            JOIN product_categories c ON p.category_id = c.id
            WHERE p.id = ? AND p.is_active = 1
        `).get(req.params.id);

        if (!product) {
            return res.status(404).json({ success: false, error: 'Product not found' });
        }

        const targetSujanId = product.sujan_product_id || product.rakib_product_id || product.id;
        let stockData = null;
        try {
            stockData = await sujanService.getProductStock(targetSujanId);
        } catch (_) {}

        let stockCount = 0;
        let inStock = false;
        const rawStock = stockData?.data?.available_stock;

        if (rawStock !== undefined && rawStock !== null) {
            stockCount = parseInt(rawStock, 10);
            if (isNaN(stockCount)) stockCount = 0;
            inStock = stockData?.data?.in_stock ?? (stockCount > 0);
        } else {
            const localStock = db.prepare(`SELECT COUNT(*) as count FROM stock_items WHERE product_id = ? AND status = 'available'`).get(product.id);
            stockCount = localStock ? localStock.count : (product.stock_count || 0);
            inStock = stockCount > 0;
        }

        const options = Array.isArray(stockData?.data?.options) ? stockData.data.options : [];
        const fulfillmentType = stockData?.data?.fulfillment_type || (product.sujan_product_id ? 'external_auto' : 'instant_key');

        return res.json({
            success: true,
            stock: {
                productId: product.id,
                productName: product.name,
                unitPrice: product.price,
                fulfillmentType,
                isAutoFulfilled: fulfillmentType === 'external_auto' || fulfillmentType === 'api',
                availableStock: stockCount,
                inStock,
                hasOptions: options.length > 0,
                options
            }
        });
    } catch (err) {
        console.error('Fetch stock preview error:', err);
        return res.status(500).json({ success: false, error: 'Failed to load stock' });
    }
});

// Dedicated Product Rules & Usage Guide Endpoint
router.get('/:id/rules', async (req, res) => {
    try {
        const product = db.prepare(`
            SELECT p.id, p.name, p.price, c.name as category_name, c.rules_guide_markdown
            FROM products p
            JOIN product_categories c ON p.category_id = c.id
            WHERE p.id = ? AND p.is_active = 1
        `).get(req.params.id);

        if (!product) {
            return res.status(404).json({ success: false, error: 'Product not found' });
        }

        const fallbackMarkdown = `### âš ï¸ Important Usage Rules for ${product.name}\n- **Immediate Testing**: Inspect and test credentials immediately upon automated delivery.\n- **Recommended Proxies**: Always log in through residential proxies matching the assigned region/country.\n- **Security**: Update recovery factors following initial login.\n- **Support**: In the event of an authentication issue upon delivery, report via the Orders section within 24 hours.`;

        return res.json({
            success: true,
            rules: {
                productId: product.id,
                productName: product.name,
                categoryName: product.category_name,
                unitPrice: product.price,
                rulesGuide: product.rules_guide_markdown || fallbackMarkdown
            }
        });
    } catch (err) {
        console.error('Fetch product rules error:', err);
        return res.status(500).json({ success: false, error: 'Failed to fetch product rules' });
    }
});

// Get Single Product Details
router.get('/:id', async (req, res) => {
    try {
        const product = db.prepare(`
            SELECT 
                p.*,
                c.name as category_name,
                c.slug as category_slug,
                c.icon as category_icon,
                c.rules_guide_markdown
            FROM products p
            JOIN product_categories c ON p.category_id = c.id
            WHERE p.id = ? AND p.is_active = 1
        `).get(req.params.id);

        if (!product) {
            return res.status(404).json({ success: false, error: 'Product not found' });
        }

        const targetSujanId = product.sujan_product_id || product.rakib_product_id || product.id;
        let stockCount = 10;
        let inStock = true;

        try {
            const stockRes = await sujanService.getProductStock(targetSujanId);
            if (stockRes?.data) {
                stockCount = stockRes.data.available_stock || 0;
                inStock = stockRes.data.in_stock ?? (stockCount > 0);
            }
        } catch (e) {
            const localStock = db.prepare(`SELECT COUNT(*) as count FROM stock_items WHERE product_id = ? AND status = 'available'`).get(product.id);
            stockCount = localStock ? localStock.count : 10;
            inStock = stockCount > 0;
        }

        return res.json({
            success: true,
            product: {
                id: product.id,
                rakibProductId: targetSujanId,
                sujanProductId: targetSujanId,
                name: product.name,
                slug: product.slug,
                description: product.description,
                price: product.price,
                imageUrl: isValidImageUrl(product.image_url)
                    ? product.image_url
                    : sujanService.resolveProductLogoUrl(product.name, product.category_name),
                minQty: product.min_order_qty || 1,
                maxQty: product.max_order_qty || 50,
                stockCount,
                inStock,
                category: {
                    id: product.category_id,
                    name: product.category_name,
                    slug: product.category_slug,
                    icon: product.category_icon,
                    rulesGuide: product.rules_guide_markdown
                }
            }
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Failed to fetch product' });
    }
});

module.exports = router;

