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
  ledger: [],
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
  await loadLedger();
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
    ledger: 'Financial Ledger Audit'
  };
  document.getElementById('pageTitle').textContent = titles[tabKey] || 'Operations';

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
      document.getElementById('kpiSujanBal').textContent = (m.sujanBalance || 0).toLocaleString();
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
    const wholesale = p.sujan_cost ? `₦${p.sujan_cost.toLocaleString()}` : '<span style="color:var(--text-faint);">N/A</span>';
    const isOverride = p.is_custom_price === 1;
    const modeBadge = isOverride
      ? `<span class="pill pill-gold"><span class="dot"></span>Manual</span>`
      : `<span class="pill pill-teal"><span class="dot"></span>Auto +₦1,000</span>`;
    const stockPill = p.stock_count > 0
      ? `<span class="pill pill-teal"><span class="dot"></span>${p.stock_count} in stock</span>`
      : `<span class="pill pill-danger"><span class="dot"></span>Out of stock</span>`;

    return `
      <tr class="row-clickable">
        <td>
          <div class="cell-title">${p.name}</div>
          <div class="cell-sub mono">#${p.id} • ${p.sujan_product_id ? `Sujan #${p.sujan_product_id}` : 'Local'}</div>
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
  btn.disabled = true;
  btn.textContent = 'Syncing...';
  try {
    const res = await fetch('/api/admin/products/sync-sujan', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showAdminToast(data.message || 'Catalog synced successfully!', 'success');
      await loadProducts();
      await loadMetrics();
    } else {
      showAdminToast(data.error || 'Failed to sync catalog', 'error');
    }
  } catch (err) {
    showAdminToast('Network error triggering sync', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄 Sync Live Catalog';
  }
}

// Manual Price Modal
function openPriceModal(productId) {
  const product = adminState.products.find(p => p.id === productId);
  if (!product) return;

  document.getElementById('admPriceProductId').value = product.id;
  document.getElementById('admPriceProductName').textContent = product.name;
  document.getElementById('admPriceProductCategory').textContent = product.category_name || 'General';
  document.getElementById('admPriceSujanBase').textContent = product.sujan_cost ? `₦${product.sujan_cost.toLocaleString()}` : '₦0';
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
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:2rem; color:var(--text-faint);">No users found.</td></tr>`;
    return;
  }
  tbody.innerHTML = users.map(u => {
    const bal = u.walletBalance != null ? u.walletBalance : (u.balance != null ? u.balance : 0);
    return `
      <tr>
        <td class="mono">#${u.id}</td>
        <td style="font-weight:600;">${escapeHtml(u.full_name || 'Customer')}</td>
        <td class="mono">${escapeHtml(u.email)}</td>
        <td><span class="pill ${u.role === 'admin' ? 'pill-gold' : 'pill-teal'}"><span class="dot"></span>${u.role}</span></td>
        <td style="font-weight:700; color:var(--teal);">₦${bal.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td class="mono">${new Date(u.created_at).toLocaleDateString()}</td>
      </tr>
    `;
  }).join('');
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
    const isCredit = t.type === 'deposit' || t.type === 'refund';
    const color = isCredit ? 'var(--teal)' : 'var(--text)';
    const prefix = isCredit ? '+' : '-';
    return `
      <tr>
        <td class="mono">#${t.id}</td>
        <td>${t.user_email}</td>
        <td><span class="pill ${isCredit ? 'pill-teal' : 'pill-muted'}"><span class="dot"></span>${t.type}</span></td>
        <td style="font-weight:700; color:${color};">${prefix}₦${t.amount.toLocaleString()}</td>
        <td class="mono">₦${t.balance_before.toLocaleString()}</td>
        <td class="mono">₦${t.balance_after.toLocaleString()}</td>
        <td class="mono">${t.reference}</td>
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
