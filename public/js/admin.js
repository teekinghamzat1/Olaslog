/**
 * Olaslog Admin Operations Center - Application Logic
 * Directly interfaces with Express backend API
 */

const adminState = {
  user: null,
  currentTab: 'overview',
  products: [],
  stock: [],
  orders: [],
  disputes: [],
  users: [],
  admins: [],
  ledger: [],
  emailSettings: null,
  emailTemplates: {},
  currentEmailTemplateKey: 'welcome',
  selectedOrderId: null,
  selectedDisputeId: null
};

document.addEventListener('DOMContentLoaded', async () => {
  await verifyAdminAuth();
  await loadMetrics();
  await loadProducts();
  await loadStock();
  await loadOrders();
  await loadDisputes();
  await loadUsers();
  await loadAdmins();
  await loadLedger();
  await loadEmailSettings();
});

async function verifyAdminAuth() {
  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();
    if (data.success && data.user && data.user.role === 'admin') {
      adminState.user = data.user;
      const screen = document.getElementById('adminLoginScreen');
      if (screen) screen.style.display = 'none';
      document.getElementById('sbAdminName').textContent = data.user.fullName || data.user.email;
      const initials = (data.user.fullName || 'AD').split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
      document.getElementById('sbAvatar').textContent = initials;
      return true;
    } else {
      showAdminLogin();
      return false;
    }
  } catch (err) {
    showAdminLogin();
    return false;
  }
}

function showAdminLogin() {
  const screen = document.getElementById('adminLoginScreen');
  if (screen) screen.style.display = 'flex';
}

async function handleAdminLogin(e) {
  e.preventDefault();
  const email = document.getElementById('adminEmailInput').value;
  const password = document.getElementById('adminPasswordInput').value;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (data.success && data.user) {
      if (data.user.role !== 'admin') {
        showAdminToast('Account does not have administrator privileges', 'error');
        return;
      }
      adminState.user = data.user;
      document.getElementById('adminLoginScreen').style.display = 'none';
      showAdminToast('Authenticated as Administrator', 'success');
      await verifyAdminAuth();
      await loadMetrics();
      await loadProducts();
      await loadStock();
      await loadOrders();
      await loadDisputes();
      await loadUsers();
      await loadAdmins();
      await loadLedger();
    } else {
      showAdminToast(data.error || 'Invalid credentials', 'error');
    }
  } catch (err) {
    showAdminToast('Login network error occurred', 'error');
  }
}

async function logoutAdmin() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch (_) {}
  adminState.user = null;
  showAdminLogin();
  showAdminToast('Logged out of admin console', 'info');
}

function switchTab(tabKey, el = null) {
  adminState.currentTab = tabKey;

  // Sidebar items
  document.querySelectorAll('.sb-item').forEach(item => {
    item.classList.remove('active');
    if (item.getAttribute('data-screen') === tabKey) {
      item.classList.add('active');
    }
  });

  // Mobile horizontal tabs
  document.querySelectorAll('.adm-tab-pill').forEach(pill => {
    pill.classList.remove('active');
    if (pill.getAttribute('data-screen') === tabKey) {
      pill.classList.add('active');
      pill.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  });

  // Panels
  document.querySelectorAll('.screen-panel').forEach(p => p.classList.remove('active'));
  const target = document.getElementById(`panel-${tabKey}`);
  if (target) target.classList.add('active');

  // Title
  const titles = {
    overview: 'Operations Overview',
    products: 'Products & Price Controls',
    stock: 'Stock & Inventory',
    orders: 'Orders Inspector',
    disputes: 'Dispute Resolution Queue',
    users: 'Registered User Directory',
    admins: 'Administrator & Staff Console',
    ledger: 'Financial Ledger Audit',
    email: 'Alerts & Email Operations',
    analytics: 'Sales Analytics & Revenue Intelligence'
  };
  document.getElementById('pageTitle').textContent = titles[tabKey] || 'Operations';

  // Dynamic reload when switching to certain tabs
  if (tabKey === 'users') loadUsers();
  if (tabKey === 'admins') loadAdmins();
  if (tabKey === 'ledger') loadLedger();
  if (tabKey === 'email') loadEmailSettings();
  if (tabKey === 'analytics') loadSalesAnalytics();

  // Mobile drawer close if open
  toggleMobileSidebar(false);
}

function toggleMobileSidebar(force = null) {
  const sb = document.getElementById('adminSidebar');
  const overlay = document.getElementById('adminDrawerOverlay');
  if (!sb) return;

  const isOpen = force !== null ? force : !sb.classList.contains('open');
  if (isOpen) {
    sb.classList.add('open');
    if (overlay) overlay.classList.add('open');
  } else {
    sb.classList.remove('open');
    if (overlay) overlay.classList.remove('open');
  }
}

// ============================================================================
// Data Loaders
// ============================================================================

async function loadMetrics() {
  try {
    const res = await fetch('/api/admin/metrics');
    const data = await res.json();
    if (data.success && data.metrics) {
      const m = data.metrics;
      document.getElementById('kpiRevenue').textContent = (m.totalRevenue || 0).toLocaleString();
      document.getElementById('kpiOrders').textContent = (m.completedOrdersCount || 0).toLocaleString();
      document.getElementById('kpiStock').textContent = (m.availableStockCount || 0).toLocaleString();
      document.getElementById('kpiDisputes').textContent = m.pendingDisputesCount || 0;
      document.getElementById('sbDisputeCount').textContent = m.pendingDisputesCount || 0;
      document.getElementById('kpiUsers').textContent = (m.totalCustomersCount || 0).toLocaleString();
      let sujanVal = 0;
      const balObj = m.sujanBalance;
      if (typeof balObj === 'object' && balObj !== null) {
        sujanVal = balObj.balance ?? balObj.amount ?? balObj.funds ?? 0;
      } else if (typeof balObj === 'number') {
        sujanVal = balObj;
      }
      const elSujan = document.getElementById('kpiSujanBal');
      if (elSujan) elSujan.textContent = Number(sujanVal || 0).toLocaleString();
    }
  } catch (err) {
    console.error('Failed to load metrics:', err);
  }
}

async function loadProducts() {
  try {
    const res = await fetch('/api/admin/products');
    const data = await res.json();
    if (data.success && data.products) {
      adminState.products = data.products;
      renderProductsTable(data.products);
      populateBulkProductSelect(data.products);
      await loadAdminCategories();
    }
  } catch (err) {
    console.error('Failed to load products:', err);
  }
}

function renderProductsTable(products) {
  const tbody = document.getElementById('adminProductsTableBody');
  if (!tbody) return;

  if (!products.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:2rem; color:var(--text-faint);">No products found.</td></tr>`;
    return;
  }

  tbody.innerHTML = products.map(p => {
    const cost = p.sujan_base_price ?? p.sujan_cost;
    const wholesale = cost ? `₦${Number(cost).toLocaleString()}` : '<span style="color:var(--text-faint);">N/A</span>';
    const isOverride = p.is_custom_price === 1 || p.manual_price_override === 1;
    const modeBadge = isOverride
      ? `<span class="pill pill-gold"><span class="dot"></span>Manual</span>`
      : `<span class="pill pill-teal"><span class="dot"></span>Auto +₦1,000</span>`;
    const stockCount = p.stock_count !== undefined ? p.stock_count : (p.available_stock || 0);
    const stockPill = stockCount > 0
      ? `<span class="pill pill-teal"><span class="dot"></span>${stockCount} in stock</span>`
      : `<span class="pill pill-danger"><span class="dot"></span>Out of stock</span>`;
    const providerId = p.sujan_product_id;

    return `
      <tr class="row-clickable">
        <td>
          <div class="cell-title">${p.name}</div>
          <div class="cell-sub mono">#${p.id} • ${providerId ? `Sujan #${providerId}` : 'Local'}</div>
        </td>
        <td class="mono">${p.category_name || 'General'}</td>
        <td class="mono" style="color:var(--text-faint);">${wholesale}</td>
        <td style="font-weight:700; color:var(--gold); font-family:var(--display); font-size:14.5px;">₦${p.price.toLocaleString()}</td>
        <td>${modeBadge}</td>
        <td>${stockPill}</td>
        <td><span class="pill ${p.is_active === 0 ? 'pill-danger' : 'pill-muted'}"><span class="dot"></span>${p.is_active === 0 ? 'Inactive' : 'Active'}</span></td>
        <td>
          <div style="display: flex; gap: 5px; align-items: center;">
            <button class="btn btn-outline btn-sm" style="padding: 4px 8px; font-size: 11px;" onclick="openPriceModal(${p.id})" title="Set Custom Price">Price</button>
            <button class="btn btn-outline btn-sm" style="padding: 4px 8px; font-size: 11px;" onclick="openEditProductModal(${p.id})" title="Edit Product">✏️ Edit</button>
            <button class="btn btn-danger btn-sm" style="padding: 4px 8px; font-size: 11px;" onclick="deleteProduct(${p.id})" title="Deactivate / Delete Product">🗑️ Del</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function populateBulkProductSelect(products) {
  const sel = document.getElementById('admBulkProductSelect');
  if (!sel) return;
  sel.innerHTML = products.map(p => `<option value="${p.id}">${p.name} (₦${p.price.toLocaleString()})</option>`).join('');
}

async function syncSujanCatalog() {
  const btn = document.getElementById('btnSyncSujan');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Syncing...';
  }
  try {
    const res = await fetch('/api/admin/products/sync-sujan', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showAdminToast(data.message || 'Catalog synced with Sujan Logs Marketplace!', 'success');
      await loadProducts();
      await loadMetrics();
    } else {
      showAdminToast(data.error || 'Failed to sync catalog', 'error');
    }
  } catch (err) {
    showAdminToast('Network error triggering sync', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🔄 Sync Live Catalog';
    }
  }
}

// Manual Price Modal
function openPriceModal(productId) {
  const product = adminState.products.find(p => p.id === productId);
  if (!product) return;

  const cost = product.sujan_base_price ?? product.sujan_cost ?? 0;

  document.getElementById('admPriceProductId').value = product.id;
  document.getElementById('admPriceProductName').textContent = product.name;
  document.getElementById('admPriceProductCategory').textContent = product.category_name || 'General';
  
  const elSujan = document.getElementById('admPriceSujanBase');
  if (elSujan) elSujan.textContent = cost ? `₦${Number(cost).toLocaleString()}` : '₦0';

  document.getElementById('admPriceCurrentActive').textContent = `₦${product.price.toLocaleString()}`;
  document.getElementById('admPriceCustomInput').value = product.price;

  openAdminModal('admPriceModal');
}

async function saveCustomPrice() {
  const id = document.getElementById('admPriceProductId').value;
  const newPrice = parseFloat(document.getElementById('admPriceCustomInput').value);

  if (!newPrice || newPrice <= 0) {
    showAdminToast('Please enter a valid price in Naira', 'error');
    return;
  }

  try {
    const res = await fetch(`/api/admin/products/${id}/price`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ price: newPrice, isCustomPrice: true })
    });
    const data = await res.json();
    if (data.success) {
      showAdminToast(data.message, 'success');
      closeAdminModal('admPriceModal');
      await loadProducts();
    } else {
      showAdminToast(data.error || 'Failed to save price', 'error');
    }
  } catch (err) {
    showAdminToast('Network error saving price', 'error');
  }
}

