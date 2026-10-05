/**
 * Olaslog Digital Products Marketplace - Frontend Application
 */

const state = {
    currentUser: null,
    cart: JSON.parse(localStorage.getItem('olaslog_cart') || '[]'),
    catalog: [],
    categories: [],
    activeView: 'home',
    activeDisputeOrderId: null
};

// ============================================================================
// Theme Management (Dark Vault / Crisp Light - from UI resources)
// ============================================================================

function initTheme() {
    const saved = localStorage.getItem('olaslog_theme') || 'light';
    document.documentElement.setAttribute('data-theme', saved);
    updateThemeAssets(saved);
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('olaslog_theme', next);
    updateThemeAssets(next);
}

function updateThemeAssets(theme) {
    // Legacy single icon (if used elsewhere)
    const icon = document.getElementById('themeToggleIcon');
    if (icon) {
        icon.textContent = theme === 'light' ? '☀️' : '🌙';
    }
    // Swap hero person image to match theme shirt colour
    const heroImg = document.getElementById('heroPersonImg');
    if (heroImg) {
        heroImg.src = theme === 'light'
            ? '/assets/hero_olaslog_person_light.jpg'
            : '/assets/hero_olaslog_person_dark.jpg';
    }
}

// Immediately initialize theme to avoid flash
initTheme();

// ============================================================================
// Initialization & Authentication
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
    initTheme();
    await checkAuth();
    await loadCatalog();
    handleRouting();
    updateCartUI();
    window.addEventListener('popstate', handleRouting);
    window.addEventListener('hashchange', handleRouting);
    initLiveOrderFeed();
});

async function checkAuth() {
    try {
        const res = await fetch('/api/auth/me');
        const data = await res.json();
        if (data.success && data.user) {
            state.currentUser = data.user;
            updateAuthUI();
        } else {
            state.currentUser = null;
            updateAuthUI();
        }
    } catch (_) {
        state.currentUser = null;
        updateAuthUI();
    }
}

function updateAuthUI() {
    const isAuth = !!state.currentUser;
    const isAdmin = isAuth && state.currentUser.role === 'admin';

    document.querySelectorAll('.auth-only').forEach(el => {
        el.style.display = isAuth ? (el.tagName === 'SPAN' || el.tagName === 'DIV' ? 'flex' : 'block') : 'none';
    });

    document.querySelectorAll('.guest-only').forEach(el => {
        el.style.display = isAuth ? 'none' : 'inline-flex';
    });

    document.querySelectorAll('.admin-only').forEach(el => {
        el.style.display = isAdmin ? 'block' : 'none';
    });

    const mobUserEl = document.querySelector('.mobile-sidebar-user');
    if (mobUserEl) {
        mobUserEl.style.display = isAuth ? 'flex' : 'none';
    }

    if (isAuth) {
        const displayName = state.currentUser.fullName || state.currentUser.email;
        const balFormatted = (state.currentUser.balance || 0).toLocaleString('en-NG', { minimumFractionDigits: 2 });

        const navNameEl = document.getElementById('navUserName');
        if (navNameEl) navNameEl.textContent = displayName;

        const navBalEl = document.getElementById('navWalletBalance');
        if (navBalEl) navBalEl.textContent = balFormatted;

        const mobNameEl = document.getElementById('mobUserName');
        if (mobNameEl) mobNameEl.textContent = displayName;

        const mobBalEl = document.getElementById('mobUserBalance');
        if (mobBalEl) mobBalEl.textContent = balFormatted;

        const mobAvatarEl = document.getElementById('mobUserAvatar');
        if (mobAvatarEl) {
            const initials = (state.currentUser.fullName || 'User').split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
            mobAvatarEl.textContent = initials;
        }

        const dashBalEl = document.getElementById('dashWalletBalance');
        if (dashBalEl) dashBalEl.textContent = balFormatted;
        const wallBalEl = document.getElementById('walletPageBalance');
        if (wallBalEl) wallBalEl.textContent = balFormatted;
        const nameEl = document.getElementById('dashCustomerName');
        if (nameEl) nameEl.textContent = displayName;
    }
}

async function quickLoginDemo(role) {
    const email = role === 'admin' ? 'admin@olaslog.com' : 'customer@olaslog.com';
    const password = role === 'admin' ? 'Admin@12345' : 'Customer@12345';

    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        const data = await res.json();
        if (data.success) {
            state.currentUser = data.user;
            updateAuthUI();
            showToast(`Logged in as ${role.toUpperCase()}: ${email}`, 'success');
            if (role === 'admin') {
                navigateTo('admin');
            } else {
                navigateTo('dashboard');
            }
        } else {
            showToast(data.error || 'Login failed', 'error');
        }
    } catch (err) {
        showToast('Connection error during demo login', 'error');
    }
}

async function handleLogin(e) {
    e.preventDefault();
    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;

    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        const data = await res.json();
        if (data.success) {
            state.currentUser = data.user;
            updateAuthUI();
            closeModal('authModal');
            showToast(`Welcome back, ${data.user.fullName}!`, 'success');
            navigateTo('dashboard');
        } else {
            showToast(data.error || 'Invalid credentials', 'error');
        }
    } catch (err) {
        showToast('Login request error', 'error');
    }
}

async function handleRegister(e) {
    e.preventDefault();
    const fullName = document.getElementById('regFullName').value;
    const email = document.getElementById('regEmail').value;
    const phone = document.getElementById('regPhone').value;
    const password = document.getElementById('regPassword').value;

    try {
        const res = await fetch('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fullName, email, phone, password })
        });
        const data = await res.json();
        if (data.success) {
            state.currentUser = data.user;
            updateAuthUI();
            closeModal('authModal');
            showToast('Account created successfully! Welcome to Olaslog.', 'success');
            navigateTo('dashboard');
        } else {
            showToast(data.error || 'Registration failed', 'error');
        }
    } catch (err) {
        showToast('Registration error', 'error');
    }
}

async function logoutUser() {
    try {
        await fetch('/api/auth/logout', { method: 'POST' });
        state.currentUser = null;
        updateAuthUI();
        showToast('You have been logged out.', 'info');
        navigateTo('home');
    } catch (e) {
        state.currentUser = null;
        updateAuthUI();
        navigateTo('home');
    }
}

function openAuthModal(mode = 'login') {
    switchAuthMode(mode);
    openModal('authModal');
}

function switchAuthMode(mode) {
    const isLogin = mode === 'login';
    document.getElementById('authModalTitle').textContent = isLogin ? 'Sign In to Olaslog' : 'Create an Account';
    document.getElementById('loginForm').style.display = isLogin ? 'block' : 'none';
    document.getElementById('registerForm').style.display = isLogin ? 'none' : 'block';
}

// ============================================================================
// Mobile Drawer & Sidebar Navigation
// ============================================================================

function toggleMobileDrawer(forceOpen = null) {
    const drawer = document.getElementById('mobileSidebar');
    const overlay = document.getElementById('mobileDrawerOverlay');
    if (!drawer || !overlay) return;

    const shouldOpen = forceOpen !== null ? forceOpen : !drawer.classList.contains('open');
    if (shouldOpen) {
        drawer.classList.add('open');
        overlay.classList.add('open');
        document.body.style.overflow = 'hidden';
    } else {
        drawer.classList.remove('open');
        overlay.classList.remove('open');
        document.body.style.overflow = '';
    }
}

// ============================================================================
// Routing & Navigation (Clean HTML5 History API)
// ============================================================================

function getViewFromUrl() {
    // 1. Intercept legacy hash navigation (e.g. https://olaslog.com/#shop) and clean it to /shop
    if (window.location.hash) {
        const hashClean = window.location.hash.replace(/^#\/?/, '').split('?')[0];
        if (hashClean) {
            const cleanPath = (hashClean === 'home' || !hashClean) ? '/' : `/${hashClean}`;
            const search = window.location.search || '';
            if (window.history.replaceState) {
                window.history.replaceState(null, '', cleanPath + search);
            }
            return hashClean;
        }
    }

    // 2. Read from pathname (e.g. /shop, /orders, /wallet, /dashboard)
    const pathname = window.location.pathname.replace(/^\/+|\/+$/g, '');
    const firstSegment = pathname.split('/')[0];

    if (!firstSegment || firstSegment === 'index.html' || firstSegment === 'home') {
        return 'home';
    }

    return firstSegment;
}

function handleRouting() {
    const viewName = getViewFromUrl();

    // Intercept modal & auth routes so page is NEVER blank
    if (viewName === 'authModal' || viewName === 'login') {
        openAuthModal('login');
        if (state.activeView && state.activeView !== 'authModal' && state.activeView !== 'login' && document.getElementById(`view-${state.activeView}`)) {
            switchView(state.activeView);
        } else {
            switchView('home');
        }
        return;
    }

    if (viewName === 'register') {
        openAuthModal('register');
        if (state.activeView && state.activeView !== 'register' && document.getElementById(`view-${state.activeView}`)) {
            switchView(state.activeView);
        } else {
            switchView('home');
        }
        return;
    }

    // Protect private routes
    if (['dashboard', 'orders', 'wallet'].includes(viewName) && !state.currentUser) {
        showToast('Please sign in to access your dashboard and wallet', 'info');
        openAuthModal('login');
        switchView('home');
        return;
    }

    if (viewName === 'admin') {
        window.location.href = '/admin';
        return;
    }

    // If view does not exist, default safely to 'home'
    const targetView = document.getElementById(`view-${viewName}`);
    if (!targetView) {
        switchView('home');
        return;
    }

    switchView(viewName);
}

function navigateTo(viewName, replace = false) {
    toggleMobileDrawer(false);
    const targetPath = (viewName === 'home' || !viewName) ? '/' : `/${viewName}`;
    const currentPath = window.location.pathname;

    if (window.history.pushState) {
        if (window.location.hash || replace) {
            window.history.replaceState(null, '', targetPath);
        } else if (currentPath !== targetPath) {
            window.history.pushState(null, '', targetPath);
        }
    }

    handleRouting();
}

function switchView(viewName) {
    toggleMobileDrawer(false);
    state.activeView = viewName;

    // Hide all views
    document.querySelectorAll('.app-view').forEach(v => v.style.display = 'none');
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));

    const targetView = document.getElementById(`view-${viewName}`);
    if (targetView) {
        targetView.style.display = 'block';
    } else {
        const homeView = document.getElementById('view-home');
        if (homeView) homeView.style.display = 'block';
    }

    const navLink = document.getElementById(`nav-${viewName}`);
    if (navLink) {
        navLink.classList.add('active');
    }

    // Sync mobile bottom navigation items
    document.querySelectorAll('.navitem').forEach(b => b.classList.remove('active'));
    const bottomTab = document.getElementById(`bnav-${viewName}`);
    if (bottomTab) {
        bottomTab.classList.add('active');
    }

    // Dynamic Title Update for SEO & Tab history
    const viewTitles = {
        home: 'Olaslog | Instant Digital Accounts, Virtual Numbers & Subscriptions Marketplace',
        shop: 'Shop Catalog — Verified Accounts & Services | Olaslog',
        dashboard: 'Client Dashboard & Vault | Olaslog',
        orders: 'Order History & Credentials | Olaslog',
        wallet: 'Fund Wallet — Dedicated Virtual Bank Accounts | Olaslog'
    };
    if (viewTitles[viewName]) {
        document.title = viewTitles[viewName];
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });

    // Load view data
    if (viewName === 'shop') {
        loadCatalog();
    } else if (viewName === 'dashboard') {
        loadDashboard();
    } else if (viewName === 'orders') {
        loadOrders();
    } else if (viewName === 'wallet') {
        loadWallet();
    }
}

