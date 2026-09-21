const express = require('express');
const router = express.Router();
const db = require('../db');
const sujanService = require('../services/sujan');

// List Categories
router.get('/categories', (req, res) => {
    try {
        const categories = db.prepare(`
            SELECT c.*, COUNT(p.id) as product_count
            FROM product_categories c
            LEFT JOIN products p ON p.category_id = c.id AND p.is_active = 1
            GROUP BY c.id
            ORDER BY c.name ASC
        `).all();

        return res.json({ success: true, categories });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Failed to fetch categories' });
    }
});

// List Products with Live Sujan Stock Counts
router.get('/', async (req, res) => {
    try {
        const { category, search } = req.query;

        let query = `
            SELECT 
                p.id, 
                p.sujan_product_id,
                p.category_id, 
                p.name, 
                p.slug, 
                p.description, 
                p.price, 
                p.reseller_markup_percent,
                p.image_url, 
                p.min_order_qty, 
                p.max_order_qty,
                c.name as category_name,
                c.slug as category_slug,
                c.icon as category_icon,
                c.rules_guide_markdown
            FROM products p
            JOIN product_categories c ON p.category_id = c.id
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

        query += ` ORDER BY p.id ASC`;

        const products = db.prepare(query).all(...params);

        // Fetch live catalog from Sujan API to sync stock counts
        let sujanProductsMap = new Map();
        try {
            const sujanCatalog = await sujanService.getProducts();
            if (sujanCatalog && sujanCatalog.data) {
                for (const sp of sujanCatalog.data) {
                    sujanProductsMap.set(Number(sp.id), sp);
                }
            }
        } catch (e) {
            console.warn('Could not fetch Sujan catalog for stock count overlay:', e.message);
        }

        const enrichedProducts = products.map(p => {
            let stockCount = 0;
            let isAutoFulfilled = false;
            const targetSujanId = p.sujan_product_id || p.id;
            const sujanItem = sujanProductsMap.get(Number(targetSujanId));

            if (sujanItem) {
                if (sujanItem.fulfillment_type === 'external_auto') {
                    // Provider auto-assigns accounts — stock is always "available" (999 is a placeholder)
                    isAutoFulfilled = true;
                    stockCount = -1; // sentinel: means "available, count unknown"
                } else if (sujanItem.available_stock !== undefined && sujanItem.available_stock !== null) {
                    const parsed = parseInt(sujanItem.available_stock, 10);
                    stockCount = isNaN(parsed) ? 0 : parsed;
                }
            } else {
                // Fallback to local stock count
                const localStock = db.prepare(`SELECT COUNT(*) as count FROM stock_items WHERE product_id = ? AND status = 'available'`).get(p.id);
                stockCount = localStock ? localStock.count : (p.stock_count || 0);
            }

            return {
                id: p.id,
                sujanProductId: targetSujanId,
                name: p.name,
                slug: p.slug,
                description: p.description,
                price: p.price,
                imageUrl: p.image_url,
                minQty: p.min_order_qty || 1,
                maxQty: p.max_order_qty || 50,
                stockCount,
                isAutoFulfilled,
                inStock: isAutoFulfilled || stockCount > 0,
                hasOptions: false,
                category: {
                    id: p.category_id,
                    name: p.category_name,
                    slug: p.category_slug,
                    icon: p.category_icon,
                    rulesGuide: p.rules_guide_markdown
                }
            };
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

// Preview Available Accounts Before Purchase (MUST be before /:id to avoid swallowing)
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

        const targetSujanId = product.sujan_product_id || product.id;
        let stockData = null;
        try {
            stockData = await sujanService.getProductStock(targetSujanId);
        } catch (_) {}

        let stockCount = 0;
        let isAutoFulfilled = false;
        const rawFulfillment = stockData?.data?.fulfillment_type;
        const rawStock = stockData?.data?.available_stock;

        if (rawFulfillment === 'external_auto') {
            // Provider placeholder — actual count unknown, treat as always available
            isAutoFulfilled = true;
            stockCount = -1;
        } else if (rawStock !== undefined && rawStock !== null) {
            stockCount = parseInt(rawStock, 10);
            if (isNaN(stockCount)) stockCount = 0;
        } else {
            const localStock = db.prepare(`SELECT COUNT(*) as count FROM stock_items WHERE product_id = ? AND status = 'available'`).get(product.id);
            stockCount = localStock ? localStock.count : (product.stock_count || 0);
        }

        let options = (stockData?.data?.options || []).map(opt => ({
            id: opt.id,
            publicData: opt.public_data,
            preview: {
                location: opt.preview?.location || '',
                year: opt.preview?.year || '',
                profileUrl: opt.preview?.profile_url || ''
            }
        }));

        const hasOptions = options.length > 0;

        return res.json({
            success: true,
            stock: {
                productId: product.id,
                productName: product.name,
                unitPrice: product.price,
                fulfillmentType: rawFulfillment || 'instant',
                isAutoFulfilled,
                availableStock: isAutoFulfilled ? null : stockCount,
                hasOptions,
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

        const fallbackMarkdown = `### ⚠️ Important Usage Rules for ${product.name}\n- **Immediate Testing**: Inspect and test credentials immediately upon automated delivery.\n- **Recommended Proxies**: Always log in through residential proxies matching the assigned region/country.\n- **Security**: Update recovery factors following initial login.\n- **Support**: In the event of an authentication issue upon delivery, report via the Orders section within 24 hours.`;

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

        const targetSujanId = product.sujan_product_id || product.id;
        let stockCount = 10;

        try {
            const stockRes = await sujanService.getProductStock(targetSujanId);
            if (stockRes && stockRes.data) {
                stockCount = stockRes.data.available_stock || (stockRes.data.options ? stockRes.data.options.length : 0);
            }
        } catch (e) {
            const localStock = db.prepare(`SELECT COUNT(*) as count FROM stock_items WHERE product_id = ? AND status = 'available'`).get(product.id);
            stockCount = localStock ? localStock.count : 10;
        }

        return res.json({
            success: true,
            product: {
                id: product.id,
                sujanProductId: targetSujanId,
                name: product.name,
                slug: product.slug,
                description: product.description,
                price: product.price,
                imageUrl: product.image_url,
                minQty: product.min_order_qty || 1,
                maxQty: product.max_order_qty || 50,
                stockCount: stockCount,
                inStock: stockCount > 0,
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