async function resetPriceToDefault() {
  const id = document.getElementById('admPriceProductId').value;
  try {
    const res = await fetch(`/api/admin/products/${id}/price`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resetToDefaultFormula: true })
    });
    const data = await res.json();
    if (data.success) {
      showAdminToast(data.message, 'success');
      closeAdminModal('admPriceModal');
      await loadProducts();
    } else {
      showAdminToast(data.error || 'Failed to reset price', 'error');
    }
  } catch (err) {
    showAdminToast('Network error resetting price', 'error');
  }
}

// ============================================================================
// Product & Category Management
// ============================================================================

let adminCategories = [];

async function loadAdminCategories() {
  try {
    const res = await fetch('/api/admin/categories');
    const data = await res.json();
    if (data.success && data.categories) {
      adminCategories = data.categories;
      const sel = document.getElementById('admProdCategorySelect');
      if (sel) {
        sel.innerHTML = data.categories.map(c => `<option value="${c.id}">${c.icon || '📦'} ${c.name}</option>`).join('');
      }
    }
  } catch (err) {
    console.error('Failed to load categories:', err);
  }
}

function openAddProductModal() {
  document.getElementById('admProductModalTitle').textContent = '+ Add New Product';
  document.getElementById('admProductEditId').value = '';
  document.getElementById('admProdName').value = '';
  document.getElementById('admProdPrice').value = '';
  document.getElementById('admProdDesc').value = '';
  document.getElementById('admProdMinQty').value = '1';
  document.getElementById('admProdMaxQty').value = '50';
  document.getElementById('admProdImage').value = '';
  document.getElementById('admProdIsActive').checked = true;
  document.getElementById('btnSaveProduct').textContent = 'Create Product';
  openAdminModal('admProductModal');
}

function openEditProductModal(productId) {
  const product = adminState.products.find(p => p.id === productId);
  if (!product) return;

  document.getElementById('admProductModalTitle').textContent = `✏️ Edit Product #${product.id}`;
  document.getElementById('admProductEditId').value = product.id;
  document.getElementById('admProdName').value = product.name || '';
  document.getElementById('admProdPrice').value = product.price || '';
  document.getElementById('admProdDesc').value = product.description || '';
  document.getElementById('admProdMinQty').value = product.min_order_qty || 1;
  document.getElementById('admProdMaxQty').value = product.max_order_qty || 50;
  document.getElementById('admProdImage').value = product.image_url || '';
  document.getElementById('admProdIsActive').checked = product.is_active !== 0;

  const sel = document.getElementById('admProdCategorySelect');
  if (sel && product.category_id) {
    sel.value = product.category_id;
  }

  document.getElementById('btnSaveProduct').textContent = 'Save Changes';
  openAdminModal('admProductModal');
}