// ============================================================================
// Catalog & Shop
// ============================================================================

async function loadCatalog(categorySlug = null, search = null) {
    try {
        let url = '/api/products';
        const params = [];
        if (categorySlug && categorySlug !== 'all') params.push(`category=${encodeURIComponent(categorySlug)}`);
        if (search) params.push(`search=${encodeURIComponent(search)}`);
        if (params.length) url += `?${params.join('&')}`;

        const [prodRes, catRes] = await Promise.all([
            fetch(url),
            fetch('/api/products/categories')
        ]);

        const prodData = await prodRes.json();
        const catData = await catRes.json();

        if (prodData.success) {
            state.catalog = prodData.products;
            renderProductGrid(state.catalog);
            renderFeaturedGrid(state.catalog.slice(0, 3));
            const statProd = document.getElementById('homeStatLiveProducts');
            if (statProd) statProd.textContent = `${state.catalog.length}+`;
        }

        if (catData.success) {
            state.categories = catData.categories;
            renderCategoryTabs(state.categories);
            const statCat = document.getElementById('homeStatLiveCategories');
            if (statCat) statCat.textContent = state.categories.length;
        }
    } catch (err) {
        console.error('Failed to load catalog:', err);
    }
}

function renderCategoryTabs(categories) {
    const container = document.getElementById('categoryTabsContainer');
    if (!container) return;

    // Ensure Texting App category is always pinned first, followed by most sold categories
    const sortedCategories = [...categories].sort((a, b) => {
        const aIsTexting = /texting/i.test(a.name) || /texting/i.test(a.slug);
        const bIsTexting = /texting/i.test(b.name) || /texting/i.test(b.slug);
        if (aIsTexting !== bIsTexting) return aIsTexting ? -1 : 1;
        if ((b.total_sold || 0) !== (a.total_sold || 0)) {
            return (b.total_sold || 0) - (a.total_sold || 0);
        }
        return 0;
    });

    let html = `<button class="category-tab active" onclick="filterCategory('all', this)">All Categories</button>`;
    for (const cat of sortedCategories) {
        html += `<button class="category-tab" onclick="filterCategory('${cat.slug}', this)">${cat.icon || '📦'} ${cat.name}</button>`;
    }
    container.innerHTML = html;
}

function filterCategory(slug, btn) {
    document.querySelectorAll('.category-tab').forEach(t => t.classList.remove('active'));
    if (btn) btn.classList.add('active');
    loadCatalog(slug, document.getElementById('shopSearchInput')?.value);
}

let searchDebounce = null;
function handleSearch(val) {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
        loadCatalog(null, val.trim());
    }, 300);
}

function renderProductGrid(products) {
    const grid = document.getElementById('shopProductsGrid');
    if (!grid) return;

    if (!products.length) {
        grid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; padding: 3rem; color: var(--text-muted);">No products found matching your search.</div>`;
        return;
    }

    // Group products by category
    const grouped = new Map();
    for (const p of products) {
        const catName = (p.category && p.category.name) || 'Other';
        const catIcon = (p.category && p.category.icon) || '📦';
        const catSlug = (p.category && p.category.slug) || '';
        const key = catName;
        if (!grouped.has(key)) grouped.set(key, { icon: catIcon, name: catName, slug: catSlug, items: [] });
        grouped.get(key).items.push(p);
    }

    // Sort category sections: Texting App always first, followed by most-sold
    const sortedGroups = Array.from(grouped.values()).sort((a, b) => {
        const aIsTexting = /texting/i.test(a.name) || /texting/i.test(a.slug);
        const bIsTexting = /texting/i.test(b.name) || /texting/i.test(b.slug);
        if (aIsTexting !== bIsTexting) return aIsTexting ? -1 : 1;
        return 0; // preserve incoming sales-ordered flow from backend
    });

    let html = '';
    for (const group of sortedGroups) {
        html += `
            <div style="grid-column: 1/-1; display: flex; align-items: center; gap: 10px; margin: 1.5rem 0 0.5rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--edge);">
                <span style="font-size: 1.3rem;">${group.icon}</span>
                <h2 style="font-size: 1rem; font-weight: 700; color: var(--text); text-transform: uppercase; letter-spacing: 0.06em; margin: 0;">${escapeHtml(group.name)}</h2>
                <span style="font-size: 0.75rem; color: var(--text-dim); background: var(--panel-2); border: 1px solid var(--edge); border-radius: 99px; padding: 2px 8px;">${group.items.length} item${group.items.length !== 1 ? 's' : ''}</span>
            </div>
            ${group.items.map(p => createProductCardHTML(p)).join('')}
        `;
    }
    grid.innerHTML = html;
}

function renderFeaturedGrid(products) {
    const grid = document.getElementById('homeFeaturedGrid');
    if (!grid) return;
    grid.innerHTML = products.map(p => createProductCardHTML(p)).join('');
}

function resolveProductBrandLogo(p) {
    if (p.imageUrl && !p.imageUrl.includes('clearbit.com') && !p.imageUrl.includes('unsplash.com')) {
        return p.imageUrl;
    }
    const n = (p.name || '').toUpperCase();
    const c = ((p.category && p.category.name) || '').toUpperCase();

    if (n.includes('TIKTOK') || n.includes('TIKTIOK') || c.includes('TIKTOK')) return '/assets/logos/tiktok.png';
    if (n.includes('INSTAGRAM') || c.includes('INSTAGRAM')) return '/assets/logos/instagram.png';
    if (n.includes('FACEBOOK') || n.includes('FB') || c.includes('FACEBOOK') || c.includes('FB')) return '/assets/logos/facebook.png';
    if (n.includes('DISCORD')) return '/assets/logos/discord.png';
    if (n.includes('ICLOUD') || n.includes('APPLE')) return '/assets/logos/apple.png';
    if (n.includes('GOOGLE VOICE') || c.includes('GOOGLE VOICE') || n.includes('GMAIL') || n.includes('GOOGLE')) return '/assets/logos/google.png';
    if (n.includes('TEXTPLUS')) return '/assets/logos/textplus.png';
    if (n.includes('NEXTPLUS') || n.includes('MICROSOFT')) return '/assets/logos/microsoft.png';
    if (n.includes('NORD VPN') || n.includes('NORDVPN')) return '/assets/logos/nordvpn.png';
    if (n.includes('EXPRESS VPN') || n.includes('EXPRESSVPN')) return '/assets/logos/expressvpn.png';
    if (n.includes('PROTON VPN') || n.includes('PROTONVPN')) return '/assets/logos/protonvpn.png';
    if (n.includes('AVAST')) return '/assets/logos/avast.png';
    if (n.includes('HMA')) return '/assets/logos/hma.png';
    if (n.includes('PIA VPN') || n.includes('IPVANISH') || n.includes('IP VANISH')) return '/assets/logos/pia.png';
    if (n.includes('TWITTER') || n.includes('CLONE X') || n.includes(' X ')) return '/assets/logos/x.png';
    if (n.includes('TELEGRAM')) return '/assets/logos/telegram.png';
    if (n.includes('WHATSAPP')) return '/assets/logos/whatsapp.png';
    if (n.includes('SNAPCHAT')) return '/assets/logos/snapchat.png';

    return '/assets/logos/google.png';
}

function createProductCardHTML(p) {
    // Use the pre-computed inStock from the API (reliable, handles auto-fulfilled products)
    const inStock = p.inStock === true || p.isAutoFulfilled === true;
    const stockLabel = p.isAutoFulfilled
        ? 'Available'
        : (inStock ? `${p.stockCount} in stock` : 'Sold out');
    const catName = (p.category && p.category.name) || 'Digital Goods';
    const words = p.name.trim().split(' ');
    const initials = (words[0][0] + (words[1] ? words[1][0] : '')).toUpperCase();
    const colors = [
        { top: 'linear-gradient(90deg, #49D8C4, #2A9D8F)', bg: 'rgba(73, 216, 196, 0.15)', text: '#49D8C4' },
        { top: 'linear-gradient(90deg, #D9A85B, #B9832E)', bg: 'rgba(217, 168, 91, 0.15)', text: '#D9A85B' },
        { top: 'linear-gradient(90deg, #818cf8, #6366f1)', bg: 'rgba(99, 102, 241, 0.15)', text: '#a5b4fc' },
        { top: 'linear-gradient(90deg, #f43f5e, #e11d48)', bg: 'rgba(244, 63, 94, 0.15)', text: '#fda4af' }
    ];
    const theme = colors[p.id % colors.length];

    // Build official brand logo with initials fallback
    const logoSrc = resolveProductBrandLogo(p);
    const logoIcon = `
        <img
            src="${logoSrc}"
            alt="${escapeHtml(p.name)} logo"
            width="28"
            height="28"
            loading="lazy"
            decoding="async"
            style="width: 28px; height: 28px; object-fit: contain; display: block;"
            onerror="this.style.display='none'; if(this.nextElementSibling) this.nextElementSibling.style.display='flex';"
        /><span style="display:none; width:100%; height:100%; align-items:center; justify-content:center; font-weight:700; font-size:14px;">${initials}</span>
    `;

    return `
        <div class="pcard">
            <div class="pcard-top" style="background: ${theme.top};"></div>
            <div class="pcard-body">
                <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
                    <div class="pcard-icon" style="background: ${theme.bg}; color: ${theme.text};">
                        ${logoIcon}
                    </div>
                    <span class="pill ${inStock ? 'pill-teal' : 'pill-danger'}" style="font-size: 11px;">
                        <span class="dot"></span>${stockLabel}
                    </span>
                </div>
                <div style="font-size: 11px; font-family: var(--mono); color: var(--teal); margin-bottom: 4px;">
                    ${escapeHtml(catName)}
                </div>
                <div class="pcard-name">${escapeHtml(p.name)}</div>
                <div class="pcard-desc">${escapeHtml(p.description || 'Instant automated credential delivery to your account.')}</div>
                <div class="pcard-price">₦${p.price.toLocaleString()}</div>
                <div class="pcard-actions">
                    <button class="btn btn-outline btn-sm" onclick="openAccountPreviewModal(${p.id})">🔍 Preview</button>
                    <button class="btn btn-outline btn-sm" onclick="openProductRulesModal(${p.id})">Rules</button>
                    <button class="btn btn-primary btn-sm" ${inStock ? '' : 'disabled style="opacity:0.5;cursor:not-allowed;"'} onclick="quickAddToCart(${p.id})">
                        ${inStock ? '+ Cart' : 'Sold Out'}
                    </button>
                </div>
            </div>
        </div>
    `;
}

// ============================================================================
// Product Details & Upfront Category Rules Modal (PRD 4.5 & 8.5)
// ============================================================================

async function openProductRulesModal(productId) {
    const product = state.catalog.find(p => p.id === productId);
    if (!product) return;

    document.getElementById('rulesModalProductTitle').textContent = product.name;
    document.getElementById('rulesModalProductDetails').innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
            <span style="color: var(--teal); font-weight: 700; text-transform: uppercase; font-size: 0.8rem;">Category: ${escapeCredential(product.category?.name || 'Digital Product')}</span>
            <span style="font-size: 1.25rem; font-weight: 800; color: var(--gold);">₦${product.price.toLocaleString()}</span>
        </div>
        <p style="font-size: 0.9rem; color: var(--text-dim);">${escapeCredential(product.description || '')}</p>
    `;

    const contentEl = document.getElementById('rulesModalMarkdownContent');
    contentEl.innerHTML = `
        <div style="text-align: center; padding: 2rem; color: var(--text-dim);">
            <div style="font-size: 1.8rem; margin-bottom: 0.5rem;">⏳</div>
            <div>Retrieving product usage guidelines...</div>
        </div>
    `;

    const addBtn = document.getElementById('rulesModalAddToCartBtn');
    const productAvailable = product.isAutoFulfilled || product.inStock || product.stockCount > 0;
    addBtn.disabled = !productAvailable;
    addBtn.textContent = productAvailable ? 'Accept Rules & Add to Cart 🛒' : 'Out of Stock';
    addBtn.onclick = () => {
        const qty = parseInt(document.getElementById('rulesModalQtyInput').value || '1', 10);
        addToCart(product, qty);
        closeModal('productRulesModal');
        toggleCartDrawer(true);
    };

    openModal('productRulesModal');

    try {
        const res = await fetch(`/api/products/${productId}/rules`);
        const data = await res.json();
        const rawMarkdown = (data.success && data.rules?.rulesGuide) 
            ? data.rules.rulesGuide 
            : (product.category?.rulesGuide || `### ⚠️ Important Usage Rules\n- Inspect credentials immediately upon delivery.\n- Use recommended residential US proxies.\n- No time-bound warranty applies after successful delivery.`);

        const formattedHtml = rawMarkdown
            .replace(/### (.*)/g, '<h3 style="margin-bottom: 8px; color: var(--gold);">$1</h3>')
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/- (.*)/g, '<li style="margin-bottom: 6px;">$1</li>');

        contentEl.innerHTML = `<ul style="padding-left: 20px; line-height: 1.6;">${formattedHtml}</ul>`;
    } catch (_) {
        const rawMarkdown = product.category?.rulesGuide || `### ⚠️ Important Usage Rules\n- Inspect credentials immediately upon delivery.\n- Use recommended residential US proxies.\n- No time-bound warranty applies after successful delivery.`;
        const formattedHtml = rawMarkdown
            .replace(/### (.*)/g, '<h3 style="margin-bottom: 8px; color: var(--gold);">$1</h3>')
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/- (.*)/g, '<li style="margin-bottom: 6px;">$1</li>');
        contentEl.innerHTML = `<ul style="padding-left: 20px; line-height: 1.6;">${formattedHtml}</ul>`;
    }
}

// ============================================================================
// Stock Live Preview & Account Selection Modal
// ============================================================================

let currentPreviewStock = null;
let selectedAccountIds = new Set();

// Helper: show/hide the two modal modes
function setPreviewMode(mode) {
    // mode = 'instant' | 'selection' | 'loading' | 'error'
    const footerInstant   = document.getElementById('previewFooterInstant');
    const footerSelection = document.getElementById('previewFooterSelection');
    const summaryEl       = document.getElementById('previewSelectionSummary');

    footerInstant.style.display   = mode === 'instant'   ? 'flex' : 'none';
    footerSelection.style.display = mode === 'selection' ? 'flex' : 'none';
    summaryEl.style.display       = mode === 'selection' ? 'flex' : 'none';
}

async function openAccountPreviewModal(productId) {
    const product = state.catalog.find(p => p.id === productId);
    if (!product) return;

    // Store productId globally for the instant-footer buttons
    window._previewProductId = productId;

    document.getElementById('previewModalProductTitle').textContent = `🔍 ${product.name}`;
    document.getElementById('previewModalSubtitle').textContent = 'Checking live stock — please wait…';
    document.getElementById('previewModalUnitPrice').textContent = product.price.toLocaleString();
    document.getElementById('previewModalStockBadge').textContent = 'Loading…';

    const listContainer = document.getElementById('accountPreviewOptionsList');
    listContainer.innerHTML = `
        <div style="text-align: center; padding: 2.5rem; color: var(--text-dim);">
            <div style="font-size: 2rem; margin-bottom: 0.5rem;">⏳</div>
            <div>Checking real-time inventory…</div>
        </div>
    `;

    // Hide all footers while loading
    setPreviewMode('loading');
    openModal('accountPreviewModal');
    selectedAccountIds.clear();
    updatePreviewSelectionSummary(product.price);

    try {
        const res = await fetch(`/api/products/${productId}/stock`);
        const data = await res.json();

        if (!data.success || !data.stock) {
            listContainer.innerHTML = `<div style="text-align: center; padding: 2rem; color: var(--danger);">⚠️ Could not retrieve stock information. Please try again.</div>`;
            setPreviewMode('instant'); // still let them add to cart
            document.getElementById('previewModalStockBadge').textContent = 'In Stock';
            return;
        }

        currentPreviewStock = data.stock;
        currentPreviewStock.unitPrice = product.price;

        const { availableStock: stockNum, isAutoFulfilled } = currentPreviewStock;
        const stockDisplay = isAutoFulfilled
            ? '⚡ Available — Instant Delivery'
            : (stockNum !== null && stockNum !== undefined ? `⚡ ${stockNum} in stock` : '⚡ In Stock');
        document.getElementById('previewModalStockBadge').textContent = stockDisplay;

        const options = currentPreviewStock.options || [];

        if (!options.length) {
            // ── INSTANT DISPATCH MODE (auto-fulfilled, no individual accounts listed) ──
            document.getElementById('previewModalSubtitle').textContent = 'Instant automated delivery upon payment';
            listContainer.innerHTML = `
                <div style="padding: 1.25rem; background: var(--panel-2); border: 1px solid var(--edge); border-radius: 12px; margin-bottom: 0.5rem;">
                    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px; gap: 10px;">
                        <div>
                            <span class="pill pill-teal" style="font-size: 11px; margin-bottom: 6px;"><span class="dot"></span>Instant Automated Delivery</span>
                            <div style="font-weight: 700; font-size: 1.05rem; color: var(--text); margin-top: 6px;">${escapeHtml(product.name)}</div>
                            <div style="font-size: 12px; color: var(--teal); font-family: var(--mono); margin-top: 2px;">${escapeHtml(product.category?.name || 'Digital Goods')}</div>
                        </div>
                        <div style="font-size: 1.3rem; font-weight: 800; color: var(--gold); white-space: nowrap;">
                            ₦${product.price.toLocaleString()}
                        </div>
                    </div>
                    <p style="font-size: 0.88rem; color: var(--text-dim); line-height: 1.5; margin-bottom: 14px;">
                        ${escapeHtml(product.description || 'Verified credentials automatically dispatched upon successful order.')}
                    </p>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 11.5px; padding: 12px; background: rgba(0,0,0,0.15); border-radius: 9px; border: 1px solid var(--edge);">
                        <div><strong style="color: var(--text);">⚡ Fulfillment:</strong> Instant Auto Release</div>
                        <div><strong style="color: var(--text);">📦 Quantity:</strong> ${isAutoFulfilled ? 'Available' : (stockNum ?? '—')}</div>
                        <div><strong style="color: var(--text);">🛡️ Warranty:</strong> Replacement &amp; Support</div>
                        <div><strong style="color: var(--text);">📋 Delivery:</strong> Orders tab &amp; screen</div>
                    </div>
                </div>
                <div style="padding: 0.6rem 0.25rem; display: flex; justify-content: flex-end;">
                    <button class="btn btn-outline btn-sm" onclick="closeModal('accountPreviewModal'); openProductRulesModal(${product.id});">📋 View Usage Rules</button>
                </div>
            `;
            setPreviewMode('instant');
            return;
        }

        // ── SELECTION MODE (provider returned individual selectable accounts) ──
        document.getElementById('previewModalSubtitle').textContent = `${options.length} account(s) available — select before purchasing`;

        listContainer.innerHTML = `<div class="account-preview-list">${options.map(opt => {
            const preview = opt.preview || {};
            const optTitle = opt.publicData || 'Verified Account';
            return `
                <div class="account-preview-card" id="preview-card-${opt.id}" onclick="toggleAccountSelection(${opt.id})">
                    <div style="display: flex; align-items: center; gap: 0.85rem;">
                        <input type="checkbox" class="account-checkbox" id="chk-account-${opt.id}" onclick="event.stopPropagation(); toggleAccountSelection(${opt.id})" />
                        <div>
                            <div style="font-weight: 700; font-size: 0.92rem; color: var(--text); margin-bottom: 0.25rem;">
                                ${escapeHtml(optTitle)}
                            </div>
                            <div style="display: flex; gap: 0.4rem; align-items: center; flex-wrap: wrap;">
                                ${preview.location ? `<span class="preview-badge preview-badge-loc">📍 ${escapeCredential(preview.location)}</span>` : ''}
                                ${preview.year ? `<span class="preview-badge preview-badge-year">📅 Year: ${escapeCredential(preview.year)}</span>` : ''}
                                ${preview.profileUrl ? `<a href="${escapeCredential(preview.profileUrl)}" target="_blank" onclick="event.stopPropagation()" class="preview-link-btn">🔗 Profile Link</a>` : ''}
                            </div>
                        </div>
                    </div>
                    <div style="text-align: right;">
                        <span style="font-size: 0.85rem; color: var(--teal); font-weight: 700;">₦${product.price.toLocaleString()}</span>
                    </div>
                </div>
            `;
        }).join('')}</div>`;

        setPreviewMode('selection');

    } catch (err) {
        listContainer.innerHTML = `<div style="text-align: center; padding: 2rem; color: var(--danger);">⚠️ Network error. Please check your connection and try again.</div>`;
        setPreviewMode('instant');
        document.getElementById('previewModalStockBadge').textContent = 'In Stock';
    }
}