async function saveProductForm() {
  const editId = document.getElementById('admProductEditId').value;
  const name = document.getElementById('admProdName').value.trim();
  const categoryId = parseInt(document.getElementById('admProdCategorySelect').value, 10);
  const price = parseFloat(document.getElementById('admProdPrice').value);
  const description = document.getElementById('admProdDesc').value.trim();
  const minQty = parseInt(document.getElementById('admProdMinQty').value || '1', 10);
  const maxQty = parseInt(document.getElementById('admProdMaxQty').value || '50', 10);
  const imageUrl = document.getElementById('admProdImage').value.trim();
  const isActive = document.getElementById('admProdIsActive').checked ? 1 : 0;

  if (!name) {
    showAdminToast('Please enter a product name', 'error');
    return;
  }
  if (!price || price <= 0) {
    showAdminToast('Please enter a valid price in Naira', 'error');
    return;
  }
  if (!categoryId) {
    showAdminToast('Please select a category', 'error');
    return;
  }

  const payload = {
    name,
    categoryId,
    price,
    description,
    minQty,
    maxQty,
    imageUrl: imageUrl || undefined,
    isActive
  };

  const btn = document.getElementById('btnSaveProduct');
  btn.disabled = true;

  try {
    const url = editId ? `/api/admin/products/${editId}` : '/api/admin/products';
    const method = editId ? 'PUT' : 'POST';

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (data.success) {
      showAdminToast(data.message || (editId ? 'Product updated successfully' : 'Product created successfully'), 'success');
      closeAdminModal('admProductModal');
      await loadProducts();
    } else {
      showAdminToast(data.error || 'Failed to save product', 'error');
    }
  } catch (err) {
    showAdminToast('Network error saving product', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function deleteProduct(productId) {
  const product = adminState.products.find(p => p.id === productId);
  const name = product ? product.name : `#${productId}`;

  if (!confirm(`Are you sure you want to deactivate or remove product "${name}"?`)) {
    return;
  }

  try {
    const res = await fetch(`/api/admin/products/${productId}?permanent=true`, {
      method: 'DELETE'
    });
    const data = await res.json();

    if (data.success) {
      showAdminToast(data.message || 'Product removed successfully', 'success');
      await loadProducts();
    } else {
      showAdminToast(data.error || 'Failed to delete product', 'error');
    }
  } catch (err) {
    showAdminToast('Network error deleting product', 'error');
  }
}

function openAddCategoryModal() {
  document.getElementById('admCatName').value = '';
  document.getElementById('admCatIcon').value = '📦';
  document.getElementById('admCatSlug').value = '';
  document.getElementById('admCatRules').value = '';
  openAdminModal('admCategoryModal');
}

async function saveCategoryForm() {
  const name = document.getElementById('admCatName').value.trim();
  const icon = document.getElementById('admCatIcon').value.trim() || '📦';
  const slug = document.getElementById('admCatSlug').value.trim();
  const rulesGuide = document.getElementById('admCatRules').value.trim();

  if (!name) {
    showAdminToast('Please enter category name', 'error');
    return;
  }

  const btn = document.getElementById('btnSaveCategory');
  btn.disabled = true;

  try {
    const res = await fetch('/api/admin/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, icon, slug, rulesGuide })
    });
    const data = await res.json();

    if (data.success) {
      showAdminToast('Category created successfully!', 'success');
      closeAdminModal('admCategoryModal');
      await loadAdminCategories();
      await loadProducts();
    } else {
      showAdminToast(data.error || 'Failed to create category', 'error');
    }
  } catch (err) {
    showAdminToast('Network error creating category', 'error');
  } finally {
    btn.disabled = false;
  }
}

// ============================================================================
// Stock & Inventory
// ============================================================================

async function loadStock() {
  try {
    const res = await fetch('/api/admin/stock');
    const data = await res.json();
    if (data.success && data.stock) {
      adminState.stock = data.stock;
      renderStockTable(data.stock);
    }
  } catch (err) {
    console.error('Failed to load stock:', err);
  }
}

function renderStockTable(stock) {
  const tbody = document.getElementById('adminStockTableBody');
  if (!tbody) return;

  if (!stock.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:2rem; color:var(--text-faint);">No stock items in inventory.</td></tr>`;
    return;
  }

  tbody.innerHTML = stock.slice(0, 100).map(s => {
    const statusPill = s.status === 'available'
      ? `<span class="pill pill-gold"><span class="dot"></span>Available</span>`
      : `<span class="pill pill-teal"><span class="dot"></span>Sold</span>`;
    const prodName = s.product_name || s.productName || `Product #${s.product_id || s.productId}`;
    const credText = s.credential_text || s.credentialPreview || '';
    const ordId = s.order_id || s.orderId;
    const createdAtDate = s.created_at || s.createdAt || new Date();
    return `
      <tr>
        <td class="mono">#${s.id}</td>
        <td><div class="cell-title">${escapeHtml(prodName)}</div></td>
        <td>${statusPill}</td>
        <td class="mono" style="color:var(--teal);">${escapeHtml(credText)}</td>
        <td class="mono">${ordId ? `#${ordId}` : '<span style="color:var(--text-faint);">Unassigned</span>'}</td>
        <td class="mono">${new Date(createdAtDate).toLocaleDateString()}</td>
      </tr>
    `;
  }).join('');
}

function openBulkStockModal() {
  document.getElementById('admBulkStockTextarea').value = '';
  openAdminModal('admBulkStockModal');
}

async function submitBulkStock() {
  const productId = parseInt(document.getElementById('admBulkProductSelect').value, 10);
  const rawText = document.getElementById('admBulkStockTextarea').value;
  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);

  if (!lines.length) {
    showAdminToast('Please provide at least one credential line', 'error');
    return;
  }

  try {
    const res = await fetch('/api/admin/stock/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, credentials: lines })
    });
    const data = await res.json();
    if (data.success) {
      showAdminToast(`Successfully encrypted and uploaded ${data.uploadedCount} item(s)!`, 'success');
      closeAdminModal('admBulkStockModal');
      await loadStock();
      await loadProducts();
      await loadMetrics();
    } else {
      showAdminToast(data.error || 'Failed to upload stock', 'error');
    }
  } catch (err) {
    showAdminToast('Network error uploading stock', 'error');
  }
}

// ============================================================================
// Orders & Two-Pane Inspector
// ============================================================================

async function loadOrders() {
  try {
    const res = await fetch('/api/admin/orders');
    const data = await res.json();
    if (data.success && data.orders) {
      adminState.orders = data.orders;
      renderOrdersList(data.orders);
      renderOverviewRecentOrders(data.orders.slice(0, 5));
    }
  } catch (err) {
    console.error('Failed to load orders:', err);
  }
}

function renderOverviewRecentOrders(orders) {
  const tbody = document.getElementById('overviewRecentOrdersBody');
  if (!tbody) return;
  if (!orders.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:1.5rem; color:var(--text-faint);">No recent orders.</td></tr>`;
    return;
  }
  tbody.innerHTML = orders.map(o => {
    const custDisplay = o.customer_name || o.user_name || o.customer_email || o.user_email || 'Customer';
    return `
      <tr class="row-clickable" onclick="inspectOrder(${o.id})">
        <td><div class="cell-title">${o.order_number}</div><div class="cell-sub mono">${new Date(o.created_at).toLocaleDateString()}</div></td>
        <td>${escapeHtml(custDisplay)}</td>
        <td style="font-weight:700; color:var(--teal);">₦${(o.total_amount || 0).toLocaleString()}</td>
        <td><span class="pill pill-teal"><span class="dot"></span>${o.status}</span></td>
      </tr>
    `;
  }).join('');
}

function renderOrdersList(orders) {
  const tbody = document.getElementById('adminOrdersTableBody');
  if (!tbody) return;
  if (!orders.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:2rem; color:var(--text-faint);">No customer orders found.</td></tr>`;
    return;
  }
  tbody.innerHTML = orders.map(o => {
    const custDisplay = o.customer_name || o.user_name || o.customer_email || o.user_email || 'Customer';
    return `
      <tr class="row-clickable ${adminState.selectedOrderId === o.id ? 'style="background:var(--panel-3)"' : ''}" onclick="inspectOrder(${o.id})">
        <td class="mono">${o.order_number}</td>
        <td><div class="cell-title">${escapeHtml(custDisplay)}</div></td>
        <td style="font-weight:700; color:var(--teal);">₦${(o.total_amount || 0).toLocaleString()}</td>
        <td><span class="pill pill-teal"><span class="dot"></span>${o.status}</span></td>
      </tr>
    `;
  }).join('');
}

function inspectOrder(orderId) {
  adminState.selectedOrderId = orderId;
  const order = adminState.orders.find(o => o.id === orderId);
  if (!order) return;

  switchTab('orders');

  document.getElementById('orderDetailTitle').textContent = `Order ${order.order_number}`;
  document.getElementById('orderDetailBadge').textContent = order.status;
  document.getElementById('orderDetailBadge').className = 'pill pill-teal';

  const custName = order.customer_name || order.user_name || 'Customer';
  const custEmail = order.customer_email || order.user_email || 'N/A';

  document.getElementById('orderDetailBody').innerHTML = `
    <div class="detail-row"><span>Customer Name</span><span>${escapeHtml(custName)}</span></div>
    <div class="detail-row"><span>Email</span><span class="mono">${escapeHtml(custEmail)}</span></div>
    <div class="detail-row"><span>Amount Charged</span><span style="color:var(--teal); font-weight:700;">₦${(order.total_amount || 0).toLocaleString()}</span></div>
    <div class="detail-row"><span>Items Count</span><span>${order.item_count || 1} unit(s)</span></div>
    <div class="detail-row"><span>Delivered Date</span><span class="mono">${new Date(order.created_at).toLocaleString()}</span></div>
    <div class="detail-row"><span>Dispute Status</span><span>${order.dispute_status || 'None'}</span></div>
  `;
}

// ============================================================================
// Dispute Resolution Queue
// ============================================================================

async function loadDisputes() {
  try {
    const res = await fetch('/api/admin/disputes');
    const data = await res.json();
    if (data.success && data.disputes) {
      adminState.disputes = data.disputes;
      renderDisputesQueue(data.disputes);
      renderOverviewRecentDisputes(data.disputes.slice(0, 5));
    }
  } catch (err) {
    console.error('Failed to load disputes:', err);
  }
}

function renderOverviewRecentDisputes(disputes) {
  const tbody = document.getElementById('overviewRecentDisputesBody');
  if (!tbody) return;
  if (!disputes.length) {
    tbody.innerHTML = `<tr><td colspan="3" style="text-align:center; padding:1.5rem; color:var(--text-faint);">No pending disputes.</td></tr>`;
    return;
  }
  tbody.innerHTML = disputes.map(d => `
    <tr class="row-clickable" onclick="inspectDispute(${d.id})">
      <td class="mono">${d.order_number}</td>
      <td><div class="cell-title">${d.claim_reason.substring(0, 32)}...</div></td>
      <td><span class="pill pill-gold"><span class="dot"></span>Review</span></td>
    </tr>
  `).join('');
}

function renderDisputesQueue(disputes) {
  const list = document.getElementById('disputesQueueList');
  const badge = document.getElementById('disputeQueueCountBadge');
  if (!list) return;

  const openCount = disputes.filter(d => d.status !== 'approved_refunded' && d.status !== 'rejected').length;
  badge.innerHTML = `<span class="dot"></span>${openCount} Claims`;

  if (!disputes.length) {
    list.innerHTML = `<div style="padding: 2rem; text-align: center; color: var(--text-faint);">No disputes filed.</div>`;
    return;
  }

  list.innerHTML = disputes.map(d => `
    <div class="queue-item ${adminState.selectedDisputeId === d.id ? 'selected' : ''}" onclick="inspectDispute(${d.id})">
      <div class="queue-top">
        <span class="queue-id">${d.order_number}</span>
        <span class="pill pill-gold"><span class="dot"></span>${d.status}</span>
      </div>
      <div class="queue-title">${d.customer_name || d.customer_email}</div>
      <div class="queue-sub">${d.claim_reason.substring(0, 48)}...</div>
    </div>
  `).join('');
}

function inspectDispute(disputeId) {
  adminState.selectedDisputeId = disputeId;
  const d = adminState.disputes.find(item => item.id === disputeId);
  if (!d) return;

  switchTab('disputes');

  document.getElementById('disputeDetailTitle').textContent = `${d.order_number} Claim`;
  document.getElementById('disputeDetailBadge').textContent = d.status;

  const proofHtml = d.proof_attachment
    ? `<div class="proof"><img src="${d.proof_attachment}" alt="Customer Proof"></div>`
    : `<div class="proof">No screenshot attached</div>`;

  document.getElementById('disputeDetailBody').innerHTML = `
    <div class="detail-row"><span>Customer</span><span>${d.customer_name || d.customer_email}</span></div>
    <div class="detail-row"><span>Order Number</span><span class="mono">${d.order_number}</span></div>
    <div class="detail-row"><span>Total Order Amount</span><span style="color:var(--teal); font-weight:700;">₦${d.total_amount.toLocaleString()}</span></div>
    <div class="quote">"${escapeHtml(d.claim_reason)}"</div>
    ${proofHtml}
    <textarea class="reason-input" id="disputeDecisionNote" rows="2" placeholder="Note to customer (e.g. Approved replacement or Invalid claim)..."></textarea>
    <div style="display: flex; gap: 10px; margin-top: 14px;">
      <button class="btn btn-primary" style="flex: 1;" onclick="resolveDispute(${d.id}, 'approved_refunded')">Approve & Credit Wallet</button>
      <button class="btn btn-danger" style="flex: 1;" onclick="resolveDispute(${d.id}, 'rejected')">Reject Claim</button>
    </div>
  `;
}

async function resolveDispute(disputeId, decision) {
  const note = (document.getElementById('disputeDecisionNote') || {}).value || '';
  try {
    const res = await fetch(`/api/admin/disputes/${disputeId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, adminNotes: note })
    });
    const data = await res.json();
    if (data.success) {
      showAdminToast(`Dispute marked as ${decision === 'approved_refunded' ? 'Approved & Refunded' : 'Rejected'}!`, 'success');
      await loadDisputes();
      await loadMetrics();
    } else {
      showAdminToast(data.error || 'Resolution failed', 'error');
    }
  } catch (err) {
    showAdminToast('Network error resolving dispute', 'error');
  }
}

// ============================================================================
// Users Directory & Ledger
// ============================================================================

async function loadUsers() {
  try {
    const res = await fetch('/api/admin/users');
    const data = await res.json();
    if (data.success && data.users) {
      adminState.users = data.users;
      renderUsersTable(data.users);
    }
  } catch (err) {
    console.error('Failed to load users:', err);
  }
}

function renderUsersTable(users) {
  const tbody = document.getElementById('adminUsersTableBody');
  if (!tbody) return;
  if (!users.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:2rem; color:var(--text-faint);">No users found.</td></tr>`;
    return;
  }
  tbody.innerHTML = users.map(u => {
    const bal = u.walletBalance != null ? u.walletBalance : (u.balance != null ? u.balance : 0);
    const statusPill = u.is_banned
      ? '<span class="pill pill-danger"><span class="dot"></span>Suspended</span>'
      : '<span class="pill pill-teal"><span class="dot"></span>Active</span>';

    return `
      <tr>
        <td class="mono">#${u.id}</td>
        <td style="font-weight:600;">${escapeHtml(u.full_name || 'Customer')}</td>
        <td class="mono">${escapeHtml(u.email)}</td>
        <td><span class="pill ${u.role === 'admin' ? 'pill-gold' : 'pill-teal'}"><span class="dot"></span>${u.role}</span></td>
        <td style="font-weight:700; color:var(--teal);">₦${bal.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td>${statusPill}</td>
        <td class="mono">${new Date(u.created_at).toLocaleDateString()}</td>
        <td style="text-align:right;">
          <div style="display:flex; justify-content:flex-end; gap:6px; flex-wrap:wrap;">
            <button class="btn btn-teal btn-xs" onclick="openBalanceModal(${u.id})" title="Alter user balance">⚡ Alter Balance</button>
            ${u.role !== 'admin' ? `
              <button class="btn ${u.is_banned ? 'btn-teal' : 'btn-outline'} btn-xs" onclick="toggleUserBan(${u.id}, '${escapeHtml(u.email)}')" title="${u.is_banned ? 'Reactivate User' : 'Suspend User'}">
                ${u.is_banned ? 'Reactivate' : 'Suspend'}
              </button>
            ` : ''}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// ----------------------------------------------------------------------------
// Balance Alteration Handlers
// ----------------------------------------------------------------------------

function openBalanceModal(userId) {
  const user = adminState.users.find(u => u.id === userId);
  if (!user) return;
  const bal = user.walletBalance != null ? user.walletBalance : (user.balance != null ? user.balance : 0);

  document.getElementById('admBalanceUserId').value = user.id;
  document.getElementById('admBalanceUserName').textContent = user.full_name || 'Customer';
  document.getElementById('admBalanceUserTag').textContent = `#${user.id}`;
  document.getElementById('admBalanceUserEmail').textContent = user.email;
  document.getElementById('admBalanceCurrentBal').textContent = `₦${bal.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  document.getElementById('admBalanceAction').value = 'credit';
  document.getElementById('admBalanceAmount').value = '';
  document.getElementById('admBalanceReason').value = '';
  onBalanceActionChange();
  updateBalancePreview();
  openAdminModal('admBalanceModal');
}

function onBalanceActionChange() {
  const action = document.getElementById('admBalanceAction').value;
  const label = document.getElementById('admBalanceAmountLabel');
  const input = document.getElementById('admBalanceAmount');
  if (action === 'credit') {
    label.textContent = 'Amount to Add (₦) *';
    input.placeholder = 'e.g. 5000';
  } else if (action === 'debit') {
    label.textContent = 'Amount to Deduct (₦) *';
    input.placeholder = 'e.g. 2000';
  } else {
    label.textContent = 'New Total Target Balance (₦) *';
    input.placeholder = 'e.g. 10000';
  }
  updateBalancePreview();
}

function updateBalancePreview() {
  const userId = parseInt(document.getElementById('admBalanceUserId').value, 10);
  const user = adminState.users.find(u => u.id === userId);
  const currentBal = user ? (user.walletBalance != null ? user.walletBalance : (user.balance != null ? user.balance : 0)) : 0;
  const action = document.getElementById('admBalanceAction').value;
  const val = parseFloat(document.getElementById('admBalanceAmount').value) || 0;
  const previewEl = document.getElementById('admBalancePreview');

  let result = currentBal;
  if (action === 'credit') {
    result = currentBal + val;
  } else if (action === 'debit') {
    result = Math.max(0, currentBal - val);
  } else if (action === 'set') {
    result = Math.max(0, val);
  }

  previewEl.textContent = `₦${result.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function submitBalanceAdjustment() {
  const userId = parseInt(document.getElementById('admBalanceUserId').value, 10);
  const action = document.getElementById('admBalanceAction').value;
  const amountVal = parseFloat(document.getElementById('admBalanceAmount').value);
  const reason = (document.getElementById('admBalanceReason').value || '').trim();
  const btn = document.getElementById('btnSubmitBalance');

  if (isNaN(amountVal) || amountVal < 0) {
    showAdminToast('Please specify a valid numeric amount', 'error');
    return;
  }
  if (!reason) {
    showAdminToast('Please provide an audit note/reason for this balance adjustment', 'error');
    return;
  }

  try {
    btn.disabled = true;
    btn.textContent = 'Applying...';

    const payload = {
      action,
      amount: amountVal,
      newBalance: action === 'set' ? amountVal : undefined,
      reason
    };

    const res = await fetch(`/api/admin/users/${userId}/adjust-balance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (data.success) {
      showAdminToast(data.message || 'Balance updated successfully!', 'success');
      closeAdminModal('admBalanceModal');
      await loadUsers();
      await loadLedger();
      await loadMetrics();
    } else {
      showAdminToast(data.error || 'Failed to adjust balance', 'error');
    }
  } catch (err) {
    showAdminToast('Network error updating balance', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Apply Adjustment ⚡';
  }
}

async function toggleUserBan(userId, email) {
  const user = adminState.users.find(u => u.id === userId);
  if (!user) return;
  const actionName = user.is_banned ? 'reactivate' : 'suspend';
  if (!confirm(`Are you sure you want to ${actionName} user account ${email}?`)) {
    return;
  }

  try {
    const res = await fetch(`/api/admin/users/${userId}/toggle-ban`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showAdminToast(data.message || `User account ${actionName}d`, 'success');
      await loadUsers();
    } else {
      showAdminToast(data.error || 'Action failed', 'error');
    }
  } catch (err) {
    showAdminToast('Network error updating user status', 'error');
  }
}

// ============================================================================
// Administrator & Staff Management
// ============================================================================

async function loadAdmins() {
  try {
    const res = await fetch('/api/admin/administrators');
    const data = await res.json();
    if (data.success && data.administrators) {
      adminState.admins = data.administrators;
      renderAdminsTable(data.administrators);
    }
  } catch (err) {
    console.error('Failed to load administrators:', err);
  }
}

function renderAdminsTable(admins) {
  const tbody = document.getElementById('adminAdminsTableBody');
  if (!tbody) return;
  if (!admins.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:2rem; color:var(--text-faint);">No administrators found.</td></tr>`;
    return;
  }

  const currentAdminId = adminState.user ? adminState.user.id : null;

  tbody.innerHTML = admins.map(a => {
    const isSelf = a.id === currentAdminId;
    const isSuperAdmin = a.role === 'admin';
    const rolePill = isSuperAdmin
      ? '<span class="pill pill-gold"><span class="dot"></span>Super Admin</span>'
      : '<span class="pill pill-teal"><span class="dot"></span>Support</span>';

    const statusPill = a.is_banned
      ? '<span class="pill pill-danger"><span class="dot"></span>Suspended</span>'
      : '<span class="pill pill-teal"><span class="dot"></span>Active</span>';

    return `
      <tr>
        <td class="mono">#${a.id}</td>
        <td style="font-weight:600;">
          ${escapeHtml(a.full_name)}
          ${isSelf ? '<span style="font-size:10.5px; background:rgba(217,163,35,0.15); color:var(--gold); border:1px solid rgba(217,163,35,0.3); border-radius:4px; padding:1px 6px; margin-left:6px; font-weight:700;">YOU</span>' : ''}
        </td>
        <td class="mono">${escapeHtml(a.email)}</td>
        <td>${rolePill}</td>
        <td>${statusPill}</td>
        <td class="mono">${new Date(a.created_at).toLocaleDateString()}</td>
        <td style="text-align:right;">
          <div style="display:flex; justify-content:flex-end; gap:6px; flex-wrap:wrap;">
            <button class="btn btn-outline btn-xs" onclick="openResetAdminPasswordModal(${a.id})" title="Reset Password">🔑 Password</button>
            <button class="btn btn-outline btn-xs" onclick="openEditAdminModal(${a.id})" title="Edit Details">✏️ Edit</button>
            ${isSelf ? '' : `
              <button class="btn ${a.is_banned ? 'btn-teal' : 'btn-outline'} btn-xs" onclick="toggleAdminStatus(${a.id}, '${escapeHtml(a.email)}')" title="${a.is_banned ? 'Reactivate' : 'Suspend'}">
                ${a.is_banned ? 'Reactivate' : 'Suspend'}
              </button>
              <button class="btn btn-danger btn-xs" onclick="deleteAdminAccount(${a.id}, '${escapeHtml(a.email)}')" title="Delete Admin">🗑️</button>
            `}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function openCreateAdminModal() {
  document.getElementById('admNewAdminName').value = '';
  document.getElementById('admNewAdminEmail').value = '';
  document.getElementById('admNewAdminPhone').value = '';
  document.getElementById('admNewAdminRole').value = 'admin';
  document.getElementById('admNewAdminPassword').value = '';
  openAdminModal('admCreateAdminModal');
}

async function submitCreateAdmin() {
  const fullName = (document.getElementById('admNewAdminName').value || '').trim();
  const email = (document.getElementById('admNewAdminEmail').value || '').trim();
  const phone = (document.getElementById('admNewAdminPhone').value || '').trim();
  const role = document.getElementById('admNewAdminRole').value;
  const password = document.getElementById('admNewAdminPassword').value;
  const btn = document.getElementById('btnSubmitCreateAdmin');

  if (!fullName || !email || !password) {
    showAdminToast('Please fill in Name, Email, and Password', 'error');
    return;
  }
  if (password.length < 6) {
    showAdminToast('Password must be at least 6 characters', 'error');
    return;
  }

  try {
    btn.disabled = true;
    btn.textContent = 'Creating...';

    const res = await fetch('/api/admin/administrators', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullName, email, phone, role, password })
    });
    const data = await res.json();

    if (data.success) {
      showAdminToast(data.message || 'Administrator created successfully!', 'success');
      closeAdminModal('admCreateAdminModal');
      await loadAdmins();
    } else {
      showAdminToast(data.error || 'Failed to create administrator', 'error');
    }
  } catch (err) {
    showAdminToast('Network error creating administrator', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create Administrator 🛡️';
  }
}

function openResetAdminPasswordModal(id) {
  const admin = adminState.admins.find(a => a.id === id);
  if (!admin) return;

  document.getElementById('admResetAdminId').value = admin.id;
  document.getElementById('admResetAdminTarget').textContent = `${admin.full_name} (${admin.email})`;
  document.getElementById('admResetAdminPass').value = '';
  document.getElementById('admResetAdminPassConfirm').value = '';
  openAdminModal('admResetAdminPasswordModal');
}

async function submitResetAdminPassword() {
  const id = parseInt(document.getElementById('admResetAdminId').value, 10);
  const newPassword = document.getElementById('admResetAdminPass').value;
  const confirmPassword = document.getElementById('admResetAdminPassConfirm').value;
  const btn = document.getElementById('btnSubmitResetPass');

  if (!newPassword || newPassword.length < 6) {
    showAdminToast('Password must be at least 6 characters long', 'error');
    return;
  }
  if (newPassword !== confirmPassword) {
    showAdminToast('Passwords do not match', 'error');
    return;
  }

  try {
    btn.disabled = true;
    btn.textContent = 'Updating...';

    const res = await fetch(`/api/admin/administrators/${id}/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newPassword })
    });
    const data = await res.json();

    if (data.success) {
      showAdminToast(data.message || 'Password updated successfully!', 'success');
      closeAdminModal('admResetAdminPasswordModal');
    } else {
      showAdminToast(data.error || 'Failed to reset password', 'error');
    }
  } catch (err) {
    showAdminToast('Network error resetting password', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Update Password';
  }
}

function openEditAdminModal(id) {
  const admin = adminState.admins.find(a => a.id === id);
  if (!admin) return;

  document.getElementById('admEditAdminId').value = admin.id;
  document.getElementById('admEditAdminEmail').value = admin.email;
  document.getElementById('admEditAdminName').value = admin.full_name;
  document.getElementById('admEditAdminPhone').value = admin.phone || '';
  document.getElementById('admEditAdminRole').value = admin.role;
  openAdminModal('admEditAdminModal');
}

async function submitEditAdmin() {
  const id = parseInt(document.getElementById('admEditAdminId').value, 10);
  const fullName = (document.getElementById('admEditAdminName').value || '').trim();
  const phone = (document.getElementById('admEditAdminPhone').value || '').trim();
  const role = document.getElementById('admEditAdminRole').value;

  if (!fullName) {
    showAdminToast('Full Name is required', 'error');
    return;
  }

  try {
    const res = await fetch(`/api/admin/administrators/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullName, phone, role })
    });
    const data = await res.json();

    if (data.success) {
      showAdminToast(data.message || 'Administrator updated successfully!', 'success');
      closeAdminModal('admEditAdminModal');
      await loadAdmins();
    } else {
      showAdminToast(data.error || 'Failed to update administrator', 'error');
    }
  } catch (err) {
    showAdminToast('Network error updating administrator', 'error');
  }
}

async function toggleAdminStatus(id, email) {
  const admin = adminState.admins.find(a => a.id === id);
  if (!admin) return;
  const actionName = admin.is_banned ? 'reactivate' : 'suspend';

  if (!confirm(`Are you sure you want to ${actionName} administrator ${email}?`)) {
    return;
  }

  try {
    const res = await fetch(`/api/admin/administrators/${id}/toggle-status`, { method: 'POST' });
    const data = await res.json();

    if (data.success) {
      showAdminToast(data.message || `Administrator ${actionName}d!`, 'success');
      await loadAdmins();
    } else {
      showAdminToast(data.error || 'Failed to toggle status', 'error');
    }
  } catch (err) {
    showAdminToast('Network error toggling status', 'error');
  }
}

async function deleteAdminAccount(id, email) {
  if (!confirm(`Are you sure you want to PERMANENTLY DELETE administrator account ${email}? This action cannot be undone.`)) {
    return;
  }

  try {
    const res = await fetch(`/api/admin/administrators/${id}`, { method: 'DELETE' });
    const data = await res.json();

    if (data.success) {
      showAdminToast(data.message || 'Administrator deleted', 'success');
      await loadAdmins();
    } else {
      showAdminToast(data.error || 'Failed to delete administrator', 'error');
    }
  } catch (err) {
    showAdminToast('Network error deleting administrator', 'error');
  }
}

async function loadLedger() {
  try {
    const res = await fetch('/api/admin/ledger');
    const data = await res.json();
    if (data.success && data.transactions) {
      adminState.ledger = data.transactions;
      renderLedgerTable(data.transactions);
    }
  } catch (err) {
    console.error('Failed to load ledger:', err);
  }
}

function renderLedgerTable(transactions) {
  const tbody = document.getElementById('adminLedgerTableBody');
  if (!tbody) return;
  if (!transactions.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:2rem; color:var(--text-faint);">No ledger transactions recorded.</td></tr>`;
    return;
  }
  tbody.innerHTML = transactions.slice(0, 100).map(t => {
    const isCredit = t.type === 'funding' || t.type === 'refund' || t.type === 'credit' || t.type === 'deposit';
    const color = isCredit ? 'var(--teal)' : 'var(--text)';
    const prefix = isCredit ? '+' : '-';
    return `
      <tr>
        <td class="mono">#${t.id}</td>
        <td>${escapeHtml(t.user_email || t.description || 'User')}</td>
        <td><span class="pill ${isCredit ? 'pill-teal' : 'pill-muted'}"><span class="dot"></span>${t.type}</span></td>
        <td style="font-weight:700; color:${color};">${prefix}₦${t.amount.toLocaleString()}</td>
        <td class="mono">₦${t.balance_before.toLocaleString()}</td>
        <td class="mono">₦${t.balance_after.toLocaleString()}</td>
        <td class="mono">${escapeHtml(t.reference)}</td>
        <td class="mono">${new Date(t.created_at).toLocaleString()}</td>
      </tr>
    `;
  }).join('');
}

// ============================================================================
// Global Search & Modal Utilities
// ============================================================================

function handleAdminSearch(term) {
  const q = term.toLowerCase().trim();
  if (!q) {
    renderProductsTable(adminState.products);
    return;
  }
  const filtered = adminState.products.filter(p =>
    p.name.toLowerCase().includes(q) ||
    (p.category_name && p.category_name.toLowerCase().includes(q))
  );
  renderProductsTable(filtered);
}

function openAdminModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.add('open');
}

function closeAdminModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.remove('open');
}

function showAdminToast(msg, type = 'success') {
  const container = document.getElementById('adminToastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Email & SMTP Management ──────────────────────────────────────────────────

async function loadEmailSettings() {
  try {
    const res = await fetch('/api/admin/email/settings');
    const data = await res.json();
    if (!data.success) {
      console.warn('Could not fetch email settings:', data.error);
      return;
    }

    adminState.emailSettings = data.settings || {};

    // Map templates into state dictionary
    adminState.emailTemplates = {};
    if (Array.isArray(data.templates)) {
      data.templates.forEach(t => {
        adminState.emailTemplates[t.key] = t;
      });
    }

    // Populate SMTP Form
    const s = adminState.emailSettings;
    const hostEl = document.getElementById('admSmtpHost');
    const portEl = document.getElementById('admSmtpPort');
    const secureEl = document.getElementById('admSmtpSecure');
    const userEl = document.getElementById('admSmtpUser');
    const passEl = document.getElementById('admSmtpPass');
    const fromEl = document.getElementById('admEmailFrom');
    const fromNameEl = document.getElementById('admEmailFromName');

    if (hostEl) hostEl.value = s.host || '';
    if (portEl) portEl.value = s.port || 587;
    if (secureEl) secureEl.value = s.secure ? 'true' : 'false';
    if (userEl) userEl.value = s.user || '';
    if (passEl) passEl.value = s.pass || '';
    if (fromEl) fromEl.value = s.from || '';
    if (fromNameEl) fromNameEl.value = s.fromName || 'Olaslog';

    // Update Status Banner
    updateEmailStatusBanner(s);

    // Populate active template form
    populateTemplateForm(adminState.currentEmailTemplateKey || 'welcome');

    // Also check and load Telegram alerts status
    loadTelegramStatus();
  } catch (err) {
    console.error('loadEmailSettings error:', err);
  }
}

function updateEmailStatusBanner(s) {
  const badge = document.getElementById('emailSmtpBadge');
  const summary = document.getElementById('emailSmtpSummary');
  if (!badge || !summary) return;

  const isConfigured = Boolean(s.host && s.user && (s.hasPass || s.pass));
  if (isConfigured) {
    badge.className = 'pill pill-teal';
    badge.innerHTML = '<span class="dot"></span> SMTP Configured';
    summary.textContent = `Server: ${s.host}:${s.port} · Sender: "${s.fromName || 'Olaslog'}" <${s.from || s.user}>`;
  } else {
    badge.className = 'pill pill-danger';
    badge.innerHTML = '<span class="dot"></span> SMTP Not Configured';
    summary.textContent = 'Save your SMTP host, port, user & pass below to enable automated email delivery.';
  }
}

function togglePassVisibility(inputId) {
  const el = document.getElementById(inputId);
  if (!el) return;
  el.type = el.type === 'password' ? 'text' : 'password';
}

async function saveSmtpSettings() {
  const host = (document.getElementById('admSmtpHost')?.value || '').trim();
  const port = parseInt(document.getElementById('admSmtpPort')?.value || '587', 10);
  const secure = document.getElementById('admSmtpSecure')?.value === 'true';
  const user = (document.getElementById('admSmtpUser')?.value || '').trim();
  const pass = (document.getElementById('admSmtpPass')?.value || '').trim();
  const from = (document.getElementById('admEmailFrom')?.value || '').trim();
  const fromName = (document.getElementById('admEmailFromName')?.value || '').trim();

  const btn = document.getElementById('btnSaveSmtp');
  const btnTop = document.getElementById('btnSaveSmtpTop');
  if (btn) btn.textContent = 'Saving... ⏳';
  if (btnTop) btnTop.textContent = 'Saving... ⏳';

  try {
    const res = await fetch('/api/admin/email/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host, port, secure, user, pass, from, fromName })
    });
    const data = await res.json();
    if (data.success) {
      showAdminToast('SMTP Configuration saved successfully!', 'success');
      await loadEmailSettings();
    } else {
      showAdminToast(data.error || 'Failed to save SMTP settings', 'error');
    }
  } catch (err) {
    showAdminToast('Error saving settings: ' + err.message, 'error');
  } finally {
    if (btn) btn.textContent = 'Save SMTP';
    if (btnTop) btnTop.textContent = '💾 Save SMTP Settings';
  }
}

function selectTemplateTab(key) {
  adminState.currentEmailTemplateKey = key;

  // Highlight pill
  ['welcome', 'wallet_funded', 'purchase'].forEach(k => {
    const tab = document.getElementById(`tplTab-${k}`);
    const form = document.getElementById(`tplForm-${k}`);
    if (tab) tab.classList.toggle('active', k === key);
    if (form) form.style.display = k === key ? 'block' : 'none';
  });

  populateTemplateForm(key);
}

function populateTemplateForm(key) {
  const tpl = adminState.emailTemplates[key];
  if (!tpl) return;
  const extra = tpl.extra || {};

  if (key === 'welcome') {
    const sub = document.getElementById('tplWelcomeSubject');
    const head = document.getElementById('tplWelcomeHeadline');
    const body = document.getElementById('tplWelcomeBody');
    const s1 = document.getElementById('tplWelcomeStep1');
    const s2 = document.getElementById('tplWelcomeStep2');
    const s3 = document.getElementById('tplWelcomeStep3');
    const btn = document.getElementById('tplWelcomeBtnText');
    const foot = document.getElementById('tplWelcomeFooterNote');

    if (sub) sub.value = tpl.subject || '';
    if (head) head.value = tpl.headline || '';
    if (body) body.value = tpl.body || '';
    if (s1) s1.value = extra.step1 || '';
    if (s2) s2.value = extra.step2 || '';
    if (s3) s3.value = extra.step3 || '';
    if (btn) btn.value = extra.buttonText || '';
    if (foot) foot.value = extra.footerNote || '';
  } else if (key === 'wallet_funded') {
    const sub = document.getElementById('tplWalletSubject');
    const head = document.getElementById('tplWalletHeadline');
    const body = document.getElementById('tplWalletBody');
    const btn = document.getElementById('tplWalletBtnText');
    const foot = document.getElementById('tplWalletFooterNote');

    if (sub) sub.value = tpl.subject || '';
    if (head) head.value = tpl.headline || '';
    if (body) body.value = tpl.body || '';
    if (btn) btn.value = extra.buttonText || '';
    if (foot) foot.value = extra.footerNote || '';
  } else if (key === 'purchase') {
    const sub = document.getElementById('tplPurchaseSubject');
    const head = document.getElementById('tplPurchaseHeadline');
    const body = document.getElementById('tplPurchaseBody');
    const sec = document.getElementById('tplPurchaseSectionTitle');
    const btn = document.getElementById('tplPurchaseBtnText');
    const foot = document.getElementById('tplPurchaseFooterNote');

    if (sub) sub.value = tpl.subject || '';
    if (head) head.value = tpl.headline || '';
    if (body) body.value = tpl.body || '';
    if (sec) sec.value = extra.sectionTitle || '';
    if (btn) btn.value = extra.buttonText || '';
    if (foot) foot.value = extra.footerNote || '';
  }
}

async function saveCurrentTemplate() {
  const key = adminState.currentEmailTemplateKey || 'welcome';
  let payload = {};

  if (key === 'welcome') {
    payload = {
      subject: document.getElementById('tplWelcomeSubject')?.value,
      headline: document.getElementById('tplWelcomeHeadline')?.value,
      body: document.getElementById('tplWelcomeBody')?.value,
      extra: {
        step1: document.getElementById('tplWelcomeStep1')?.value,
        step2: document.getElementById('tplWelcomeStep2')?.value,
        step3: document.getElementById('tplWelcomeStep3')?.value,
        buttonText: document.getElementById('tplWelcomeBtnText')?.value,
        footerNote: document.getElementById('tplWelcomeFooterNote')?.value
      }
    };
  } else if (key === 'wallet_funded') {
    payload = {
      subject: document.getElementById('tplWalletSubject')?.value,
      headline: document.getElementById('tplWalletHeadline')?.value,
      body: document.getElementById('tplWalletBody')?.value,
      extra: {
        buttonText: document.getElementById('tplWalletBtnText')?.value,
        footerNote: document.getElementById('tplWalletFooterNote')?.value
      }
    };
  } else if (key === 'purchase') {
    payload = {
      subject: document.getElementById('tplPurchaseSubject')?.value,
      headline: document.getElementById('tplPurchaseHeadline')?.value,
      body: document.getElementById('tplPurchaseBody')?.value,
      extra: {
        sectionTitle: document.getElementById('tplPurchaseSectionTitle')?.value,
        buttonText: document.getElementById('tplPurchaseBtnText')?.value,
        footerNote: document.getElementById('tplPurchaseFooterNote')?.value
      }
    };
  }

  const btn = document.getElementById('btnSaveTemplate');
  const btnBottom = document.getElementById('btnSaveTemplateBottom');
  if (btn) btn.textContent = 'Saving...';
  if (btnBottom) btnBottom.textContent = 'Saving...';

  try {
    const res = await fetch(`/api/admin/email/templates/${key}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success && data.template) {
      adminState.emailTemplates[key] = data.template;
      showAdminToast(`Template saved successfully!`, 'success');
      populateTemplateForm(key);
    } else {
      showAdminToast(data.error || 'Failed to save template', 'error');
    }
  } catch (err) {
    showAdminToast('Error saving template: ' + err.message, 'error');
  } finally {
    if (btn) btn.textContent = 'Save Template';
    if (btnBottom) btnBottom.textContent = '💾 Save Template Changes';
  }
}

async function resetCurrentTemplate() {
  const key = adminState.currentEmailTemplateKey || 'welcome';
  const name = adminState.emailTemplates[key]?.name || key;
  if (!confirm(`Are you sure you want to reset "${name}" back to factory default content?`)) {
    return;
  }

  try {
    const res = await fetch(`/api/admin/email/templates/${key}/reset`, {
      method: 'POST'
    });
    const data = await res.json();
    if (data.success && data.template) {
      adminState.emailTemplates[key] = data.template;
      populateTemplateForm(key);
      showAdminToast(`"${name}" reset to factory default`, 'success');
    } else {
      showAdminToast(data.error || 'Failed to reset template', 'error');
    }
  } catch (err) {
    showAdminToast('Error resetting template: ' + err.message, 'error');
  }
}

function openTestEmailModal(defaultKey = null) {
  const key = defaultKey || adminState.currentEmailTemplateKey || 'welcome';
  const select = document.getElementById('admTestTemplateSelect');
  if (select) select.value = key;

  const emailInput = document.getElementById('admTestRecipientEmail');
  if (emailInput && !emailInput.value) {
    emailInput.value = adminState.user?.email || '';
  }

  const resultBox = document.getElementById('admTestEmailResult');
  if (resultBox) {
    resultBox.style.display = 'none';
    resultBox.innerHTML = '';
  }

  openAdminModal('admTestEmailModal');
}

async function executeSendTestEmail() {
  const select = document.getElementById('admTestTemplateSelect');
  const emailInput = document.getElementById('admTestRecipientEmail');
  const resultBox = document.getElementById('admTestEmailResult');
  const btn = document.getElementById('btnExecuteSendTest');

  const templateKey = select?.value;
  const recipientEmail = (emailInput?.value || '').trim();

  if (!recipientEmail || !recipientEmail.includes('@')) {
    showAdminToast('Please provide a valid recipient email address', 'error');
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Sending Test Email... ⏳';
  }
  if (resultBox) {
    resultBox.style.display = 'none';
  }

  try {
    const res = await fetch('/api/admin/email/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateKey, recipientEmail })
    });
    const data = await res.json();

    if (resultBox) {
      resultBox.style.display = 'block';
      if (data.success) {
        resultBox.style.background = 'rgba(99, 211, 138, 0.12)';
        resultBox.style.border = '1px solid rgba(99, 211, 138, 0.3)';
        resultBox.style.color = '#63d38a';
        resultBox.innerHTML = `
          <strong>✅ Test Email Dispatched!</strong><br/>
          Delivered <strong>${templateKey}</strong> email to <strong>${recipientEmail}</strong>.<br/>
          <span style="font-size: 11px; opacity: 0.85;">Message ID: ${data.result?.messageId || 'SENT'}</span>
        `;
        showAdminToast('Test email sent successfully! Check your inbox.', 'success');
      } else {
        resultBox.style.background = 'rgba(226, 105, 94, 0.12)';
        resultBox.style.border = '1px solid rgba(226, 105, 94, 0.3)';
        resultBox.style.color = '#E2695E';
        resultBox.innerHTML = `
          <strong>❌ Delivery Error:</strong><br/>
          ${escapeHtml(data.error || 'Failed to send test email')}<br/>
          <span style="font-size: 11px; opacity: 0.85;">Please verify your SMTP Host, Port, User, and Password in the settings.</span>
        `;
        showAdminToast(data.error || 'Delivery failed', 'error');
      }
    }
  } catch (err) {
    if (resultBox) {
      resultBox.style.display = 'block';
      resultBox.style.background = 'rgba(226, 105, 94, 0.12)';
      resultBox.style.border = '1px solid rgba(226, 105, 94, 0.3)';
      resultBox.style.color = '#E2695E';
      resultBox.textContent = 'Network error: ' + err.message;
    }
    showAdminToast('Network error: ' + err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Send Test Message 🚀';
    }
  }
}

function previewCurrentTemplate() {
  const key = adminState.currentEmailTemplateKey || 'welcome';
  const logoUrl = '/assets/olaslog-logo-primary.png';

  let subject = '';
  let headline = '';
  let body = '';
  let dynamicHtml = '';

  if (key === 'welcome') {
    subject = document.getElementById('tplWelcomeSubject')?.value || 'Welcome to Olaslog!';
    headline = document.getElementById('tplWelcomeHeadline')?.value || 'Welcome to Olaslog! 🎉';
    body = document.getElementById('tplWelcomeBody')?.value || '';
    const s1 = document.getElementById('tplWelcomeStep1')?.value;
    const s2 = document.getElementById('tplWelcomeStep2')?.value;
    const s3 = document.getElementById('tplWelcomeStep3')?.value;
    const btn = document.getElementById('tplWelcomeBtnText')?.value || 'Go to My Wallet →';
    const foot = document.getElementById('tplWelcomeFooterNote')?.value || '';

    const steps = [s1, s2, s3].filter(Boolean);
    dynamicHtml = `
      <hr style="border:none;border-top:1px solid rgba(255,255,255,0.06);margin:24px 0;"/>
      <p style="margin:0 0 12px;font-size:14px;font-weight:600;color:#d1d5db;">🚀 Get started in 3 steps:</p>
      ${steps.map((s, i) => `
        <div style="display:flex;gap:12px;margin-bottom:8px;font-size:13.5px;color:#9ca3af;">
          <span style="display:inline-block;width:24px;height:24px;line-height:24px;text-align:center;background:rgba(99,211,138,0.15);color:#63d38a;border-radius:50%;font-weight:700;font-size:12px;">${i + 1}</span>
          <span>${escapeHtml(s)}</span>
        </div>
      `).join('')}
      <div style="margin:26px 0;">
        <span style="display:inline-block;background:linear-gradient(135deg,#63d38a,#3fbf6a);padding:12px 28px;border-radius:8px;font-weight:700;color:#0f1117;font-size:14px;">${escapeHtml(btn)}</span>
      </div>
      <p style="margin:0;font-size:12.5px;color:#6b7280;">${escapeHtml(foot)}</p>
    `;
  } else if (key === 'wallet_funded') {
    subject = document.getElementById('tplWalletSubject')?.value || 'Your wallet has been credited 💚';
    headline = document.getElementById('tplWalletHeadline')?.value || 'Wallet Funded Successfully 💚';
    body = document.getElementById('tplWalletBody')?.value || '';
    const btn = document.getElementById('tplWalletBtnText')?.value || 'Shop Now →';
    const foot = document.getElementById('tplWalletFooterNote')?.value || '';

    dynamicHtml = `
      <div style="background:#0f1117;border:1px solid rgba(99,211,138,0.25);border-radius:12px;padding:18px 22px;margin:20px 0;">
        <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Amount Credited</div>
        <div style="font-size:26px;font-weight:800;color:#63d38a;margin-top:2px;">₦10,000.00</div>
      </div>
      <div style="margin:26px 0;">
        <span style="display:inline-block;background:linear-gradient(135deg,#63d38a,#3fbf6a);padding:12px 28px;border-radius:8px;font-weight:700;color:#0f1117;font-size:14px;">${escapeHtml(btn)}</span>
      </div>
      <p style="margin:0;font-size:12.5px;color:#6b7280;">${escapeHtml(foot)}</p>
    `;
  } else if (key === 'purchase') {
    subject = document.getElementById('tplPurchaseSubject')?.value || 'Order Delivered ✅';
    headline = document.getElementById('tplPurchaseHeadline')?.value || 'Order Delivered! ✅';
    body = document.getElementById('tplPurchaseBody')?.value || '';
    const sec = document.getElementById('tplPurchaseSectionTitle')?.value || '📦 Delivered Credentials';
    const btn = document.getElementById('tplPurchaseBtnText')?.value || 'View My Orders →';
    const foot = document.getElementById('tplPurchaseFooterNote')?.value || '';

    dynamicHtml = `
      <div style="background:#0f1117;border:1px solid rgba(99,211,138,0.25);border-radius:12px;padding:18px 22px;margin:20px 0;">
        <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Total Charged</div>
        <div style="font-size:26px;font-weight:800;color:#63d38a;margin-top:2px;">₦4,500.00</div>
      </div>
      <div style="margin:20px 0;">
        <div style="font-size:13.5px;font-weight:700;color:#f9fafb;margin-bottom:10px;">${escapeHtml(sec)}</div>
        <div style="background:#0f1117;border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px;">
          <strong style="color:#f9fafb;font-size:13px;">Google Voice US (Aged 2023)</strong>
          <div style="margin:6px 0;"><code style="color:#63d38a;background:rgba(0,0,0,0.5);padding:4px 8px;border-radius:4px;font-family:monospace;font-size:12px;">user@gmail.com:StrongPassword123:recovery@olaslog.com</code></div>
          <div style="font-size:11px;color:#6b7280;">Account #10928</div>
        </div>
      </div>
      <div style="margin:26px 0;">
        <span style="display:inline-block;background:linear-gradient(135deg,#63d38a,#3fbf6a);padding:12px 28px;border-radius:8px;font-weight:700;color:#0f1117;font-size:14px;">${escapeHtml(btn)}</span>
      </div>
      <p style="margin:0;font-size:12.5px;color:#6b7280;">${escapeHtml(foot)}</p>
    `;
  }

  const fullHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
</head>
<body style="margin:0;padding:24px 16px;background:#0f1117;font-family:'Segoe UI',Arial,sans-serif;color:#d1d5db;">
  <div style="max-width:540px;margin:0 auto;background:#161b27;border-radius:14px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,0.5);">
    <div style="background:linear-gradient(135deg,#1a2236,#0f1117);padding:24px 32px;border-bottom:1px solid rgba(99,211,138,0.15);">
      <img src="${logoUrl}" alt="Olaslog" width="130" style="display:block;max-height:42px;"/>
    </div>
    <div style="padding:32px 30px;">
      <p style="margin:0 0 16px;font-size:15px;color:#d1d5db;">Hi <strong style="color:#f9fafb;">Alex</strong>,</p>
      <h1 style="margin:0 0 14px;font-size:22px;font-weight:800;color:#f9fafb;line-height:1.3;">${escapeHtml(headline)}</h1>
      <p style="margin:0 0 16px;font-size:14.5px;color:#9ca3af;line-height:1.7;">${escapeHtml(body)}</p>
      ${dynamicHtml}
    </div>
    <div style="background:#0f1117;padding:20px 30px;border-top:1px solid rgba(255,255,255,0.06);font-size:11px;color:#4b5563;">
      © ${new Date().getFullYear()} Olaslog · Instant Digital Products Marketplace
    </div>
  </div>
</body>
</html>`;

  const subjectEl = document.getElementById('admEmailPreviewSubject');
  const frame = document.getElementById('admEmailPreviewFrame');
  if (subjectEl) subjectEl.textContent = subject;
  if (frame) frame.srcdoc = fullHtml;

  openAdminModal('admEmailPreviewModal');
}

// ─── Telegram Bot Alerts Admin Management ────────────────────────────────────

async function loadTelegramStatus() {
  try {
    const res = await fetch('/api/admin/telegram/status');
    const data = await res.json();
    const badge = document.getElementById('tgAdminBadge');
    const summary = document.getElementById('tgAdminSummary');
    if (!badge) return;

    if (data.configured) {
      badge.className = 'pill pill-teal';
      badge.innerHTML = '<span class="dot"></span> Bot Active';
      if (summary) {
        summary.textContent = `Connected to Chat ID: ${data.chatId || 'Configured'} · Real-time alerts enabled.`;
      }
    } else {
      badge.className = 'pill pill-danger';
      badge.innerHTML = '<span class="dot"></span> Not Configured';
      if (summary) {
        summary.textContent = 'Add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to your .env file to enable instant mobile alerts.';
      }
    }
  } catch (err) {
    console.warn('loadTelegramStatus error:', err);
  }
}

async function sendTestTelegramAlert() {
  const btnTop = document.getElementById('btnTestTgTop');
  const btnCard = document.getElementById('btnTestTgAlert');
  const btns = [btnTop, btnCard].filter(Boolean);

  btns.forEach(b => {
    b.disabled = true;
    b.textContent = 'Sending ping... ⏳';
  });

  try {
    const res = await fetch('/api/admin/telegram/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json();

    if (data.success) {
      showAdminToast(data.message || 'Telegram test message delivered!', 'success');
    } else {
      showAdminToast(data.error || 'Failed to send Telegram test message', 'error');
    }
  } catch (err) {
    showAdminToast('Network error triggering Telegram test: ' + err.message, 'error');
  } finally {
    if (btnTop) {
      btnTop.disabled = false;
      btnTop.textContent = '✈️ Test Telegram';
    }
    if (btnCard) {
      btnCard.disabled = false;
      btnCard.textContent = '⚡ Send Test Telegram Ping';
    }
    loadTelegramStatus();
  }
}

// ─── Sales Analytics & Revenue Intelligence ───────────────────────────────────

adminState.analyticsDays = 30;

function setAnalyticsDays(days, el) {
  adminState.analyticsDays = days;
  document.querySelectorAll('.adm-analytics-time-btn').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  loadSalesAnalytics(days);
}

async function loadSalesAnalytics(days = null) {
  const d = days || adminState.analyticsDays || 30;
  const chartBox = document.getElementById('anRevenueChartContainer');
  const topList = document.getElementById('anTopProductsList');

  if (chartBox) {
    chartBox.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-faint);font-size:13px;">Loading sales analytics... ⏳</div>';
  }

  try {
    const res = await fetch(`/api/admin/analytics?days=${d}`);
    const data = await res.json();
    if (!data.success) {
      if (chartBox) chartBox.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--danger);font-size:13px;">Failed to load analytics data.</div>';
      return;
    }

    const a = data.analytics;
    const s = a.summary || {};

    // Update KPI Tiles
    const revEl = document.getElementById('anKpiRevenue');
    const aovEl = document.getElementById('anKpiAov');
    const convEl = document.getElementById('anKpiConvRate');
    const payingEl = document.getElementById('anPayingUsers');
    const totUsersEl = document.getElementById('anTotalUsers');
    const repEl = document.getElementById('anKpiRepeatRate');
    const repBuyersEl = document.getElementById('anRepeatBuyers');
    const chartTotEl = document.getElementById('anChartTotalPeriod');

    if (revEl) revEl.textContent = Number(s.totalRevenue || 0).toLocaleString('en-NG', { minimumFractionDigits: 2 });
    if (aovEl) aovEl.textContent = Number(s.avgOrderValue || 0).toLocaleString('en-NG', { minimumFractionDigits: 2 });
    if (convEl) convEl.textContent = s.conversionRate || 0;
    if (payingEl) payingEl.textContent = s.payingCustomers || 0;
    if (totUsersEl) totUsersEl.textContent = s.totalCustomers || 0;
    if (repEl) repEl.textContent = s.repeatPurchaseRate || 0;
    if (repBuyersEl) repBuyersEl.textContent = s.repeatBuyers || 0;

    const periodTotal = (a.dailyRevenue || []).reduce((sum, item) => sum + (Number(item.revenue) || 0), 0);
    if (chartTotEl) chartTotEl.textContent = `Period: ₦${periodTotal.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;

    // Render Daily Revenue SVG Chart
    renderDailyRevenueChart(a.dailyRevenue || []);

    // Render Top Products List
    renderAnalyticsTopProducts(a.topProducts || []);

    // Render Conversion Funnel
    renderAnalyticsFunnel(s);

    // Render Payment Breakdown
    renderAnalyticsPaymentBreakdown(a.paymentBreakdown || {});
  } catch (err) {
    console.error('loadSalesAnalytics error:', err);
    if (chartBox) chartBox.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--danger);font-size:13px;">Error loading chart data.</div>';
  }
}

function renderDailyRevenueChart(dailyData) {
  const container = document.getElementById('anRevenueChartContainer');
  if (!container) return;

  if (!dailyData.length) {
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-faint);font-size:13px;">No sales data available for this timeframe.</div>';
    return;
  }

  const maxVal = Math.max(...dailyData.map(d => d.revenue), 1000);
  const width = 640;
  const height = 190;
  const padLeft = 60;
  const padRight = 20;
  const padTop = 20;
  const padBottom = 35;
  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;

  const points = dailyData.map((d, i) => {
    const x = padLeft + (i / Math.max(dailyData.length - 1, 1)) * chartW;
    const y = padTop + chartH - (d.revenue / maxVal) * chartH;
    return { x, y, ...d };
  });

  const polylineStr = points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const areaPolygonStr = `${padLeft},${padTop + chartH} ` + polylineStr + ` ${padLeft + chartW},${padTop + chartH}`;

  // Y-axis grid ticks
  const ticks = [0, 0.33, 0.66, 1].map(ratio => {
    const y = padTop + chartH - ratio * chartH;
    const val = Math.round(ratio * maxVal);
    let label = `₦${val}`;
    if (val >= 1000000) label = `₦${(val / 1000000).toFixed(1)}M`;
    else if (val >= 1000) label = `₦${(val / 1000).toFixed(0)}k`;
    return `<line x1="${padLeft}" y1="${y}" x2="${padLeft + chartW}" y2="${y}" stroke="rgba(255,255,255,0.06)" stroke-dasharray="3 3"/>
            <text x="${padLeft - 8}" y="${y + 4}" fill="#6b7280" font-size="10" text-anchor="end" font-family="monospace">${label}</text>`;
  }).join('');

  // X-axis sample date labels (approx 5-6 evenly spaced labels)
  const step = Math.max(Math.floor(dailyData.length / 5), 1);
  const dateLabels = points.filter((_, idx) => idx % step === 0 || idx === points.length - 1).map(p => `
    <text x="${p.x}" y="${height - 8}" fill="#6b7280" font-size="10" text-anchor="middle" font-family="'Segoe UI',sans-serif">${p.label}</text>
  `).join('');

  // Interactive circles
  const circles = points.map(p => `
    <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" fill="#63d38a" stroke="#0f1117" stroke-width="2" style="cursor:pointer;transition:transform 0.15s ease;">
      <title>${p.label}: ₦${Number(p.revenue).toLocaleString()} (${p.orders} order${p.orders === 1 ? '' : 's'})</title>
    </circle>
  `).join('');

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" style="width:100%;height:100%;display:block;overflow:visible;">
      <defs>
        <linearGradient id="anRevenueGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#63d38a" stop-opacity="0.35"/>
          <stop offset="100%" stop-color="#63d38a" stop-opacity="0.0"/>
        </linearGradient>
      </defs>
      ${ticks}
      <polygon points="${areaPolygonStr}" fill="url(#anRevenueGrad)"/>
      <polyline points="${polylineStr}" fill="none" stroke="#63d38a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      ${circles}
      ${dateLabels}
    </svg>
  `;
}

function renderAnalyticsTopProducts(products) {
  const container = document.getElementById('anTopProductsList');
  if (!container) return;

  if (!products.length) {
    container.innerHTML = '<div style="color:var(--text-faint);font-size:12.5px;padding:12px;text-align:center;">No completed sales yet.</div>';
    return;
  }

  const maxRev = Math.max(...products.map(p => p.total_revenue), 1);

  container.innerHTML = products.map((p, idx) => {
    const rank = idx + 1;
    const pct = Math.round((p.total_revenue / maxRev) * 100);
    const badgeColor = rank === 1 ? '#f59e0b' : (rank === 2 ? '#9ca3af' : (rank === 3 ? '#b45309' : 'var(--text-dim)'));

    return `
      <div style="background:rgba(255,255,255,0.02);border:1px solid var(--edge);border-radius:8px;padding:10px 12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <div style="display:flex;align-items:center;gap:8px;overflow:hidden;">
            <span style="font-size:11px;font-weight:800;color:${badgeColor};min-width:18px;">#${rank}</span>
            <span style="font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${p.name}</span>
          </div>
          <div style="font-weight:700;font-size:13px;color:var(--teal);flex-shrink:0;">
            ₦${Number(p.total_revenue).toLocaleString()}
          </div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;color:var(--text-faint);margin-bottom:4px;">
          <span>${p.category_icon || '📱'} ${p.category_name || 'Category'}</span>
          <span>${p.units_sold} unit${p.units_sold === 1 ? '' : 's'} sold</span>
        </div>
        <div style="width:100%;height:4px;background:rgba(255,255,255,0.06);border-radius:2px;overflow:hidden;">
          <div style="width:${pct}%;height:100%;background:linear-gradient(90deg,var(--teal),#3fbf6a);border-radius:2px;"></div>
        </div>
      </div>
    `;
  }).join('');
}

function renderAnalyticsFunnel(s) {
  const container = document.getElementById('anFunnelContainer');
  if (!container) return;

  const totalUsers = Math.max(s.totalCustomers || 0, 1);
  const payingUsers = s.payingCustomers || 0;
  const repeatUsers = s.repeatBuyers || 0;

  const steps = [
    { label: 'Registered Customers', count: s.totalCustomers || 0, sub: 'Total registered client accounts', pct: 100, color: '#38bdf8' },
    { label: 'Completed First Purchase', count: payingUsers, sub: `${s.conversionRate || 0}% overall customer conversion`, pct: Math.round((payingUsers / totalUsers) * 100), color: '#63d38a' },
    { label: 'Repeat Buyers (>1 Order)', count: repeatUsers, sub: `${s.repeatPurchaseRate || 0}% retention rate`, pct: Math.round((repeatUsers / totalUsers) * 100), color: '#f59e0b' }
  ];

  container.innerHTML = steps.map(st => `
    <div style="background:rgba(255,255,255,0.02);border:1px solid var(--edge);border-radius:10px;padding:12px 14px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <span style="font-weight:600;font-size:13px;color:var(--text);">${st.label}</span>
        <span style="font-weight:800;font-size:13.5px;color:${st.color};">${st.count.toLocaleString()}</span>
      </div>
      <div style="font-size:11.5px;color:var(--text-faint);margin-bottom:6px;">${st.sub}</div>
      <div style="width:100%;height:6px;background:rgba(255,255,255,0.06);border-radius:3px;overflow:hidden;">
        <div style="width:${Math.max(st.pct, 4)}%;height:100%;background:${st.color};border-radius:3px;"></div>
      </div>
    </div>
  `).join('');
}

function renderAnalyticsPaymentBreakdown(pb) {
  const container = document.getElementById('anPaymentBreakdownContainer');
  if (!container) return;

  const funded = Number(pb.fundedVolume || 0);
  const purchased = Number(pb.purchaseVolume || 0);
  const total = Math.max(funded + purchased, 1);

  const fundedPct = Math.round((funded / total) * 100);
  const purchasePct = Math.round((purchased / total) * 100);

  container.innerHTML = `
    <div style="background:rgba(255,255,255,0.02);border:1px solid var(--edge);border-radius:10px;padding:14px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:16px;">🏦</span>
          <span style="font-weight:600;font-size:13px;color:var(--text);">Virtual Bank Account Deposits</span>
        </div>
        <span style="font-weight:800;font-size:14px;color:var(--teal);">₦${funded.toLocaleString()}</span>
      </div>
      <div style="font-size:11.5px;color:var(--text-faint);margin-bottom:8px;">${pb.fundedCount || 0} successful wallet credit transactions</div>
      <div style="width:100%;height:6px;background:rgba(255,255,255,0.06);border-radius:3px;overflow:hidden;">
        <div style="width:${fundedPct}%;height:100%;background:var(--teal);border-radius:3px;"></div>
      </div>
    </div>

    <div style="background:rgba(255,255,255,0.02);border:1px solid var(--edge);border-radius:10px;padding:14px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:16px;">🛍️</span>
          <span style="font-weight:600;font-size:13px;color:var(--text);">Marketplace Checkout Spend</span>
        </div>
        <span style="font-weight:800;font-size:14px;color:var(--gold);">₦${purchased.toLocaleString()}</span>
      </div>
      <div style="font-size:11.5px;color:var(--text-faint);margin-bottom:8px;">${pb.purchaseCount || 0} order debits settled instantly via wallet</div>
      <div style="width:100%;height:6px;background:rgba(255,255,255,0.06);border-radius:3px;overflow:hidden;">
        <div style="width:${purchasePct}%;height:100%;background:var(--gold);border-radius:3px;"></div>
      </div>
    </div>
  `;
}