function toggleAccountSelection(accountId) {
    const card = document.getElementById(`preview-card-${accountId}`);
    const chk = document.getElementById(`chk-account-${accountId}`);
    
    if (selectedAccountIds.has(accountId)) {
        selectedAccountIds.delete(accountId);
        if (card) card.classList.remove('selected');
        if (chk) chk.checked = false;
    } else {
        selectedAccountIds.add(accountId);
        if (card) card.classList.add('selected');
        if (chk) chk.checked = true;
    }

    const price = currentPreviewStock ? currentPreviewStock.unitPrice : 0;
    updatePreviewSelectionSummary(price);
}

function toggleSelectAllAccounts() {
    if (!currentPreviewStock || !currentPreviewStock.options) return;
    const allIds = currentPreviewStock.options.map(o => o.id);
    const selectAllBtn = document.getElementById('selectAllAccountsBtn');

    if (selectedAccountIds.size === allIds.length) {
        selectedAccountIds.clear();
        allIds.forEach(id => {
            const card = document.getElementById(`preview-card-${id}`);
            const chk = document.getElementById(`chk-account-${id}`);
            if (card) card.classList.remove('selected');
            if (chk) chk.checked = false;
        });
        if (selectAllBtn) selectAllBtn.textContent = 'Select All';
    } else {
        allIds.forEach(id => {
            selectedAccountIds.add(id);
            const card = document.getElementById(`preview-card-${id}`);
            const chk = document.getElementById(`chk-account-${id}`);
            if (card) card.classList.add('selected');
            if (chk) chk.checked = true;
        });
        if (selectAllBtn) selectAllBtn.textContent = 'Deselect All';
    }

    updatePreviewSelectionSummary(currentPreviewStock.unitPrice);
}

function updatePreviewSelectionSummary(unitPrice) {
    const count = selectedAccountIds.size;
    const total = count * unitPrice;
    document.getElementById('previewSelectedCount').textContent = count;
    document.getElementById('previewSelectedTotal').textContent = total.toLocaleString();
}

function confirmPreviewAddToCart() {
    if (!currentPreviewStock) return;
    const product = state.catalog.find(p => p.id === currentPreviewStock.productId);
    if (!product) return;

    const ids = Array.from(selectedAccountIds);
    if (ids.length === 0) {
        showToast('Please select at least one account to add to cart', 'info');
        return;
    }

    addToCart(product, ids.length, ids);
    closeModal('accountPreviewModal');
    toggleCartDrawer(true);
}

async function confirmPreviewBuyNow() {
    if (!state.currentUser) {
        showToast('Please sign in to complete your instant purchase', 'info');
        closeModal('accountPreviewModal');
        openAuthModal('login');
        return;
    }

    confirmPreviewAddToCart();
    await executeCheckout();
}

// ============================================================================
// Cart Management & Atomic Checkout
// ============================================================================

function quickAddToCart(productId) {
    const product = state.catalog.find(p => p.id === productId);
    if (product) {
        addToCart(product, 1);
        toggleCartDrawer(true);
    }
}

function addToCart(product, qty = 1, inventoryItemIds = null) {
    // Auto-fulfilled products (stockCount=-1) are always in stock
    const isAvailable = product.isAutoFulfilled || product.inStock || product.stockCount > 0;
    if (!isAvailable) {
        showToast('This item is currently out of stock', 'error');
        return;
    }

    if (inventoryItemIds && inventoryItemIds.length > 0) {
        // Add specific accounts
        state.cart.push({
            product,
            quantity: inventoryItemIds.length,
            inventoryItemIds: [...inventoryItemIds]
        });
    } else {
        const existingIndex = state.cart.findIndex(item => item.product.id === product.id && !item.inventoryItemIds);
        if (existingIndex > -1) {
            const newQty = state.cart[existingIndex].quantity + qty;
            // Only cap quantity for products with a real finite stock count
            if (!product.isAutoFulfilled && product.stockCount > 0 && newQty > product.stockCount) {
                showToast(`Cannot add more than ${product.stockCount} available units`, 'error');
                return;
            }
            state.cart[existingIndex].quantity = newQty;
        } else {
            state.cart.push({ product, quantity: qty });
        }
    }

    saveCart();
    updateCartUI();
    showToast(`Added "${product.name}" to cart!`, 'success');
}

function updateCartItemQty(productId, delta) {
    const index = state.cart.findIndex(i => i.product.id === productId);
    if (index === -1) return;

    const item = state.cart[index];
    const newQty = item.quantity + delta;

    if (newQty <= 0) {
        state.cart.splice(index, 1);
    } else if (!item.product.isAutoFulfilled && item.product.stockCount > 0 && newQty > item.product.stockCount) {
        showToast(`Only ${item.product.stockCount} units available in stock`, 'error');
        return;
    } else {
        item.quantity = newQty;
    }

    saveCart();
    updateCartUI();
}

function saveCart() {
    localStorage.setItem('olaslog_cart', JSON.stringify(state.cart));
}

function updateCartUI() {
    const count = state.cart.reduce((sum, item) => sum + item.quantity, 0);
    document.getElementById('cartCountBadge').textContent = count;

    const container = document.getElementById('cartItemsContainer');
    if (!container) return;

    if (state.cart.length === 0) {
        container.innerHTML = `
            <div style="text-align: center; padding: 3rem 1rem; color: var(--text-muted);">
                <div style="font-size: 3rem; margin-bottom: 0.5rem;">🛒</div>
                <p>Your shopping cart is empty.</p>
                <button class="btn btn-secondary btn-sm" style="margin-top: 1rem;" onclick="toggleCartDrawer(false); navigateTo('shop');">
                    Browse Digital Goods
                </button>
            </div>
        `;
        document.getElementById('cartDrawerTotal').textContent = '₦0.00';
        document.getElementById('cartShortfallBox').style.display = 'none';
        document.getElementById('checkoutBtn').disabled = true;
        return;
    }

    let total = 0;
    let html = '';

    for (let idx = 0; idx < state.cart.length; idx++) {
        const item = state.cart[idx];
        const lineTotal = item.product.price * item.quantity;
        total += lineTotal;

        const hasSpecificAccounts = Array.isArray(item.inventoryItemIds) && item.inventoryItemIds.length > 0;

        html += `
            <div class="cart-item">
                <div class="cart-item-info">
                    <div class="cart-item-title">${item.product.name}</div>
                    ${hasSpecificAccounts ? `<div style="font-size:0.75rem; color:#818cf8; margin: 0.15rem 0;">Selected Accounts: #${item.inventoryItemIds.join(', #')}</div>` : ''}
                    <div class="cart-item-price">₦${item.product.price.toLocaleString()} × ${item.quantity} = <strong>₦${lineTotal.toLocaleString()}</strong></div>
                </div>
                <div class="qty-control">
                    ${hasSpecificAccounts ? `
                        <button class="btn btn-secondary btn-sm" onclick="removeCartItem(${idx})" style="padding:0.25rem 0.6rem; font-size:0.75rem;">✕ Remove</button>
                    ` : `
                        <button class="qty-btn" onclick="updateCartItemQty(${item.product.id}, -1)">-</button>
                        <span class="qty-display">${item.quantity}</span>
                        <button class="qty-btn" onclick="updateCartItemQty(${item.product.id}, 1)">+</button>
                    `}
                </div>
            </div>
        `;
    }

    container.innerHTML = html;
    document.getElementById('cartDrawerTotal').textContent = `₦${total.toLocaleString()}`;

    // Balance check
    const userBalance = state.currentUser ? (state.currentUser.balance || 0) : 0;
    document.getElementById('cartDrawerWalletBalance').textContent = `₦${userBalance.toLocaleString()}`;

    const shortfallBox = document.getElementById('cartShortfallBox');
    const checkoutBtn = document.getElementById('checkoutBtn');

    if (state.currentUser && userBalance < total) {
        const shortfall = total - userBalance;
        document.getElementById('cartShortfallAmount').textContent = `₦${shortfall.toLocaleString()}`;
        shortfallBox.style.display = 'block';
        checkoutBtn.disabled = true;
        checkoutBtn.textContent = '⚠️ Insufficient Wallet Balance';
    } else {
        shortfallBox.style.display = 'none';
        checkoutBtn.disabled = false;
        checkoutBtn.textContent = '⚡ Complete Instant Purchase';
    }
}

function removeCartItem(index) {
    if (index >= 0 && index < state.cart.length) {
        state.cart.splice(index, 1);
        saveCart();
        updateCartUI();
    }
}

function toggleCartDrawer(forceOpen = null) {
    const drawer = document.getElementById('cartDrawer');
    const overlay = document.getElementById('cartOverlay');
    const isOpen = forceOpen !== null ? forceOpen : !drawer.classList.contains('open');

    if (isOpen) {
        updateCartUI();
        drawer.classList.add('open');
        overlay.classList.add('open');
    } else {
        drawer.classList.remove('open');
        overlay.classList.remove('open');
    }
}

function redirectToFundShortfall() {
    toggleCartDrawer(false);
    navigateTo('wallet');
}

async function executeCheckout() {
    if (!state.currentUser) {
        showToast('Please sign in to proceed with checkout', 'info');
        toggleCartDrawer(false);
        openAuthModal('login');
        return;
    }

    if (!state.cart.length) {
        showToast('Your cart is empty', 'error');
        return;
    }

    const checkoutBtn = document.getElementById('checkoutBtn');
    checkoutBtn.disabled = true;
    checkoutBtn.textContent = 'Reserving Stock & Debiting Wallet...';

    try {
        const payload = {
            items: state.cart.map(i => ({
                productId: i.product.id,
                quantity: i.quantity,
                inventoryItemIds: i.inventoryItemIds || undefined
            }))
        };

        const res = await fetch('/api/checkout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json();

        if (res.status === 402 || data.code === 'INSUFFICIENT_FUNDS') {
            showToast(data.error || 'Insufficient wallet balance', 'error');
            updateCartUI();
            return;
        }

        if (data.success && data.data) {
            // Success! Clear cart
            state.cart = [];
            saveCart();
            updateCartUI();
            toggleCartDrawer(false);

            // Update user balance
            state.currentUser.balance = data.data.remainingBalance;
            updateAuthUI();

            // Open Instant Delivery Modal!
            openDeliveryModal(data.data);
            showToast('Purchase successful! Credentials delivered instantly.', 'success');

            // Refresh catalog stock
            loadCatalog();
        } else {
            showToast(data.error || 'Checkout failed', 'error');
            checkoutBtn.disabled = false;
            checkoutBtn.textContent = '⚡ Complete Instant Purchase';
        }
    } catch (err) {
        showToast('Checkout transaction failed', 'error');
        checkoutBtn.disabled = false;
        checkoutBtn.textContent = '⚡ Complete Instant Purchase';
    }
}

function openDeliveryModal(orderData) {
    document.getElementById('deliveryOrderNumber').textContent = orderData.orderNumber;
    const list = document.getElementById('deliveredCredentialsList');

    list.innerHTML = orderData.deliveredCredentials.map((cred, idx) => `
        <div class="ticket">
            <div class="ticket-row">
                <span class="ticket-label">Item #${idx + 1}</span>
                <span class="ticket-value" style="color: var(--gold); font-family: var(--display);">${cred.productName}</span>
            </div>
            <div class="ticket-row">
                <span class="ticket-label">Fulfillment Channel</span>
                <span class="ticket-value" style="color: var(--teal);">⚡ Instant Stock Delivery</span>
            </div>
            <div class="ticket-perf"></div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                <span class="ticket-label">Decrypted Credentials</span>
                <button class="btn btn-secondary btn-sm" onclick="copyToClipboard('${escapeCredential(cred.credentialText)}')">📋 Copy</button>
            </div>
            <div class="credential-line">
                <span>${escapeHtml(cred.credentialText)}</span>
            </div>
            <div class="ticket-perf"></div>
            <div class="ticket-id">ORDER: ${orderData.orderNumber} • AES-256-GCM DECRYPTED</div>
        </div>
    `).join('');

    openModal('deliveryModal');
}

// ============================================================================
// Dashboard & Order History
// ============================================================================

async function loadDashboard() {
    try {
        const [ordersRes, txRes] = await Promise.all([
            fetch('/api/orders'),
            fetch('/api/wallet/transactions?limit=5')
        ]);

        const ordersData = await ordersRes.json();
        const txData = await txRes.json();

        if (ordersData.success) {
            document.getElementById('dashTotalOrdersCount').textContent = ordersData.orders.length;
            const activeDisputes = ordersData.orders.filter(o => o.dispute_status && o.dispute_status !== 'rejected').length;
            document.getElementById('dashActiveDisputesCount').textContent = activeDisputes;

            const recentOrders = ordersData.orders.slice(0, 5);
            const tbody = document.getElementById('dashRecentOrdersTable');
            if (recentOrders.length) {
                tbody.innerHTML = recentOrders.map(o => `
                    <tr>
                        <td style="font-family: var(--font-mono); font-weight: 700;">${o.order_number}</td>
                        <td>${new Date(o.created_at).toLocaleDateString()}</td>
                        <td>${o.item_count} items</td>
                        <td style="font-weight: 700; color: var(--accent-emerald);">₦${o.total_amount.toLocaleString()}</td>
                        <td><span class="badge badge-success">${o.status}</span></td>
                        <td><button class="btn btn-secondary btn-sm" onclick="viewOrderCredentials(${o.id})">View Creds</button></td>
                    </tr>
                `).join('');
            } else {
                tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No purchases made yet.</td></tr>`;
            }
        }
    } catch (err) {
        console.error('Failed to load dashboard data:', err);
    }
}

async function loadOrders() {
    try {
        const res = await fetch('/api/orders');
        const data = await res.json();
        const tbody = document.getElementById('fullOrdersTableBody');
        if (!tbody) return;

        if (!data.success || !data.orders.length) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 2rem; color: var(--text-muted);">No orders found.</td></tr>`;
            return;
        }

        tbody.innerHTML = data.orders.map(o => {
            let disputeBadge = `<span style="color: var(--text-muted); font-size: 0.8rem;">None</span>`;
            if (o.dispute_status === 'submitted') disputeBadge = `<span class="badge badge-warning">Submitted</span>`;
            else if (o.dispute_status === 'under_review') disputeBadge = `<span class="badge badge-info">Under Review</span>`;
            else if (o.dispute_status === 'approved_refunded') disputeBadge = `<span class="badge badge-success">Refunded</span>`;
            else if (o.dispute_status === 'rejected') disputeBadge = `<span class="badge badge-danger">Rejected</span>`;

            const canDispute = !o.dispute_status && o.status === 'completed';

            return `
                <tr>
                    <td style="font-family: var(--font-mono); font-weight: 700;">${o.order_number}</td>
                    <td>${new Date(o.created_at).toLocaleString()}</td>
                    <td>${o.item_count} item(s)</td>
                    <td style="font-weight: 800; color: var(--accent-emerald);">₦${o.total_amount.toLocaleString()}</td>
                    <td><span class="badge badge-success">${o.status}</span></td>
                    <td>${disputeBadge}</td>
                    <td style="display: flex; gap: 0.4rem;">
                        <button class="btn btn-secondary btn-sm" onclick="viewOrderCredentials(${o.id})">🔐 Credentials</button>
                        ${canDispute ? `<button class="btn btn-danger btn-sm" onclick="openDisputeModal(${o.id}, '${o.order_number}')">⚠️ Report Issue</button>` : ''}
                    </td>
                </tr>
            `;
        }).join('');
    } catch (err) {
        console.error('Failed to load orders:', err);
    }
}

async function viewOrderCredentials(orderId) {
    try {
        const res = await fetch(`/api/orders/${orderId}`);
        const data = await res.json();
        if (data.success && data.order) {
            const container = document.getElementById('pastCredentialsContainer');
            container.innerHTML = `
                <div style="margin-bottom: 1.25rem;">
                    <strong>Order Number:</strong> <span style="font-family: var(--font-mono);">${data.order.order_number}</span><br>
                    <strong>Delivered On:</strong> ${new Date(data.order.created_at).toLocaleString()}<br>
                    <strong>Total Paid:</strong> ₦${data.order.total_amount.toLocaleString()}
                </div>
                ${data.order.credentials.map((c, i) => `
                    <div class="ticket">
                        <div class="ticket-row">
                            <span class="ticket-label">Item #${i + 1}</span>
                            <span class="ticket-value" style="color: var(--gold); font-family: var(--display);">${c.productName}</span>
                        </div>
                        <div class="ticket-row">
                            <span class="ticket-label">Status</span>
                            <span class="ticket-value" style="color: var(--teal);">Delivered from Stock</span>
                        </div>
                        <div class="ticket-perf"></div>
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                            <span class="ticket-label">Credential Payload</span>
                            <button class="btn btn-secondary btn-sm" onclick="copyToClipboard('${escapeCredential(c.credentialText)}')">📋 Copy</button>
                        </div>
                        <div class="credential-line">
                            <span>${escapeHtml(c.credentialText)}</span>
                        </div>
                        <div class="ticket-perf"></div>
                        <div class="ticket-id">TXN: ${data.order.order_number} • ORDER VERIFIED & SECURED</div>
                    </div>
                `).join('')}
            `;
            openModal('pastCredentialsModal');
        }
    } catch (err) {
        showToast('Failed to retrieve order credentials', 'error');
    }
}

// ============================================================================
// Dispute Reporting
// ============================================================================

function openDisputeModal(orderId, orderNumber) {
    state.activeDisputeOrderId = orderId;
    document.getElementById('disputeOrderNumber').textContent = orderNumber;
    document.getElementById('disputeReasonInput').value = '';
    document.getElementById('disputeProofInput').value = '';
    openModal('disputeModal');
}

async function submitDispute() {
    const reason = document.getElementById('disputeReasonInput').value.trim();
    if (reason.length < 10) {
        showToast('Please provide a detailed description (at least 10 characters)', 'error');
        return;
    }

    const formData = new FormData();
    formData.append('reason', reason);

    const fileInput = document.getElementById('disputeProofInput');
    if (fileInput.files[0]) {
        formData.append('proofImage', fileInput.files[0]);
    }

    try {
        const res = await fetch(`/api/orders/${state.activeDisputeOrderId}/dispute`, {
            method: 'POST',
            body: formData
        });
        const data = await res.json();
        if (data.success) {
            showToast('Dispute report submitted! The admin team will review it.', 'success');
            closeModal('disputeModal');
            loadOrders();
        } else {
            showToast(data.error || 'Failed to submit dispute', 'error');
        }
    } catch (err) {
        showToast('Error submitting dispute', 'error');
    }
}

// ============================================================================
// Wallet & Dedicated Virtual Bank Account Funding
// ============================================================================

function openFundModalShortcut() {
    if (!state.currentUser) {
        showToast('Please sign in to access your wallet', 'info');
        openAuthModal('login');
        return;
    }
    navigateTo('wallet');
}

async function loadWallet() {
    await checkAuth();
    if (!state.currentUser) return;

    // 1. Fetch & Render Dedicated Virtual Bank Account
    await loadVirtualAccount();

    // 2. Fetch & Render Ledger Transactions
    try {
        const res = await fetch('/api/wallet/transactions');
        const data = await res.json();
        const tbody = document.getElementById('walletTransactionsTableBody');
        if (tbody) {
            if (!data.success || !data.transactions.length) {
                tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 2rem;">No wallet transactions yet.</td></tr>`;
            } else {
                tbody.innerHTML = data.transactions.map(t => {
                    const isCredit = t.type === 'funding' || t.type === 'refund';
                    const amountColor = isCredit ? 'var(--accent-emerald)' : 'var(--accent-rose)';
                    const prefix = isCredit ? '+' : '-';
                    const statusBadge = t.status === 'successful' ? 'badge-success' : (t.status === 'pending' ? 'badge-warning' : 'badge-danger');

                    return `
                        <tr>
                            <td>${new Date(t.createdAt).toLocaleString()}</td>
                            <td style="font-weight: 700; text-transform: uppercase; font-size: 0.8rem;">${t.type}</td>
                            <td style="font-weight: 800; color: ${amountColor};">${prefix}₦${t.amount.toLocaleString()}</td>
                            <td>₦${t.balanceBefore.toLocaleString()}</td>
                            <td>₦${t.balanceAfter.toLocaleString()}</td>
                            <td style="font-family: var(--font-mono); font-size: 0.82rem;">${t.reference}</td>
                            <td><span class="badge ${statusBadge}">${t.status}</span></td>
                            <td style="text-transform: capitalize;">${t.paymentChannel}</td>
                        </tr>
                    `;
                }).join('');
            }
        }
    } catch (err) {
        console.error('Failed to load wallet transactions:', err);
    }

    // 3. Sync balance
    try {
        const balRes = await fetch('/api/wallet/balance');
        const balData = await balRes.json();
        if (balData.success) {
            const balFormatted = (balData.balance || 0).toLocaleString('en-NG', { minimumFractionDigits: 2 });
            const pBal = document.getElementById('walletPageBalance');
            if (pBal) pBal.textContent = balFormatted;
            const nBal = document.getElementById('navWalletBalance');
            if (nBal) nBal.textContent = balFormatted;
            const mBal = document.getElementById('mobUserBalance');
            if (mBal) mBal.textContent = balFormatted;
        }
    } catch (_) {}
}

async function loadVirtualAccount() {
    const container = document.getElementById('vbaContainer');
    if (!container) return;

    // Check for incoming payment return
    await checkUrlPaymentVerification();

    // Render Standard Checkout form (Cards, Bank Transfer, USSD - no CAC/BVN needed)
    renderKorapayFundingForm();
}

async function checkUrlPaymentVerification() {
    const urlParams = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(window.location.hash.split('?')[1] || '');
    const reference = urlParams.get('reference') || hashParams.get('reference') || urlParams.get('trxref') || hashParams.get('trxref');

    if (reference) {
        showToast('Verifying your payment...', 'info');
        try {
            const res = await fetch(`/api/wallet/verify/${encodeURIComponent(reference)}`);
            const data = await res.json();
            if (data.success && data.status === 'successful') {
                showToast('🎉 Payment verified! Your wallet has been credited.', 'success');
            } else if (data.status === 'pending') {
                showToast('Payment is processing. Your balance will update shortly.', 'info');
            }
        } catch (e) {
            console.warn('Verify error:', e);
        }
        // Clean URL parameter and keep user on /wallet
        if (window.history.replaceState) {
            window.history.replaceState(null, '', '/wallet');
        }
    }
}

function setFundingAmount(amt) {
    const input = document.getElementById('fundAmountInput');
    if (input) {
        input.value = amt;
        input.focus();
    }
}

function renderKorapayFundingForm() {
    const container = document.getElementById('vbaContainer');
    if (!container) return;

    container.innerHTML = `
        <div id="korapayFundingSection">
            <div style="display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1.25rem;">
                <div style="width: 44px; height: 44px; border-radius: 12px; background: var(--teal-soft); color: var(--teal); display: flex; align-items: center; justify-content: center; font-size: 1.3rem;">
                    💳
                </div>
                <div>
                    <h3 style="font-size: 1.25rem; font-weight: 800; margin: 0; color: var(--text);">Fund Your Wallet</h3>
                    <p style="font-size: 0.82rem; color: var(--text-dim); margin: 0;">Instant Bank Transfer, Debit Card & USSD</p>
                </div>
            </div>

            <!-- Payment Channels Banner -->
            <div style="background: rgba(91, 217, 165, 0.08); border: 1px solid rgba(91, 217, 165, 0.25); border-radius: var(--radius-md); padding: 0.9rem 1.1rem; margin-bottom: 1.25rem;">
                <div style="font-size: 0.85rem; font-weight: 700; color: var(--teal); margin-bottom: 0.35rem; display: flex; align-items: center; gap: 0.4rem;">
                    ⚡ Instant Automated Credit
                </div>
                <div style="font-size: 0.82rem; color: var(--text-dim); line-height: 1.5;">
                    Pay using <strong>Bank Transfer</strong> (instant temporary account) or any <strong>Mastercard / Visa / Verve</strong> card. Your wallet is updated automatically upon confirmation.
                </div>
            </div>

            <!-- Quick Preset Buttons -->
            <div style="margin-bottom: 1rem;">
                <label class="form-label" style="font-weight: 700; font-size: 0.85rem; margin-bottom: 0.5rem; display: block;">Quick Select Amount</label>
                <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem;">
                    <button type="button" class="btn btn-outline btn-sm" onclick="setFundingAmount(500)">₦500</button>
                    <button type="button" class="btn btn-outline btn-sm" onclick="setFundingAmount(1000)">₦1,000</button>
                    <button type="button" class="btn btn-outline btn-sm" onclick="setFundingAmount(2500)">₦2,500</button>
                    <button type="button" class="btn btn-outline btn-sm" onclick="setFundingAmount(5000)">₦5,000</button>
                    <button type="button" class="btn btn-outline btn-sm" onclick="setFundingAmount(10000)">₦10,000</button>
                    <button type="button" class="btn btn-outline btn-sm" onclick="setFundingAmount(20000)">₦20,000</button>
                </div>
            </div>

            <form id="korapayFundingForm" onsubmit="handleKorapayCheckout(event)">
                <div class="form-group" style="margin-bottom: 1.25rem;">
                    <label class="form-label" style="font-weight: 700; font-size: 0.85rem;">
                        Amount to Deposit (₦) <span style="color: var(--danger);">*</span>
                    </label>
                    <div style="position: relative;">
                        <span style="position: absolute; left: 14px; top: 50%; transform: translateY(-50%); font-weight: 700; color: var(--teal); font-size: 1.1rem;">₦</span>
                        <input type="number" id="fundAmountInput" class="form-control" min="100" step="100" placeholder="e.g. 2500" required style="padding-left: 2rem; font-family: var(--mono); font-size: 1.15rem; font-weight: 700;">
                    </div>
                    <small style="color: var(--text-dim); font-size: 0.75rem; margin-top: 4px; display: block;">Minimum funding is ₦100.</small>
                </div>

                <button type="submit" id="fundSubmitBtn" class="btn btn-primary" style="width: 100%; padding: 0.85rem; font-weight: 700; font-size: 1rem;">
                    Proceed to Secure Payment 🔒
                </button>
            </form>
        </div>
    `;
}

async function handleKorapayCheckout(event) {
    event.preventDefault();
    const input = document.getElementById('fundAmountInput');
    const submitBtn = document.getElementById('fundSubmitBtn');
    const amount = parseFloat(input?.value);

    if (isNaN(amount) || amount < 100) {
        showToast('Please enter an amount of at least ₦100', 'error');
        return;
    }

    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '⏳ Opening Secure Checkout...';
    }

    try {
        const redirectUrl = `${window.location.origin}/#wallet`;
        const res = await fetch('/api/wallet/fund', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount, redirectUrl })
        });

        const data = await res.json();
        if (data.success && data.data?.checkoutUrl) {
            showToast('Redirecting to secure checkout...', 'success');
            window.location.href = data.data.checkoutUrl;
        } else {
            showToast(data.error || 'Failed to initialize payment. Please try again.', 'error');
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = 'Proceed to Secure Payment 🔒';
            }
        }
    } catch (err) {
        showToast('Network error initializing payment', 'error');
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = 'Proceed to Secure Payment 🔒';
        }
    }
}





// ============================================================================
// Admin Suite Operations
// ============================================================================

async function loadAdminDashboard() {
    try {
        const [metricsRes, prodsRes, stockRes, dispRes, ordersRes, usersRes, ledgerRes] = await Promise.all([
            fetch('/api/admin/metrics'),
            fetch('/api/admin/products'),
            fetch('/api/admin/stock'),
            fetch('/api/admin/disputes'),
            fetch('/api/admin/orders'),
            fetch('/api/admin/users'),
            fetch('/api/admin/ledger')
        ]);

        const metricsData = await metricsRes.json();
        const prodsData = await prodsRes.json();
        const stockData = await stockRes.json();
        const dispData = await dispRes.json();
        const ordersData = await ordersRes.json();
        const usersData = await usersRes.json();
        const ledgerData = await ledgerRes.json();

        // 1. Metrics
        if (metricsData.success) {
            const m = metricsData.metrics;
            document.getElementById('admMetricRev').textContent = m.totalRevenue.toLocaleString();
            document.getElementById('admMetricOrders').textContent = m.totalOrders;
            document.getElementById('admMetricStock').textContent = m.stock ? m.stock.available_items : 0;
            document.getElementById('admMetricDisputes').textContent = m.pendingDisputes;
            document.getElementById('admMetricUsers').textContent = m.totalUsers;

            const balObj = m.rakibBalance || m.sujanBalance;
            if (balObj) {
                const bal = balObj.balance_minor ? (balObj.balance_minor / 100) : (parseFloat(balObj.balance) || balObj.amount || 0);
                const balElRakib = document.getElementById('admMetricRakibBal');
                if (balElRakib) balElRakib.textContent = bal.toLocaleString();
                const balElSujan = document.getElementById('admMetricSujanBal');
                if (balElSujan) balElSujan.textContent = bal.toLocaleString();
            }
        }

        // 2. Products table
        if (prodsData.success) {
            renderAdminProducts(prodsData.products);
            populateProductSelects(prodsData.products);
        }

        // 3. Stock table
        if (stockData.success) {
            renderAdminStock(stockData.stock);
        }

        // 4. Disputes queue
        if (dispData.success) {
            renderAdminDisputes(dispData.disputes);
        }

        // 5. Orders table
        if (ordersData.success) {
            renderAdminOrders(ordersData.orders);
        }

        // 6. Users table
        if (usersData.success) {
            renderAdminUsers(usersData.users);
        }

        // 7. Ledger table
        if (ledgerData.success) {
            renderAdminLedger(ledgerData.transactions);
        }
    } catch (err) {
        console.error('Error loading admin suite:', err);
    }
}

function switchAdminTab(tabName, el) {
    document.querySelectorAll('.admin-nav-tab').forEach(t => t.classList.remove('active'));
    el.classList.add('active');
    document.querySelectorAll('.adm-tab-content').forEach(c => c.style.display = 'none');
    const target = document.getElementById(`adm-tab-${tabName}`);
    if (target) target.style.display = 'block';
}

function renderAdminProducts(products) {
    const tbody = document.getElementById('admProductsTableBody');
    if (!tbody) return;

    if (!products.length) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 2rem;">No products in catalog. Click "Sync Rakib Catalog" to import.</td></tr>`;
        return;
    }

    tbody.innerHTML = products.map(p => {
        const rakibBase = p.rakib_base_price != null ? Number(p.rakib_base_price) : (p.sujan_base_price != null ? Number(p.sujan_base_price) : null);
        const isManual = p.manual_price_override === 1;

        return `
            <tr>
                <td style="font-weight: 700;">${escapeHtml(p.name)}</td>
                <td><span style="font-size: 0.85rem; color: var(--text-secondary);">${escapeHtml(p.category_name)}</span></td>
                <td style="color: #94a3b8; font-family: var(--font-mono);">
                    ${rakibBase != null ? `₦${rakibBase.toLocaleString()}` : '<span style="color: var(--text-muted);">Local</span>'}
                </td>
                <td>
                    <strong style="color: var(--accent-emerald); font-size: 1.05rem;">₦${Number(p.price).toLocaleString()}</strong>
                </td>
                <td>
                    ${isManual 
                        ? `<span class="badge" style="background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4);">Manual Override</span>`
                        : `<span class="badge" style="background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4);">Base + ₦1,000</span>`}
                </td>
                <td>
                    <strong style="color: ${p.available_stock > 0 ? 'var(--accent-emerald)' : 'var(--accent-rose)'};">${p.available_stock}</strong>
                </td>
                <td>
                    <span class="badge ${p.is_active ? 'badge-success' : 'badge-danger'}">${p.is_active ? 'Active' : 'Inactive'}</span>
                </td>
                <td>
                    <div style="display: flex; gap: 0.4rem; align-items: center;">
                        <button class="btn btn-primary btn-sm" onclick="openPriceModal(${p.id}, '${escapeCredential(p.name)}', '${escapeCredential(p.category_name)}', ${rakibBase || 0}, ${p.price}, ${p.manual_price_override || 0})">💰 Set Price</button>
                        <button class="btn btn-secondary btn-sm" onclick="switchAdminTab('stock', document.querySelectorAll('.admin-nav-tab')[1])">+ Stock</button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

function populateProductSelects(products) {
    const bulkSelect = document.getElementById('admBulkProductSelect');
    const singleSelect = document.getElementById('admSingleProductSelect');
    const options = products.map(p => `<option value="${p.id}">${p.name} (₦${p.price.toLocaleString()})</option>`).join('');
    if (bulkSelect) bulkSelect.innerHTML = options;
    if (singleSelect) singleSelect.innerHTML = options;
}

function renderAdminStock(stock) {
    const tbody = document.getElementById('admStockTableBody');
    tbody.innerHTML = stock.map(s => `
        <tr>
            <td>#${s.id}</td>
            <td><strong>${s.productName}</strong></td>
            <td><span class="badge ${s.status === 'available' ? 'badge-success' : 'badge-info'}">${s.status}</span></td>
            <td style="font-family: var(--font-mono); font-size: 0.8rem; color: #a5b4fc;">${escapeHtml(s.credentialPreview)}</td>
            <td>${s.orderId ? '#' + s.orderId : '—'}</td>
            <td>${new Date(s.createdAt).toLocaleDateString()}</td>
            <td>
                ${s.status === 'available' ? `<button class="btn btn-danger btn-sm" onclick="deleteStockItem(${s.id})">Delete</button>` : 'Sold'}
            </td>
        </tr>
    `).join('');
}

function renderAdminDisputes(disputes) {
    const tbody = document.getElementById('admDisputesTableBody');
    if (!disputes.length) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 2rem;">No customer disputes currently filed!</td></tr>`;
        return;
    }

    tbody.innerHTML = disputes.map(d => {
        const canResolve = d.status === 'submitted' || d.status === 'under_review';
        return `
            <tr>
                <td>#${d.id}</td>
                <td><strong>${d.order_number}</strong> (₦${d.total_amount.toLocaleString()})</td>
                <td>${d.user_email}</td>
                <td><div style="max-width: 250px; font-size: 0.85rem;">${escapeHtml(d.reason)}</div></td>
                <td>
                    ${d.proof_image_path ? `<a href="${d.proof_image_path}" target="_blank" style="color: var(--accent-cyan); font-weight: 700;">View Proof 🖼️</a>` : '<span style="color: var(--text-muted);">No image</span>'}
                </td>
                <td><span class="badge ${d.status === 'approved_refunded' ? 'badge-success' : (d.status === 'submitted' ? 'badge-warning' : 'badge-info')}">${d.status}</span></td>
                <td>
                    ${canResolve ? `
                        <div style="display: flex; gap: 0.4rem;">
                            <button class="btn btn-emerald btn-sm" onclick="resolveDispute(${d.id}, 'approve')">Approve (Refund ₦)</button>
                            <button class="btn btn-danger btn-sm" onclick="resolveDispute(${d.id}, 'reject')">Reject</button>
                        </div>
                    ` : '<span style="color: var(--text-muted); font-size: 0.85rem;">Resolved</span>'}
                </td>
            </tr>
        `;
    }).join('');
}

function renderAdminOrders(orders) {
    const tbody = document.getElementById('admOrdersTableBody');
    tbody.innerHTML = orders.map(o => `
        <tr>
            <td style="font-family: var(--font-mono); font-weight: 700;">${o.order_number}</td>
            <td>${o.user_email} (${o.user_name})</td>
            <td style="color: var(--accent-emerald); font-weight: 800;">₦${o.total_amount.toLocaleString()}</td>
            <td><span class="badge badge-success">${o.status}</span></td>
            <td>${new Date(o.created_at).toLocaleString()}</td>
            <td><button class="btn btn-secondary btn-sm" onclick="viewOrderCredentials(${o.id})">Inspect</button></td>
        </tr>
    `).join('');
}

function renderAdminUsers(users) {
    const tbody = document.getElementById('admUsersTableBody');
    tbody.innerHTML = users.map(u => `
        <tr>
            <td>#${u.id}</td>
            <td><strong>${u.full_name}</strong></td>
            <td>${u.email}</td>
            <td><span class="badge ${u.role === 'admin' ? 'badge-info' : 'badge-secondary'}">${u.role}</span></td>
            <td style="color: var(--accent-emerald); font-weight: 800;">₦${u.walletBalance.toLocaleString()}</td>
            <td>${u.order_count} orders</td>
            <td><span class="badge ${u.is_banned ? 'badge-danger' : 'badge-success'}">${u.is_banned ? 'Suspended' : 'Active'}</span></td>
            <td>
                ${u.role !== 'admin' ? `<button class="btn btn-secondary btn-sm" onclick="toggleUserBan(${u.id})">${u.is_banned ? 'Reactivate' : 'Suspend'}</button>` : '—'}
            </td>
        </tr>
    `).join('');
}

function renderAdminLedger(transactions) {
    const tbody = document.getElementById('admLedgerTableBody');
    tbody.innerHTML = transactions.map(t => `
        <tr>
            <td>${new Date(t.created_at).toLocaleString()}</td>
            <td>${t.user_email}</td>
            <td style="text-transform: uppercase; font-weight: 700; font-size: 0.8rem;">${t.type}</td>
            <td style="font-weight: 800; color: ${t.type === 'purchase' ? 'var(--accent-rose)' : 'var(--accent-emerald)'};">₦${t.amount.toLocaleString()}</td>
            <td>₦${t.balance_before.toLocaleString()}</td>
            <td>₦${t.balance_after.toLocaleString()}</td>
            <td style="font-family: var(--font-mono); font-size: 0.8rem;">${t.reference}</td>
            <td><span class="badge badge-success">${t.status}</span></td>
        </tr>
    `).join('');
}

async function submitBulkStock() {
    const productId = document.getElementById('admBulkProductSelect').value;
    const bulkText = document.getElementById('admBulkStockTextarea').value;

    if (!bulkText.trim()) {
        showToast('Please enter at least one credential line', 'error');
        return;
    }

    try {
        const res = await fetch('/api/admin/stock/bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ productId, bulkText })
        });
        const data = await res.json();
        if (data.success) {
            showToast(data.message, 'success');
            document.getElementById('admBulkStockTextarea').value = '';
            loadAdminDashboard();
        } else {
            showToast(data.error || 'Failed to upload bulk stock', 'error');
        }
    } catch (err) {
        showToast('Error uploading stock', 'error');
    }
}

async function submitSingleStock() {
    const productId = document.getElementById('admSingleProductSelect').value;
    const credentialText = document.getElementById('admSingleStockInput').value.trim();

    if (!credentialText) {
        showToast('Please enter credential text', 'error');
        return;
    }

    try {
        const res = await fetch('/api/admin/stock/manual', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ productId, credentialText })
        });
        const data = await res.json();
        if (data.success) {
            showToast('Stock item saved and encrypted!', 'success');
            document.getElementById('admSingleStockInput').value = '';
            loadAdminDashboard();
        } else {
            showToast(data.error || 'Failed to add stock', 'error');
        }
    } catch (err) {
        showToast('Error adding stock item', 'error');
    }
}

async function deleteStockItem(id) {
    if (!confirm('Are you sure you want to remove this unsold stock credential?')) return;
    try {
        const res = await fetch(`/api/admin/stock/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            showToast('Stock credential removed', 'info');
            loadAdminDashboard();
        }
    } catch (err) {
        showToast('Error deleting stock', 'error');
    }
}

async function resolveDispute(id, action) {
    const promptMsg = action === 'approve' 
        ? 'Approve this dispute? The customer will receive an immediate wallet credit refund.' 
        : 'Are you sure you want to reject this dispute?';
    
    if (!confirm(promptMsg)) return;

    try {
        const res = await fetch(`/api/admin/disputes/${id}/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, notes: `Processed by administrator (${action})` })
        });
        const data = await res.json();
        if (data.success) {
            showToast(data.message, 'success');
            loadAdminDashboard();
        } else {
            showToast(data.error || 'Resolution error', 'error');
        }
    } catch (err) {
        showToast('Error resolving dispute', 'error');
    }
}

async function toggleUserBan(userId) {
    try {
        const res = await fetch(`/api/admin/users/${userId}/toggle-ban`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast(data.message, 'info');
            loadAdminDashboard();
        }
    } catch (err) {
        showToast('Error changing user status', 'error');
    }
}

function openCreateProductModal() {
    const sel = document.getElementById('admNewProductCategory');
    sel.innerHTML = state.categories.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
    openModal('admProductModal');
}

async function submitCreateProduct() {
    const categoryId = document.getElementById('admNewProductCategory').value;
    const name = document.getElementById('admNewProductName').value.trim();
    const price = document.getElementById('admNewProductPrice').value;
    const description = document.getElementById('admNewProductDesc').value.trim();
    const imageUrl = document.getElementById('admNewProductImage').value.trim();

    if (!name || !price) {
        showToast('Name and price are required', 'error');
        return;
    }

    try {
        const res = await fetch('/api/admin/products', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ categoryId, name, price, description, imageUrl })
        });
        const data = await res.json();
        if (data.success) {
            showToast('Product created successfully!', 'success');
            closeModal('admProductModal');
            loadAdminDashboard();
            loadCatalog();
        } else {
            showToast(data.error || 'Failed to create product', 'error');
        }
    } catch (err) {
        showToast('Error creating product', 'error');
    }
}

// ============================================================================
// Rakib Catalog Sync & Manual Price Control
// ============================================================================

async function triggerRakibCatalogSync() {
    const btn = document.getElementById('btnSyncRakib') || document.getElementById('btnSyncSujan');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ Syncing...';
    }

    try {
        const res = await fetch('/api/admin/products/sync-rakib', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        const data = await res.json();
        if (data.success) {
            showToast(`Catalog Synced! ${data.result.productsSynced} products updated with live Rakib wholesale prices.`, 'success');
            loadAdminDashboard();
            loadCatalog();
        } else {
            showToast(data.error || 'Failed to sync Rakib catalog', 'error');
        }
    } catch (e) {
        showToast('Sync request error', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '🔄 Sync Live Catalog';
        }
    }
}
const triggerSujanCatalogSync = triggerRakibCatalogSync;

function openPriceModal(productId, productName, categoryName, rakibBase, currentPrice, isManual) {
    document.getElementById('admPriceProductId').value = productId;
    document.getElementById('admPriceProductName').textContent = productName;
    document.getElementById('admPriceProductCategory').textContent = categoryName;
    
    const elRakib = document.getElementById('admPriceRakibBase');
    if (elRakib) elRakib.textContent = rakibBase ? `₦${Number(rakibBase).toLocaleString()}` : 'Local Inventory';
    const elSujan = document.getElementById('admPriceSujanBase');
    if (elSujan) elSujan.textContent = rakibBase ? `₦${Number(rakibBase).toLocaleString()}` : 'Local Inventory';

    document.getElementById('admPriceCurrentActive').textContent = `₦${Number(currentPrice).toLocaleString()}`;
    document.getElementById('admPriceCustomInput').value = currentPrice;
    openModal('admPriceModal');
}

async function saveCustomProductPrice() {
    const productId = document.getElementById('admPriceProductId').value;
    const priceVal = document.getElementById('admPriceCustomInput').value;

    if (!priceVal || isNaN(priceVal) || Number(priceVal) < 0) {
        showToast('Please enter a valid positive price', 'error');
        return;
    }

    try {
        const res = await fetch(`/api/admin/products/${productId}/price`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ price: Number(priceVal) })
        });
        const data = await res.json();
        if (data.success) {
            showToast(data.message, 'success');
            closeModal('admPriceModal');
            loadAdminDashboard();
            loadCatalog();
        } else {
            showToast(data.error || 'Failed to update price', 'error');
        }
    } catch (e) {
        showToast('Network error updating price', 'error');
    }
}

async function resetProductPriceToDefault() {
    const productId = document.getElementById('admPriceProductId').value;
    try {
        const res = await fetch(`/api/admin/products/${productId}/price`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resetToDefault: true })
        });
        const data = await res.json();
        if (data.success) {
            showToast(data.message, 'success');
            closeModal('admPriceModal');
            loadAdminDashboard();
            loadCatalog();
        } else {
            showToast(data.error || 'Failed to reset price', 'error');
        }
    } catch (e) {
        showToast('Network error resetting price', 'error');
    }
}

// ============================================================================
// UI Modals & Utilities
// ============================================================================

function openModal(modalId) {
    const el = document.getElementById(modalId);
    if (el) el.classList.add('open');
}

function closeModal(modalId) {
    const el = document.getElementById(modalId);
    if (el) el.classList.remove('open');
}

function toggleFaq(el) {
    const item = el.parentElement;
    item.classList.toggle('open');
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        showToast('Credentials copied to clipboard! 📋', 'success');
    }).catch(() => {
        showToast('Failed to copy to clipboard', 'error');
    });
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    let icon = 'ℹ️';
    if (type === 'success') icon = '✅';
    if (type === 'error') icon = '❌';

    toast.innerHTML = `<span>${icon}</span><span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

function escapeHtml(text) {
    if (!text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function escapeCredential(text) {
    if (!text) return '';
    return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
}

// ============================================================================
// Live Order Feed Ticker
// ============================================================================

const LiveOrderFeed = (() => {
    const TICKER_ID        = 'liveFeedTicker';
    const DISPLAY_MS       = 7000;   // how long each card is visible
    const INTERVAL_MS      = 9000;   // gap between cards
    const REFRESH_MS       = 120000; // re-fetch from API every 2 minutes
    const SESSION_KEY      = 'olf_dismissed'; // sessionStorage key

    // Fallback demo entries shown when the DB has no orders yet
    const DEMO_FEED = [
        { product_name: 'CLONE INSTAGRAM US | FULL 2FA', quantity: 1, category_icon: '📸', created_at: new Date(Date.now() - 3 * 60000).toISOString() },
        { product_name: 'AVAST VPN',                    quantity: 2, category_icon: '🛡️', created_at: new Date(Date.now() - 8 * 60000).toISOString() },
        { product_name: 'Google Voice PVA',             quantity: 1, category_icon: '📞', created_at: new Date(Date.now() - 14 * 60000).toISOString() },
        { product_name: 'CLONE TIKTOK US | Full 2FA',   quantity: 3, category_icon: '🎵', created_at: new Date(Date.now() - 22 * 60000).toISOString() },
        { product_name: 'NordVPN Premium 1-Month',      quantity: 1, category_icon: '🛡️', created_at: new Date(Date.now() - 31 * 60000).toISOString() },
    ];

    let feed     = [];
    let cursor   = 0;
    let loopTimer   = null;
    let refreshTimer = null;
    let dismissed  = false;

    const timeAgo = (isoString) => {
        const diffMs  = Date.now() - new Date(isoString).getTime();
        const diffMin = Math.floor(diffMs / 60000);
        const diffHr  = Math.floor(diffMin / 60);
        if (diffMin < 1)  return 'just now';
        if (diffMin < 60) return `${diffMin} min ago`;
        if (diffHr  < 24) return `${diffHr}h ago`;
        return `${Math.floor(diffHr / 24)}d ago`;
    };

    const truncate = (name, maxLen = 36) => {
        return name.length > maxLen ? name.slice(0, maxLen - 1) + '…' : name;
    };

    const fetchFeed = async () => {
        try {
            const res  = await fetch('/api/orders/feed');
            const data = await res.json();
            if (data.success && Array.isArray(data.feed) && data.feed.length > 0) {
                feed   = data.feed;
                cursor = 0;
            } else if (feed.length === 0) {
                // Empty DB — use demo data so the ticker always shows
                feed   = DEMO_FEED;
                cursor = 0;
            }
        } catch (_) {
            if (feed.length === 0) {
                feed   = DEMO_FEED;
                cursor = 0;
            }
        }
    };

    const showNext = () => {
        if (dismissed) return;
        if (feed.length === 0) return;

        const mount = document.getElementById(TICKER_ID);
        if (!mount) return;

        // Remove any existing card
        const existing = mount.querySelector('.lf-card');
        if (existing) {
            existing.classList.add('lf-exit');
            setTimeout(() => existing.remove(), 380);
        }

        // Delay slightly so exit animation runs first
        setTimeout(() => {
            if (dismissed) return;

            const item = feed[cursor % feed.length];
            cursor++;

            const qty     = item.quantity > 1 ? `${item.quantity}x ` : '';
            const icon    = item.category_icon || '🛍️';
            const name    = truncate(item.product_name);
            const when    = timeAgo(item.created_at);

            const card = document.createElement('div');
            card.className = 'lf-card';
            card.setAttribute('role', 'status');
            card.innerHTML = `
                <div class="lf-emoji">${icon}</div>
                <div class="lf-body">
                    <div class="lf-label">
                        <span class="lf-dot"></span>
                        Live Sale
                    </div>
                    <div class="lf-product">Someone just bought ${qty}${escapeHtml(name)}</div>
                    <div class="lf-meta">${when}</div>
                </div>
                <button class="lf-close" title="Dismiss" onclick="LiveOrderFeed.dismiss()" aria-label="Close live feed">✕</button>
            `;

            mount.innerHTML = '';
            mount.appendChild(card);
        }, existing ? 400 : 0);
    };

    const start = () => {
        if (dismissed) return;
        showNext();
        loopTimer = setInterval(showNext, INTERVAL_MS);
    };

    const stop = () => {
        clearInterval(loopTimer);
        clearInterval(refreshTimer);
        loopTimer = null;
        refreshTimer = null;
    };

    const dismiss = () => {
        dismissed = true;
        stop();
        try { sessionStorage.setItem(SESSION_KEY, '1'); } catch (_) {}
        const mount = document.getElementById(TICKER_ID);
        if (!mount) return;
        const card = mount.querySelector('.lf-card');
        if (card) {
            card.classList.add('lf-exit');
            setTimeout(() => { mount.innerHTML = ''; }, 380);
        } else {
            mount.innerHTML = '';
        }
    };

    const init = async () => {
        // Respect session-level dismiss
        try { if (sessionStorage.getItem(SESSION_KEY)) { dismissed = true; return; } } catch (_) {}

        await fetchFeed();

        // Small delay after page load before first card appears
        setTimeout(start, 3500);

        // Periodically refresh the feed list from the API
        refreshTimer = setInterval(async () => {
            await fetchFeed();
        }, REFRESH_MS);
    }

    return { init, dismiss };
})();

window.LiveOrderFeed = LiveOrderFeed;

function initLiveOrderFeed() {
    LiveOrderFeed.init();
}

