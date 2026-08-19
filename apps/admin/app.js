const root = document.querySelector('#admin-app');
const state = {
  token: sessionStorage.getItem('xiuxian_admin_token') ?? '',
  user: null,
  view: 'overview',
  dashboard: null,
  products: [],
  categories: [],
  orders: [],
  users: [],
  webhookFailures: [],
  settings: null,
  paymentNotice: null,
  paymentSaving: false,
  ordersFilter: 'all',
  balanceTarget: null,
  balanceEntriesTarget: null,
  categoryEditor: null,
  version: null,
  editingProductId: null,
  credentials: [],
  connections: [],
  secretReveal: null,
  refundTarget: null,
  message: '',
  settingsNotice: null,
  storeNotice: null,
};

const icons = {
  overview: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  products: '<svg viewBox="0 0 24 24"><path d="M4 5h16v14H4z"/><path d="M8 9h8M8 13h5"/></svg>',
  inventory: '<svg viewBox="0 0 24 24"><path d="M4 7h16v13H4z"/><path d="m4 7 3-4h10l3 4M8 11h8"/></svg>',
  orders: '<svg viewBox="0 0 24 24"><path d="M4 3h16v18l-3-2-3 2-3-2-3 2-3-2V3Z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
  users: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><path d="M3 20c0-4 2-7 6-7s6 3 6 7M16 4a3 3 0 0 1 0 6M17 13c3 0 4 3 4 7"/></svg>',
  external: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/><circle cx="12" cy="12" r="4"/></svg>',
  payments: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h4"/></svg>',
  integration: '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>',
};

function esc(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}
function money(fen) { return `¥${(Number(fen) / 100).toFixed(2)}`; }
function priceToFen(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error('价格必须是最多两位小数的正数。');
  const [whole, fraction = ''] = text.split('.');
  const fen = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(fen) || fen < 1) throw new Error('价格必须大于 0。');
  return fen;
}
function statusLabel(status) {
  return {
    active: '销售中', draft: '草稿', archived: '已归档', pending_payment: '待支付',
    payment_confirming: '确认中', paid: '已支付', fulfilling: '发卡中', completed: '已完成',
    payment_expired: '已过期', canceled: '已关闭', fulfillment_failed: '发卡异常', refunded: '已退款',
  }[status] ?? status;
}
function statusClass(status) { return ['draft', 'archived', 'canceled', 'payment_expired'].includes(status) ? status : ''; }

async function api(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (state.token) headers.set('Authorization', `Bearer ${state.token}`);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...options, headers });
  const payload = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
  if (response.status === 401) {
    state.token = '';
    state.user = null;
    sessionStorage.removeItem('xiuxian_admin_token');
  }
  if (!response.ok) {
    const error = new Error(payload?.error?.message ?? '请求失败。');
    error.status = response.status;
    error.code = payload?.error?.code;
    throw error;
  }
  return payload;
}

async function login(username, password) {
  if (state.token) {
    try {
      state.user = await api('/api/me');
      if (!state.user.isAdmin) throw new Error('当前账号不是管理员。');
      return true;
    } catch { state.token = ''; sessionStorage.removeItem('xiuxian_admin_token'); }
  }
  if (!username || !password) return false;
  const response = await api('/api/auth/admin/password', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  state.token = response.accessToken;
  state.user = response.user;
  sessionStorage.setItem('xiuxian_admin_token', state.token);
  return true;
}

function loginScreen(message = '') {
  return `<div class="login-screen"><form class="login-box" data-admin-login>
    <h1>XiuXian Console</h1>
    <p>使用独立管理员账号登录运营后台。</p>
    ${message ? `<div class="notice error">${esc(message)}</div>` : ''}
    <div class="field"><label>管理员账号</label><input name="username" autocomplete="username" required placeholder="admin" /></div>
    <div class="field"><label>管理员密码</label><input name="password" type="password" autocomplete="current-password" required placeholder="请输入密码" /></div>
    <button class="solid-button" type="submit">登录后台</button>
  </form></div>`;
}

async function loadViewData() {
  const [dashboard, publicConfig] = await Promise.all([
    api('/api/admin/dashboard'),
    state.version ? Promise.resolve(null) : api('/api/public-config'),
  ]);
  state.dashboard = dashboard;
  if (publicConfig?.version) state.version = publicConfig.version;
  if (state.view === 'overview' || state.view === 'products' || state.view === 'inventory') {
    [state.products, state.categories] = await Promise.all([api('/api/admin/products'), api('/api/admin/categories')]);
  }
  if (state.view === 'users') state.users = await api('/api/admin/users');
  if (state.view === 'orders') {
    const filter = state.ordersFilter === 'all' ? '' : `?statuses=${state.ordersFilter}`;
    [state.orders, state.webhookFailures] = await Promise.all([
      api(`/api/admin/orders${filter}`),
      api('/api/admin/webhook-failures'),
    ]);
  }
  if (state.view === 'settings' || state.view === 'payments') state.settings = await api('/api/admin/settings');
  if (state.view === 'integration') {
    [state.credentials, state.connections] = await Promise.all([
      api('/api/admin/upstream/credentials'),
      api('/api/admin/upstream/connections'),
    ]);
  }
}

function sidebar() {
  const links = [['overview', '数据看板'], ['users', '用户管理'], ['products', '商品管理'], ['inventory', '卡密库存'], ['orders', '订单记录'], ['payments', '支付渠道'], ['integration', '对接管理'], ['settings', '系统设置']];
  return `<aside class="sidebar"><a href="/admin" class="admin-brand"><span class="admin-mark">XX</span><span>XiuXian<small>管理后台 · v${esc(state.version ?? '1.0.8')}</small></span></a><span class="side-label">管理</span><nav class="side-nav">${links.map(([view, label]) => `<button class="${state.view === view ? 'active' : ''}" data-action="navigate" data-view="${view}">${icons[view]}${label}</button>`).join('')}</nav><div class="sidebar-foot"><strong>${esc(state.user?.username ?? state.user?.firstName ?? '管理员')}</strong>独立管理员账号<br/>版本 v${esc(state.version ?? '1.0.8')}</div></aside>`;
}

function topbar() {
  const titles = { overview: ['数据看板', '今日经营与库存概况'], users: ['用户管理', '买家资料、余额与账号状态'], products: ['商品管理', '分类、商品和销售规格'], inventory: ['卡密库存', '批次导入与可售库存'], orders: ['订单记录', '支付状态和发卡结果'], payments: ['支付渠道', '收款渠道、网络和回调密钥'], integration: ['对接管理', 'API 凭证、上游站点与采购单'], settings: ['系统设置', '管理员账号与 Telegram Bot'] };
  const [title, subtitle] = titles[state.view];
  return `<header class="main-top"><div><span class="main-title-eyebrow">XIUXIAN CONSOLE</span><h1>${title}</h1><p>${subtitle}</p></div><div class="top-actions"><a class="outline-button" href="/" title="打开买家端">${icons.external} 买家端</a><button class="outline-button" data-action="refresh">刷新</button><button class="outline-button" data-action="logout">退出</button></div></header>`;
}

function overviewView() {
  const d = state.dashboard ?? {};
  return `<div class="kpi-grid">
    ${kpi('成交收入', money(d.paidRevenueFen), '已确认订单', 'gold')}
    ${kpi('支付订单', d.paidOrders ?? 0, '已确认付款')}
    ${kpi('已发卡', d.issuedCards ?? 0, '累计发放')}
    ${kpi('可售库存', d.availableCards ?? 0, d.failedFulfillments ? `${d.failedFulfillments} 个发卡异常` : '库存状态正常', d.failedFulfillments ? 'coral' : '')}
  </div>
  <div class="section-bar"><div><h2>运营摘要</h2><p>核心指标来自订单与加密卡池实时统计</p></div><button class="solid-button" data-action="navigate" data-view="products">管理商品</button></div>
  <div class="table-wrap"><table><thead><tr><th>指标</th><th>数值</th><th>说明</th></tr></thead><tbody>
    <tr><td><strong>已完成订单</strong></td><td>${d.completedOrders ?? 0}</td><td><small>已成功完成卡密发放的订单</small></td></tr>
    <tr><td><strong>在售商品</strong></td><td>${d.activeProducts ?? 0}</td><td><small>买家端当前可见的商品数量</small></td></tr>
    <tr><td><strong>发卡异常</strong></td><td>${d.failedFulfillments ?? 0}</td><td><small>需要人工检查或重试的订单</small></td></tr>
  </tbody></table></div>`;
}
function kpi(label, value, note, tone = '') {
  return `<div class="kpi"><div class="kpi-top"><span>${label}</span><span class="kpi-icon ${tone}">${icons.overview}</span></div><div class="kpi-value">${value}</div><small>${note}</small></div>`;
}

function usersView() {
  const rows = state.users.map((user) => {
    const displayName = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || 'Telegram 用户';
    const username = user.username ? `@${user.username}` : '未设置用户名';
    const search = `${displayName} ${username} ${user.telegramId}`.toLowerCase();
    const initial = displayName.slice(0, 1).toUpperCase();
    return `<tr data-user-row data-search="${esc(search)}"><td><div class="admin-user"><div class="admin-user-avatar"><span>${esc(initial)}</span>${user.photoUrl ? `<img src="${esc(user.photoUrl)}" alt="" referrerpolicy="no-referrer" />` : ''}</div><div><strong>${esc(displayName)}</strong><small>${esc(username)}</small></div></div></td><td><code>${esc(user.telegramId)}</code><small>${esc(user.languageCode ?? '—')}</small></td><td><span class="status ${user.isActive ? '' : 'archived'}">${user.isActive ? '正常' : '已停用'}</span></td><td>${user.orderCount}<small>已支付 ${user.paidOrderCount}</small></td><td>${money(user.spentFen)}</td><td><div class="balance-cell"><strong>${money(user.balanceFen ?? 0)}</strong><button class="outline-button" data-action="adjust-user-balance" data-id="${esc(user.id)}" data-name="${esc(displayName)}" data-balance="${user.balanceFen ?? 0}">调整</button></div></td><td>${new Date(user.createdAt).toLocaleDateString('zh-CN')}<small>${user.lastOrderAt ? `最近下单 ${new Date(user.lastOrderAt).toLocaleDateString('zh-CN')}` : '暂无订单'}</small></td><td><div class="row-actions"><button class="outline-button" data-action="show-balance-entries" data-id="${esc(user.id)}" data-name="${esc(displayName)}">流水</button><button class="outline-button ${user.isActive ? 'danger-button' : ''}" data-action="toggle-user-status" data-id="${esc(user.id)}" data-active="${user.isActive ? 'false' : 'true'}">${user.isActive ? '停用' : '恢复'}</button></div></td></tr>`;
  }).join('');
  return `<div class="section-bar user-section-bar"><div><h2>Telegram 买家</h2><p>共 <span data-user-count>${state.users.length}</span> 位用户，可按姓名、用户名或 ID 搜索</p></div><input class="user-search" type="search" placeholder="搜索用户" aria-label="搜索用户" data-user-search /></div>
    ${state.users.length ? `<div class="table-wrap"><table><thead><tr><th>用户</th><th>Telegram ID</th><th>状态</th><th>订单</th><th>累计消费</th><th>余额</th><th>加入时间</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">暂无 Telegram 买家。</div>'}${balanceModal()}${balanceEntriesModal()}`;
}
function balanceEntriesModal() {
  const target = state.balanceEntriesTarget;
  if (!target) return '';
  const entries = target.entries ?? [];
  const rows = entries.length
    ? entries.map((entry) => {
      const sign = entry.changeFen >= 0 ? '+' : '';
      const tone = entry.changeFen >= 0 ? '' : 'debit';
      return `<tr><td><strong class="${tone}">${sign}${money(entry.changeFen)}</strong></td><td>${money(entry.balanceAfterFen)}</td><td>${esc(entry.kindLabel ?? entry.kind)}</td><td><small>${esc(entry.memo || '—')}</small></td><td>${new Date(entry.createdAt).toLocaleString('zh-CN')}</td></tr>`;
    }).join('')
    : '<tr><td colspan="5"><div class="empty">暂无余额流水。</div></td></tr>';
  return `<div class="modal-backdrop" data-action="close-balance-entries-modal"><div class="modal-card" data-stop-close><h3>余额流水</h3><p class="settings-copy">用户 <strong>${esc(target.name)}</strong> 的余额变动记录（最近 50 条）</p><div class="table-wrap" style="max-height:320px;overflow:auto"><table><thead><tr><th>变动</th><th>变动后余额</th><th>类型</th><th>备注</th><th>时间</th></tr></thead><tbody>${rows}</tbody></table></div><div class="form-actions"><button class="outline-button" data-action="close-balance-entries-modal">关闭</button></div></div></div>`;
}
function balanceModal() {
  if (!state.balanceTarget) return '';
  const target = state.balanceTarget;
  return `<div class="modal-backdrop" data-action="close-balance-modal"><div class="modal-card" data-stop-close><h3>调整余额</h3><p class="settings-copy">为 <strong>${esc(target.name)}</strong> 调整余额。当前余额 <strong>${money(target.balance)}</strong>。</p><div class="field"><label>变动金额（元，正加负减）</label><input name="balance-delta" type="number" min="0.01" step="0.01" placeholder="例如：50 或 -20" /></div><div class="field"><label>备注</label><input name="balance-memo" placeholder="例如：充值到账 / 消费扣减" /></div><div class="form-actions"><button class="outline-button" data-action="close-balance-modal">取消</button><button class="solid-button" data-action="confirm-adjust-balance" data-id="${esc(target.id)}">保存</button></div></div></div>`;
}

function productsView() {
  const editing = state.products.find((product) => product.id === state.editingProductId);
  return `<div class="section-bar"><div><h2>商品与规格</h2><p>价格使用人民币分存储，库存由卡密池自动计算</p></div><div class="top-actions"><button class="outline-button" data-action="toggle-panel" data-panel="category-form">${icons.plus} 新建分类</button><button class="solid-button" data-action="toggle-panel" data-panel="product-form">${icons.plus} 新建商品</button></div></div>
  <div id="category-form" class="form-panel" hidden>
    <h3>创建分类</h3><div class="field"><label>分类名称</label><input name="category-name" placeholder="例如：软件会员" /></div><div class="field"><label>Slug（留空自动生成）</label><input name="category-slug" placeholder="留空将根据名称自动生成" /></div><div class="field"><label>排序</label><input name="category-position" type="number" value="0" min="0" /></div><div class="form-actions"><button class="outline-button" data-action="toggle-panel" data-panel="category-form">取消</button><button class="solid-button" data-action="create-category">保存分类</button></div>
  </div>
  <div id="product-form" class="form-panel" hidden>
    <h3>创建商品</h3>
    <div class="field"><label>商品名称</label><input name="product-title" placeholder="例如：Stream Pass" /></div>
    <div class="field"><label>Slug（留空自动生成）</label><input name="product-slug" placeholder="留空将根据商品名称自动生成" /></div>
    <div class="field"><label>分类</label><select name="product-category"><option value="">未分类</option>${state.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></div>
    <div class="field"><label>状态</label><select name="product-status"><option value="active">立即上架</option><option value="draft">草稿</option></select></div>
    <div class="field full"><label>商品描述</label><textarea name="product-description" placeholder="展示在买家端的简短说明"></textarea></div>
    <div class="field full"><label>使用说明</label><textarea name="product-instructions" placeholder="支付后给买家的兑换说明"></textarea></div>
    <div class="field full"><label>封面路径</label><input name="product-image" value="/assets/stream-pass.png" /></div>
    <div class="form-actions"><button class="outline-button" data-action="toggle-panel" data-panel="product-form">取消</button><button class="solid-button" data-action="create-product">保存商品</button></div>
  </div>
  ${editing ? productEditor(editing) : ''}
  <div class="section-bar"><div><h2>全部分类</h2><p>共 ${state.categories.length} 个分类</p></div></div>
  <div class="category-list">${state.categories.length ? state.categories.map(categoryRow).join('') : '<div class="empty">暂无分类，请先创建分类。</div>'}</div>
  <div class="section-bar"><div><h2>商品列表</h2><p>共 ${state.products.length} 件商品</p></div></div>
  <div class="product-list">${state.products.length ? state.products.map(productRow).join('') : '<div class="empty">暂无商品。</div>'}</div>${categoryEditorModal()}`;
}

function categoryRow(category) {
  return `<div class="category-row"><div class="category-idx"></div><div class="category-main"><strong>${esc(category.name)}</strong><small>${esc(category.slug)} · ${category.productCount} 件商品</small></div><span class="status ${category.isActive ? '' : 'archived'}">${category.isActive ? '启用' : '停用'}</span><div class="row-actions"><button class="outline-button" data-action="edit-category" data-id="${esc(category.id)}" data-name="${esc(category.name)}" data-slug="${esc(category.slug)}" data-position="${category.position}">编辑</button><button class="outline-button ${category.isActive ? 'danger-button' : ''}" data-action="toggle-category" data-id="${esc(category.id)}" data-active="${category.isActive ? 'false' : 'true'}">${category.isActive ? '停用' : '启用'}</button></div></div>`;
}
function categoryEditorModal() {
  const target = state.categoryEditor;
  if (!target) return '';
  return `<div class="modal-backdrop" data-action="close-category-editor"><div class="modal-card" data-stop-close><h3>编辑分类</h3><div class="field"><label>分类名称</label><input name="category-edit-name" value="${esc(target.name)}" /></div><div class="field"><label>Slug</label><input name="category-edit-slug" value="${esc(target.slug)}" /></div><div class="field"><label>排序</label><input name="category-edit-position" type="number" min="0" value="${target.position}" /></div><div class="form-actions"><button class="outline-button" data-action="close-category-editor">取消</button><button class="solid-button" data-action="save-category" data-id="${esc(target.id)}">保存分类</button></div></div></div>`;
}
function productRow(product) {
  return `<article class="product-row"><div><h3>${esc(product.title)}</h3><p>${esc(product.categoryName ?? '未分类')} · ${esc(product.slug)}</p><span class="status ${statusClass(product.status)}">${statusLabel(product.status)}</span></div><div class="variant-chips">${product.variants.length ? product.variants.map((v) => `<span class="variant-chip ${v.stock < 5 ? 'low' : ''}">${esc(v.name)} <b>${money(v.priceFen)}</b><small>库存 ${v.stock} · 已售 ${v.sold}</small></span>`).join('') : '<small>暂无规格</small>'}</div><div class="row-actions"><button class="outline-button" data-action="edit-product" data-id="${esc(product.id)}">编辑</button><button class="outline-button" data-action="toggle-status" data-id="${esc(product.id)}" data-status="${product.status === 'active' ? 'archived' : 'active'}">${product.status === 'active' ? '下架' : '上架'}</button></div></article>`;
}
function productEditor(product) {
  return `<div class="form-panel" id="product-editor"><h3>编辑：${esc(product.title)}</h3>
    <div class="field"><label>商品名称</label><input name="edit-title" value="${esc(product.title)}" /></div><div class="field"><label>Slug（留空自动生成）</label><input name="edit-slug" value="${esc(product.slug)}" placeholder="留空将重新按名称生成" /></div>
    <div class="field"><label>分类</label><select name="edit-category"><option value="">未分类</option>${state.categories.map((c) => `<option value="${esc(c.id)}" ${c.id === product.categoryId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div><div class="field"><label>状态</label><select name="edit-status">${['draft','active','archived'].map((status) => `<option value="${status}" ${status === product.status ? 'selected' : ''}>${statusLabel(status)}</option>`).join('')}</select></div>
    <div class="field full"><label>描述</label><textarea name="edit-description">${esc(product.description)}</textarea></div><div class="field full"><label>使用说明</label><textarea name="edit-instructions">${esc(product.instructions)}</textarea></div><div class="field full"><label>封面路径</label><input name="edit-image" value="${esc(product.imageUrl ?? '')}" /></div>
    <div class="form-actions"><button class="outline-button" data-action="close-editor">取消</button><button class="solid-button" data-action="save-product" data-id="${esc(product.id)}">保存修改</button></div>
    <h3>现有规格</h3>
    <div class="variant-editor-list">${product.variants.length ? product.variants.map((variant) => `<div class="variant-editor-row" data-variant-id="${esc(variant.id)}"><div class="field"><label>规格名</label><input data-field="name" value="${esc(variant.name)}" /></div><div class="field"><label>SKU</label><input data-field="sku" value="${esc(variant.sku)}" /></div><div class="field"><label>价格（元）</label><input data-field="price" type="number" min="0.01" step="0.01" value="${(variant.priceFen / 100).toFixed(2)}" /></div><div class="field"><label>单次限购</label><input data-field="limit" type="number" min="1" max="20" value="${variant.maxPerOrder}" /></div><label class="variant-toggle"><input data-field="active" type="checkbox" ${variant.isActive ? 'checked' : ''} /> 在售</label><button class="outline-button" data-action="save-variant" data-id="${esc(variant.id)}">保存规格</button></div>`).join('') : '<div class="notice">暂无规格。</div>'}</div>
    <h3>新增规格</h3><div class="field"><label>规格名</label><input name="variant-name" placeholder="例如：年度会员" /></div><div class="field"><label>SKU</label><input name="variant-sku" placeholder="STREAM-12M" /></div><div class="field"><label>价格（元）</label><input name="variant-price" type="number" min="0.01" step="0.01" placeholder="99.00" /></div><div class="field"><label>单次限购</label><input name="variant-limit" type="number" min="1" max="20" value="5" /></div><div class="form-actions"><button class="outline-button" data-action="create-variant" data-id="${esc(product.id)}">新增规格</button></div>
  </div>`;
}

function inventoryView() {
  const variants = state.products.flatMap((product) => product.variants.map((variant) => ({ ...variant, productTitle: product.title, productId: product.id })));
  return `<div class="section-bar"><div><h2>批量导入卡密</h2><p>每行一张卡密，支持：卡密、密码、备注，用逗号或 Tab 分隔</p></div></div>
    <div class="form-panel"><h3>导入新批次</h3><div class="field"><label>商品规格</label><select name="card-variant">${variants.map((v) => `<option value="${esc(v.id)}">${esc(v.productTitle)} · ${esc(v.name)} · 当前 ${v.stock}</option>`).join('')}</select></div><div class="field"><label>批次名称</label><input name="card-label" placeholder="例如：2026-08-17 新批次" /></div><div class="field full"><label>卡密内容</label><textarea name="card-raw" placeholder="CODE-001,PASSWORD-001,备注\nCODE-002,,无密码"></textarea></div><div class="form-actions"><button class="solid-button" data-action="import-cards">导入并加密</button></div></div>
    <div class="section-bar"><div><h2>当前库存</h2><p>库存少于 5 张会标记为低库存</p></div></div><div class="table-wrap"><table><thead><tr><th>商品</th><th>规格</th><th>价格</th><th>可售</th><th>已售</th></tr></thead><tbody>${variants.map((v) => `<tr><td>${esc(v.productTitle)}</td><td><strong>${esc(v.name)}</strong><small>${esc(v.sku)}</small></td><td>${money(v.priceFen)}</td><td><span class="status ${v.stock < 5 ? 'payment_expired' : ''}">${v.stock}</span></td><td>${v.sold}</td></tr>`).join('')}</tbody></table></div>`;
}

function ordersView() {
  const orderTable = state.orders.length
    ? `<div class="table-wrap"><table><thead><tr><th>订单</th><th>买家商品</th><th>金额</th><th>支付</th><th>发卡</th><th>创建时间</th><th>处理</th></tr></thead><tbody>${state.orders.map((order) => `<tr><td><strong>${esc(order.orderNo)}</strong><small>${new Date(order.createdAt).toLocaleString('zh-CN')}</small></td><td>${esc(order.productTitle)}<small>${esc(order.variantName)} × ${order.quantity}</small></td><td>${money(order.totalPriceFen)}</td><td><span class="status ${statusClass(order.payment.status)}">${statusLabel(order.payment.status === 'paid' ? 'paid' : order.status)}</span></td><td><span class="status ${statusClass(order.status)}">${statusLabel(order.status)}</span></td><td>${new Date(order.createdAt).toLocaleDateString('zh-CN')}</td><td>${order.status === 'fulfillment_failed' ? `<button class="outline-button" data-action="retry-fulfillment" data-order-no="${esc(order.orderNo)}">重试发卡</button>` : order.status === 'completed' ? `<button class="outline-button" data-action="open-refund" data-order-no="${esc(order.orderNo)}" data-name="${esc(order.productTitle)}" data-amount="${order.totalPriceFen}">退款</button>` : '<small>—</small>'}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="empty">当前筛选条件下暂无订单。</div>';
  const failureTable = state.webhookFailures.length
    ? `<div class="table-wrap"><table><thead><tr><th>事件 ID</th><th>类型</th><th>错误</th><th>接收时间</th></tr></thead><tbody>${state.webhookFailures.map((failure) => `<tr><td><strong>${esc(failure.provider_event_id)}</strong></td><td>${esc(failure.event_type)}</td><td><small>${esc(failure.processing_error)}</small></td><td>${new Date(failure.received_at).toLocaleString('zh-CN')}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="empty">当前没有支付回调异常。</div>';
  const orderFilters = [
    ['all', '全部'],
    ['pending_payment', '待支付'],
    ['payment_confirming', '确认中'],
    ['paid', '已支付'],
    ['fulfilling', '发卡中'],
    ['completed', '已完成'],
    ['fulfillment_failed', '发卡异常'],
    ['canceled,payment_expired', '已取消'],
  ];
  return `<div class="section-bar"><div><h2>订单记录</h2><p>最近 200 条订单，可按状态筛选</p></div><div class="order-filters">${orderFilters.map(([key, label]) => `<button class="filter-pill ${state.ordersFilter === key ? 'active' : ''}" data-action="filter-orders" data-filter="${key}">${label}</button>`).join('')}</div></div>${orderTable}
  <div class="section-bar"><div><h2>支付回调异常</h2><p>验签成功但业务校验未通过的 DujiaoPay 事件</p></div></div>${failureTable}${refundModal()}`;
}

function refundModal() {
  const target = state.refundTarget;
  if (!target) return '';
  return `<div class="modal-backdrop" data-action="close-refund-modal"><div class="modal-card" data-stop-close><h3>退款到余额</h3><p class="settings-copy">将订单 <strong>${esc(target.orderNo)}</strong>（${esc(target.name)}，金额 ${money(target.amount)}）全额退至买家账户余额。退款幂等，不会重复入账。</p><div class="field"><label>退款原因</label><input name="refund-reason" placeholder="例如：卡密异常，协商退款" /></div><div class="form-actions"><button class="outline-button" data-action="close-refund-modal">取消</button><button class="solid-button coral" data-action="confirm-refund" data-order-no="${esc(target.orderNo)}">确认退款</button></div></div></div>`;
}

function paymentsView() {
  const settings = state.settings ?? {};
  const ready = settings.paymentReady;
  const stateLabel = ready ? '已启用' : settings.paymentConfigured ? (settings.paymentEnabled ? '待配置' : '已停用') : '待配置';
  const stateCopy = ready ? '支付配置已启用，买家可以创建支付订单。可使用“测试连接”验证 DujiaoPay 凭据。' : settings.paymentConfigured && !settings.paymentEnabled ? '已停止接受新订单，历史支付单仍可继续处理。' : '渠道尚未完成配置，当前不会接受买家订单。';
  const sourceLabel = { database: '后台数据库', environment: '环境变量', none: '尚未配置' }[settings.paymentSource] ?? '尚未配置';
  const updatedAt = settings.paymentUpdatedAt ? ` · 最近更新 ${new Date(settings.paymentUpdatedAt).toLocaleString('zh-CN')}` : '';
  return `<div class="payment-console">
    <div class="payment-hero ${ready ? 'ready' : 'offline'}"><div><span class="payment-eyebrow">PAYMENT CHANNEL</span><h2>DujiaoPay 收款渠道</h2><p>${stateCopy}</p></div><span class="payment-state"><i></i>${stateLabel}</span></div>
    ${state.paymentNotice ? `<div class="notice ${state.paymentNotice.type === 'error' ? 'error' : ''}">${esc(state.paymentNotice.text)}</div>` : ''}
    <section class="form-panel payment-panel"><div class="panel-heading"><div><h3>渠道参数</h3><p>来源：${sourceLabel}${updatedAt}。敏感密钥仅在服务端加密保存，页面不会回显明文。</p></div><span class="status ${ready ? '' : 'archived'}">${ready ? '可用' : '不可用'}</span></div>
      <div class="field"><label>渠道状态</label><select name="payment-enabled"><option value="true" ${settings.paymentEnabled ? 'selected' : ''}>启用收款</option><option value="false" ${!settings.paymentEnabled ? 'selected' : ''}>暂时停用</option></select></div>
      <div class="field"><label>API 地址</label><input name="payment-base-url" value="${esc(settings.paymentBaseUrl ?? 'https://www.dujiaopay.com')}" placeholder="https://www.dujiaopay.com" /></div>
      <div class="field"><label>Key ID</label><input name="payment-key-id" placeholder="${esc(settings.paymentKeyId ? `当前 ${settings.paymentKeyId}` : '填入 DujiaoPay Key ID')}" autocomplete="off" /></div>
      <div class="field"><label>API Secret</label><input name="payment-secret" type="password" placeholder="${settings.paymentSecretConfigured ? '已配置，留空保持不变' : '填入 API Secret'}" autocomplete="new-password" /></div>
      <div class="field"><label>Webhook Secret</label><input name="payment-webhook-secret" type="password" placeholder="${settings.paymentWebhookSecretConfigured ? '已配置，留空保持不变' : '填入 Webhook Secret'}" autocomplete="new-password" /></div>
      <div class="field"><label>支付网络</label><select name="payment-chain"><option value="tron" ${settings.paymentChain === 'tron' ? 'selected' : ''}>TRON</option><option value="bsc" ${settings.paymentChain === 'bsc' ? 'selected' : ''}>BSC</option><option value="eth" ${settings.paymentChain === 'eth' ? 'selected' : ''}>Ethereum</option></select></div>
      <div class="field"><label>支付币种 ID</label><input name="payment-token-id" value="${esc(settings.paymentTokenId ?? 'tron-usdt')}" placeholder="tron-usdt" /></div>
      <div class="field"><label>订单有效期（分钟）</label><input name="payment-ttl" type="number" min="5" max="60" value="${esc(settings.paymentTtlMinutes ?? 15)}" /></div>
      <div class="field full"><div class="payment-webhook"><span>Webhook 地址</span><code>${esc(`${location.origin}/api/webhooks/dujiaopay`)}</code><button class="copy-button" data-action="copy-payment-url" data-copy="${esc(`${location.origin}/api/webhooks/dujiaopay`)}">复制</button></div></div>
      <div class="form-actions"><button class="outline-button" data-action="test-payment" ${settings.paymentConfigured && !state.paymentSaving ? '' : 'disabled'}>测试连接</button><button class="solid-button" data-action="save-payment" ${state.paymentSaving ? 'disabled' : ''}>${state.paymentSaving ? '正在保存…' : '保存支付配置'}</button></div>
    </section>
  </div>`;
}

function integrationView() {
  const credentials = state.credentials ?? [];
  const connections = state.connections ?? [];
  const activeConnections = connections.filter((connection) => connection.isActive);
  return `<div class="integration-hero">
    <div class="integration-hero-copy"><span class="payment-eyebrow">OPEN API</span><h2>站点对接</h2><p>本站作为 B 站被对接方提供 OpenAPI 采购接口；同时可配置上游 A 站连接，用于拉取商品、创建采购单与处理回调。</p></div>
    <span class="integration-state"><i></i>${credentials.some((cred) => cred.isActive) ? '对外凭证已启用' : '暂无启用凭证'}</span>
  </div>
  <div class="integration-grid">
    <section class="form-panel integ-panel">
      <div class="panel-heading"><div><h3>API 凭证</h3><p>供 A 站调用本站采购接口时签名。Secret 只在创建时展示一次，请立即保存。</p></div><span class="status ${credentials.length ? '' : 'archived'}">${credentials.length} 个</span></div>
      <div class="credential-create"><input name="credential-label" placeholder="凭证用途，例如：A 站对接" /><button class="solid-button" data-action="create-credential">创建凭证</button></div>
      ${state.secretReveal ? secretRevealPanel(state.secretReveal) : ''}
      ${credentials.length ? credentials.map(credentialRow).join('') : '<div class="empty">暂无 API 凭证。创建后即可开放对外采购接口。</div>'}
    </section>
    <section class="form-panel integ-panel">
      <div class="panel-heading"><div><h3>上游连接</h3><p>配置上游 A 站地址与签名凭据，用于拉取商品与创建采购单。</p></div><span class="status ${connections.length ? '' : 'archived'}">${connections.length} 个</span></div>
      <button class="outline-button" data-action="toggle-panel" data-panel="connection-form">${icons.plus} 新建连接</button>
      <div id="connection-form" class="connection-form" hidden>
        <div class="field"><label>连接名称</label><input name="conn-name" placeholder="例如：上游 A 站" /></div>
        <div class="field"><label>站点地址</label><input name="conn-url" placeholder="https://upstream.example.com" /></div>
        <div class="field"><label>API Key</label><input name="conn-key" placeholder="对端签发的 API Key" /></div>
        <div class="field"><label>API Secret</label><input name="conn-secret" type="password" placeholder="对端签发的 API Secret" /></div>
        <div class="field full"><label>回调地址（可选）</label><input name="conn-callback" placeholder="https://a.example.com/api/v1/upstream/callback" /></div>
        <div class="form-actions"><button class="outline-button" data-action="toggle-panel" data-panel="connection-form">取消</button><button class="solid-button" data-action="create-connection">保存连接</button></div>
      </div>
      ${connections.length ? connections.map(connectionRow).join('') : '<div class="empty">暂无上游连接。</div>'}
    </section>
    <section class="form-panel integ-panel integ-panel-full">
      <div class="panel-heading"><div><h3>创建采购单</h3><p>向上游 A 站发起采购，采购结果通过对方回调或轮询回传。</p></div><span class="status ${activeConnections.length ? '' : 'archived'}">${activeConnections.length} 个可用连接</span></div>
      ${activeConnections.length ? `<div class="procurement-row">
        <div class="field"><label>上游连接</label><select name="proc-connection">${activeConnections.map((connection) => `<option value="${esc(connection.id)}">${esc(connection.name)}</option>`).join('')}</select></div>
        <div class="field"><label>上游 SKU ID</label><input name="proc-sku" placeholder="上游商品规格 ID" /></div>
        <div class="field"><label>数量</label><input name="proc-quantity" type="number" min="1" value="1" /></div>
        <div class="field"><label>下游订单号</label><input name="proc-order" placeholder="关联的本站订单号（可选）" /></div>
        <div class="form-actions"><button class="solid-button" data-action="create-procurement">创建采购单</button></div>
      </div>` : '<div class="notice">请先创建并启用上游连接。</div>'}
    </section>
  </div>`;
}

function credentialRow(credential) {
  return `<div class="credential-row"><div class="credential-main"><strong>${esc(credential.label || '未命名凭证')}</strong><small><code>${esc(credential.apiKey)}</code> · 创建于 ${new Date(credential.createdAt).toLocaleDateString('zh-CN')}</small></div><span class="status ${credential.isActive ? '' : 'archived'}">${credential.isActive ? '启用' : '停用'}</span><div class="row-actions"><button class="outline-button ${credential.isActive ? 'danger-button' : ''}" data-action="toggle-credential" data-id="${esc(credential.id)}" data-active="${credential.isActive ? 'false' : 'true'}">${credential.isActive ? '停用' : '启用'}</button></div></div>`;
}

function connectionRow(connection) {
  return `<div class="credential-row"><div class="credential-main"><strong>${esc(connection.name)}</strong><small><code>${esc(connection.baseUrl)}</code> · ${connection.lastPingAt ? `最近连通 ${new Date(connection.lastPingAt).toLocaleString('zh-CN')}` : '尚未测试连通'}</small></div><span class="status ${connection.isActive ? '' : 'archived'}">${connection.isActive ? '启用' : '停用'}</span><div class="row-actions"><button class="outline-button" data-action="sync-products" data-id="${esc(connection.id)}" ${connection.isActive ? '' : 'disabled'}>同步商品</button><button class="outline-button" data-action="test-connection" data-id="${esc(connection.id)}">测试</button><button class="outline-button ${connection.isActive ? 'danger-button' : ''}" data-action="toggle-connection" data-id="${esc(connection.id)}" data-active="${connection.isActive ? 'false' : 'true'}">${connection.isActive ? '停用' : '启用'}</button><button class="outline-button danger-button" data-action="delete-connection" data-id="${esc(connection.id)}" data-name="${esc(connection.name)}">删除</button></div></div>`;
}

function secretRevealPanel(credential) {
  return `<div class="secret-reveal"><h4>凭证已创建，Secret 仅显示这一次</h4><p>请立即保存并分发给对端站点，关闭后无法再次查看。</p><div class="secret-line"><span>API Key</span><code>${esc(credential.apiKey)}</code><button class="copy-button" data-action="copy-secret" data-copy="${esc(credential.apiKey)}">复制</button></div><div class="secret-line"><span>Secret</span><code>${esc(credential.secret)}</code><button class="copy-button" data-action="copy-secret" data-copy="${esc(credential.secret)}">复制</button></div><button class="outline-button" data-action="dismiss-secret">我已保存</button></div>`;
}

function settingsView() {
  const settings = state.settings ?? {};
  return `<div class="settings-grid">
    <section class="form-panel settings-panel"><h3>Telegram Bot Token</h3><p class="settings-copy">用于买家 Mini App 登录验签。Token 只在服务端加密保存，页面不会回显明文。</p><div class="notice ${settings.telegramBotTokenConfigured ? '' : 'error'}">当前状态：${settings.telegramBotTokenConfigured ? '已配置' : '未配置'}${settings.telegramBotTokenUpdatedAt ? ` · 最近更新 ${new Date(settings.telegramBotTokenUpdatedAt).toLocaleString('zh-CN')}` : ''}</div>${state.settingsNotice ? `<div class="notice ${state.settingsNotice.type === 'error' ? 'error' : ''}">${esc(state.settingsNotice.text)}</div>` : ''}<div class="field full"><label>新的 Bot Token</label><input name="telegram-bot-token" type="password" autocomplete="off" placeholder="粘贴 BotFather 提供的 Token" /></div><div class="form-actions"><button class="solid-button" data-action="save-bot-token">保存 Bot Token</button></div></section>
    <section class="form-panel settings-panel"><h3>店铺信息</h3><p class="settings-copy">展示在买家端顶部的商店名称、Logo 与简介。Logo 支持 HTTPS 图片地址。</p><div class="field full"><label>店铺名称</label><input name="store-name" value="${esc(settings.storeName ?? 'XiuXian')}" placeholder="例如：XiuXian 数字商店" /></div><div class="field full"><label>店铺 Logo 地址</label><input name="store-logo" value="${esc(settings.storeLogo ?? '')}" placeholder="https://…/logo.png（可选）" /></div><div class="field full"><label>店铺简介</label><input name="store-description" value="${esc(settings.storeDescription ?? '')}" placeholder="展示在买家端标题下方（可选）" /></div>${state.storeNotice ? `<div class="notice ${state.storeNotice.type === 'error' ? 'error' : ''}">${esc(state.storeNotice.text)}</div>` : ''}<div class="form-actions"><button class="solid-button" data-action="save-store">保存店铺信息</button></div></section>
    <section class="form-panel settings-panel"><h3>管理员账号</h3><p class="settings-copy">修改后台登录账号或密码。新密码至少 8 位。</p><div class="field full"><label>账号</label><input name="admin-username" value="${esc(state.user?.username ?? '')}" autocomplete="username" /></div><div class="field"><label>新密码</label><input name="admin-password" type="password" autocomplete="new-password" placeholder="留空表示不修改" /></div><div class="field"><label>确认新密码</label><input name="admin-password-confirm" type="password" autocomplete="new-password" placeholder="再次输入新密码" /></div><div class="form-actions"><button class="solid-button" data-action="save-admin-account">保存账号设置</button></div></section>
  </div>`;
}

function render() {
  const views = { overview: overviewView, users: usersView, products: productsView, inventory: inventoryView, orders: ordersView, payments: paymentsView, integration: integrationView, settings: settingsView };
  root.innerHTML = `<div class="admin-shell">${sidebar()}<section class="main">${topbar()}<main class="content">${state.message ? `<div class="notice error" style="margin-bottom:15px">${esc(state.message)}</div>` : ''}${views[state.view]()}</main></section><div class="toast" id="toast"></div></div>`;
  requestAnimationFrame(() => {
    const active = document.querySelector('.side-nav button.active');
    const navigation = active?.parentElement;
    if (active && navigation) navigation.scrollTo({ left: active.offsetLeft - (navigation.clientWidth - active.offsetWidth) / 2, behavior: 'auto' });
    // 余额调整弹窗打开时自动聚焦金额输入框
    if (state.balanceTarget) {
      document.querySelector('[name="balance-delta"]')?.focus();
    }
  });
}

function toast(message) {
  const element = document.querySelector('#toast');
  if (!element) return;
  element.textContent = message;
  element.classList.add('show');
  setTimeout(() => element.classList.remove('show'), 2300);
}

async function refresh() {
  state.message = '';
  try { await loadViewData(); render(); } catch (error) { state.message = error.message; render(); }
}

async function onClick(event) {
  const element = event.target.closest('[data-action]');
  if (!element) return;
  const action = element.dataset.action;
  try {
    if (action === 'reload') { location.reload(); return; }
    if (action === 'logout') {
      state.token = '';
      state.user = null;
      sessionStorage.removeItem('xiuxian_admin_token');
      root.innerHTML = loginScreen();
      return;
    }
    if (action === 'navigate') { state.view = element.dataset.view; state.balanceTarget = null; state.refundTarget = null; state.secretReveal = null; if (state.view !== 'settings') { state.settingsNotice = null; state.storeNotice = null; } if (state.view !== 'payments') state.paymentNotice = null; await refresh(); return; }
    if (action === 'refresh') { await refresh(); toast('数据已刷新。'); return; }
    if (action === 'toggle-panel') { const panel = document.querySelector(`#${element.dataset.panel}`); if (panel) panel.hidden = !panel.hidden; return; }
    if (action === 'edit-product') { state.editingProductId = element.dataset.id; render(); document.querySelector('#product-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (action === 'close-editor') { state.editingProductId = null; render(); return; }
    if (action === 'create-category') {
      const form = document.querySelector('#category-form');
      await api('/api/admin/categories', { method: 'POST', body: JSON.stringify({
        name: form.querySelector('[name="category-name"]').value,
        slug: form.querySelector('[name="category-slug"]').value,
        position: Number(form.querySelector('[name="category-position"]').value || 0),
      }) });
      toast('分类已创建。'); await refresh(); return;
    }
    if (action === 'create-product') {
      const form = document.querySelector('#product-form');
      await api('/api/admin/products', { method: 'POST', body: JSON.stringify({
        title: form.querySelector('[name="product-title"]').value,
        slug: form.querySelector('[name="product-slug"]').value,
        categoryId: form.querySelector('[name="product-category"]').value || null,
        status: form.querySelector('[name="product-status"]').value,
        description: form.querySelector('[name="product-description"]').value,
        instructions: form.querySelector('[name="product-instructions"]').value,
        imageUrl: form.querySelector('[name="product-image"]').value || null,
      }) });
      toast('商品已创建，请为商品添加规格并导入卡密后即可在买家端展示。'); await refresh(); return;
    }
    if (action === 'save-product') {
      const form = document.querySelector('#product-editor');
      await api(`/api/admin/products/${element.dataset.id}`, { method: 'PATCH', body: JSON.stringify({
        title: form.querySelector('[name="edit-title"]').value,
        slug: form.querySelector('[name="edit-slug"]').value,
        categoryId: form.querySelector('[name="edit-category"]').value || null,
        status: form.querySelector('[name="edit-status"]').value,
        description: form.querySelector('[name="edit-description"]').value,
        instructions: form.querySelector('[name="edit-instructions"]').value,
        imageUrl: form.querySelector('[name="edit-image"]').value || null,
      }) });
      state.editingProductId = null; toast('商品已保存。'); await refresh(); return;
    }
    if (action === 'save-variant') {
      const row = element.closest('.variant-editor-row');
      await api(`/api/admin/variants/${element.dataset.id}`, { method: 'PATCH', body: JSON.stringify({
        name: row.querySelector('[data-field="name"]').value,
        sku: row.querySelector('[data-field="sku"]').value,
        priceFen: priceToFen(row.querySelector('[data-field="price"]').value),
        maxPerOrder: Number(row.querySelector('[data-field="limit"]').value),
        isActive: row.querySelector('[data-field="active"]').checked,
      }) });
      toast('SKU 已保存。'); await refresh(); return;
    }
    if (action === 'create-variant') {
      const form = document.querySelector('#product-editor');
      await api('/api/admin/variants', { method: 'POST', body: JSON.stringify({
        productId: element.dataset.id,
        name: form.querySelector('[name="variant-name"]').value,
        sku: form.querySelector('[name="variant-sku"]').value,
        priceFen: priceToFen(form.querySelector('[name="variant-price"]').value),
        maxPerOrder: Number(form.querySelector('[name="variant-limit"]').value || 5),
        position: 0,
        isActive: true,
      }) });
      toast('SKU 已创建，可立即导入卡密。'); await refresh(); return;
    }
    if (action === 'toggle-user-status') {
      await api(`/api/admin/users/${element.dataset.id}/status`, { method: 'PATCH', body: JSON.stringify({ isActive: element.dataset.active === 'true' }) });
      toast(element.dataset.active === 'true' ? '用户已恢复。' : '用户已停用。');
      await refresh(); return;
    }
    if (action === 'adjust-user-balance') {
      state.balanceTarget = { id: element.dataset.id, name: element.dataset.name, balance: Number(element.dataset.balance) };
      render(); return;
    }
    if (action === 'close-balance-modal') {
      if (event.target.closest('.modal-card')) return;
      state.balanceTarget = null;
      render(); return;
    }
    if (action === 'show-balance-entries') {
      const entries = await api(`/api/admin/users/${element.dataset.id}/balance-entries`);
      state.balanceEntriesTarget = { id: element.dataset.id, name: element.dataset.name, entries };
      render(); return;
    }
    if (action === 'close-balance-entries-modal') {
      if (event.target.closest('.modal-card')) return;
      state.balanceEntriesTarget = null;
      render(); return;
    }
    if (action === 'edit-category') {
      state.categoryEditor = {
        id: element.dataset.id,
        name: element.dataset.name,
        slug: element.dataset.slug,
        position: Number(element.dataset.position ?? 0),
      };
      render(); return;
    }
    if (action === 'close-category-editor') {
      if (event.target.closest('.modal-card')) return;
      state.categoryEditor = null;
      render(); return;
    }
    if (action === 'save-category') {
      const editor = state.categoryEditor;
      if (!editor) return;
      await api(`/api/admin/categories/${editor.id}`, { method: 'PATCH', body: JSON.stringify({
        name: document.querySelector('[name="category-edit-name"]')?.value.trim(),
        slug: document.querySelector('[name="category-edit-slug"]')?.value.trim(),
        position: Number(document.querySelector('[name="category-edit-position"]')?.value || 0),
      }) });
      toast('分类已保存。'); state.categoryEditor = null; await refresh(); return;
    }
    if (action === 'toggle-category') {
      await api(`/api/admin/categories/${element.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: element.dataset.active === 'true' }) });
      toast(element.dataset.active === 'true' ? '分类已启用。' : '分类已停用（商品保持原样，将在买家端归类为未分类）。');
      await refresh(); return;
    }
    if (action === 'filter-orders') {
      state.ordersFilter = element.dataset.filter;
      await refresh(); return;
    }
    if (action === 'confirm-adjust-balance') {
      const delta = Number(document.querySelector('[name="balance-delta"]')?.value);
      if (!Number.isFinite(delta) || delta === 0) { toast('请输入非零的变动金额。'); return; }
      await api(`/api/admin/users/${element.dataset.id}/balance`, { method: 'PATCH', body: JSON.stringify({
        deltaFen: Math.round(delta * 100),
        memo: document.querySelector('[name="balance-memo"]')?.value || '后台调整',
      }) });
      toast('余额已更新。'); state.balanceTarget = null; await refresh(); return;
    }
    if (action === 'toggle-status') {
      await api(`/api/admin/products/${element.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ status: element.dataset.status }) });
      toast('商品状态已更新。'); await refresh(); return;
    }
    if (action === 'retry-fulfillment') {
      await api(`/api/admin/orders/${element.dataset.orderNo}/retry-fulfillment`, { method: 'POST' });
      toast('发卡任务已重新入队。'); await refresh(); return;
    }
    if (action === 'import-cards') {
      const form = element.closest('.form-panel');
      const result = await api('/api/admin/cards/import', { method: 'POST', body: JSON.stringify({
        variantId: form.querySelector('[name="card-variant"]').value,
        batchLabel: form.querySelector('[name="card-label"]').value,
        rawCards: form.querySelector('[name="card-raw"]').value,
      }) });
      toast(`导入完成：成功 ${result.imported} 条，跳过重复 ${result.duplicate} 条。`);
      await refresh(); return;
    }
    if (action === 'save-bot-token') {
      const input = document.querySelector('[name="telegram-bot-token"]');
      const button = element;
      const token = input?.value.trim() ?? '';
      if (!token) throw new Error('请先输入 Bot Token。');
      button.disabled = true;
      state.settingsNotice = { type: 'info', text: '正在保存 Bot Token…' };
      render();
      const result = await api('/api/admin/settings', { method: 'PATCH', body: JSON.stringify({ telegramBotToken: token }) });
      const savedAt = result.savedAt ? new Date(result.savedAt).toLocaleString('zh-CN') : '刚刚';
      state.settingsNotice = { type: 'success', text: `Bot Token 已保存并加密写入数据库（${savedAt}）。` };
      toast('Bot Token 保存成功。');
      await refresh();
      return;
    }
    if (action === 'save-store') {
      const name = document.querySelector('[name="store-name"]')?.value.trim() ?? '';
      if (!name) throw new Error('店铺名称不能为空。');
      state.storeNotice = { type: 'info', text: '正在保存店铺信息…' };
      render();
      const result = await api('/api/admin/settings', { method: 'PATCH', body: JSON.stringify({ store: {
        name,
        logo: document.querySelector('[name="store-logo"]')?.value.trim() || '',
        description: document.querySelector('[name="store-description"]')?.value.trim() || '',
      } }) });
      const savedAt = result.storeSavedAt ? new Date(result.storeSavedAt).toLocaleString('zh-CN') : '刚刚';
      state.storeNotice = { type: 'success', text: `店铺信息已保存（${savedAt}），买家端顶部立即生效。` };
      toast('店铺信息保存成功。');
      await refresh();
      return;
    }
    if (action === 'save-payment') {
      const form = document.querySelector('.payment-panel');
      const body = {
        payment: {
          enabled: form.querySelector('[name="payment-enabled"]').value === 'true',
          baseUrl: form.querySelector('[name="payment-base-url"]').value.trim(),
          keyId: form.querySelector('[name="payment-key-id"]').value.trim(),
          secret: form.querySelector('[name="payment-secret"]').value,
          webhookSecret: form.querySelector('[name="payment-webhook-secret"]').value,
          chain: form.querySelector('[name="payment-chain"]').value,
          tokenId: form.querySelector('[name="payment-token-id"]').value.trim(),
          ttlMinutes: Number(form.querySelector('[name="payment-ttl"]').value),
        },
      };
      state.paymentSaving = true;
      state.paymentNotice = { type: 'info', text: '正在保存支付配置…' };
      render();
      const result = await api('/api/admin/settings', { method: 'PATCH', body: JSON.stringify(body) });
      state.paymentSaving = false;
      state.paymentNotice = { type: 'success', text: `支付配置已保存并立即生效（${new Date(result.paymentSavedAt ?? Date.now()).toLocaleString('zh-CN')}）。${result.paymentReady ? '渠道已就绪。' : '当前仍未就绪，请检查密钥或保持停用。'}` };
      toast('支付配置保存成功。');
      await refresh();
      return;
    }
    if (action === 'test-payment') {
      const result = await api('/api/admin/settings/test-payment', { method: 'POST' });
      state.paymentNotice = { type: 'success', text: `DujiaoPay 连接成功：${result.merchantId ?? result.projectId ?? '凭据有效'}。` };
      toast('支付渠道连接成功。');
      render();
      return;
    }
    if (action === 'create-credential') {
      const credential = await api('/api/admin/upstream/credentials', { method: 'POST', body: JSON.stringify({ label: document.querySelector('[name="credential-label"]')?.value.trim() ?? '' }) });
      state.secretReveal = credential;
      toast('API 凭证已创建，Secret 仅本次可见。');
      await refresh();
      return;
    }
    if (action === 'toggle-credential') {
      await api(`/api/admin/upstream/credentials/${element.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: element.dataset.active === 'true' }) });
      toast(element.dataset.active === 'true' ? '凭证已启用。' : '凭证已停用，对外采购接口将拒绝该凭证签名。');
      await refresh(); return;
    }
    if (action === 'dismiss-secret') { state.secretReveal = null; render(); return; }
    if (action === 'copy-secret') {
      await navigator.clipboard?.writeText(element.dataset.copy ?? '');
      toast('已复制。'); return;
    }
    if (action === 'create-connection') {
      const form = element.closest('.integ-panel');
      await api('/api/admin/upstream/connections', { method: 'POST', body: JSON.stringify({
        name: form.querySelector('[name="conn-name"]').value.trim(),
        baseUrl: form.querySelector('[name="conn-url"]').value.trim(),
        apiKey: form.querySelector('[name="conn-key"]').value.trim(),
        apiSecret: form.querySelector('[name="conn-secret"]').value,
        callbackUrl: form.querySelector('[name="conn-callback"]').value.trim() || undefined,
      }) });
      toast('上游连接已创建。'); await refresh(); return;
    }
    if (action === 'test-connection') {
      const result = await api(`/api/admin/upstream/connections/${element.dataset.id}/test`, { method: 'POST' });
      toast(`连接成功：${result.siteName ? `对端站点 ${result.siteName}` : '上游 /ping 响应正常'}。`);
      await refresh(); return;
    }
    if (action === 'toggle-connection') {
      await api(`/api/admin/upstream/connections/${element.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: element.dataset.active === 'true' }) });
      toast(element.dataset.active === 'true' ? '连接已启用。' : '连接已停用。');
      await refresh(); return;
    }
    if (action === 'delete-connection') {
      if (!window.confirm(`确定删除连接「${element.dataset.name}」吗？此操作不可恢复。`)) return;
      await api(`/api/admin/upstream/connections/${element.dataset.id}`, { method: 'DELETE' });
      toast('连接已删除。'); await refresh(); return;
    }
    if (action === 'sync-products') {
      const result = await api('/api/admin/upstream/sync', { method: 'POST', body: JSON.stringify({ connectionId: element.dataset.id }) });
      toast(`同步完成：拉取到 ${result.items?.length ?? 0} 件上游商品。`);
      return;
    }
    if (action === 'create-procurement') {
      const form = element.closest('.integ-panel');
      const result = await api('/api/admin/upstream/procurement', { method: 'POST', body: JSON.stringify({
        connectionId: form.querySelector('[name="proc-connection"]').value,
        skuId: form.querySelector('[name="proc-sku"]').value.trim(),
        quantity: Number(form.querySelector('[name="proc-quantity"]').value),
        downstreamOrderNo: form.querySelector('[name="proc-order"]').value.trim() || undefined,
      }) });
      toast(`采购单已创建：${result.orderId ?? result.orderNo ?? '已提交'}。`);
      return;
    }
    if (action === 'open-refund') {
      state.refundTarget = { orderNo: element.dataset.orderNo, name: element.dataset.name, amount: Number(element.dataset.amount) };
      render(); return;
    }
    if (action === 'close-refund-modal') {
      if (event.target.closest('.modal-card')) return;
      state.refundTarget = null;
      render(); return;
    }
    if (action === 'confirm-refund') {
      const result = await api(`/api/admin/orders/${element.dataset.orderNo}/refund-to-balance`, { method: 'POST', body: JSON.stringify({ reason: document.querySelector('[name="refund-reason"]')?.value.trim() || '后台退款' }) });
      toast(`退款成功：${result.balanceFen !== undefined ? `余额已增加 ${money(result.balanceFen)}` : '已退款入账'}。`);
      state.refundTarget = null; await refresh(); return;
    }
    if (action === 'copy-payment-url') {
      await navigator.clipboard?.writeText(element.dataset.copy ?? '');
      toast('Webhook 地址已复制。');
      return;
    }
    if (action === 'save-admin-account') {
      const username = document.querySelector('[name="admin-username"]').value.trim();
      const password = document.querySelector('[name="admin-password"]').value;
      const confirmation = document.querySelector('[name="admin-password-confirm"]').value;
      if (password && password !== confirmation) throw new Error('两次输入的新密码不一致。');
      const body = { username };
      if (password) body.password = password;
      const account = await api('/api/admin/account', { method: 'PATCH', body: JSON.stringify(body) });
      state.user = { ...state.user, ...account };
      toast('管理员账号已更新。'); await refresh(); return;
    }
  } catch (error) {
    if (error?.status === 401 || (error instanceof Error && /后台会话|登录状态已失效/.test(error.message))) {
      state.token = '';
      state.user = null;
      sessionStorage.removeItem('xiuxian_admin_token');
      root.innerHTML = loginScreen(`后台会话已过期，请重新登录后再保存。`);
      return;
    }
    if (state.view === 'settings') state.settingsNotice = { type: 'error', text: error instanceof Error ? error.message : '保存失败，请稍后重试。' };
    if (state.view === 'payments') {
      state.paymentSaving = false;
      state.paymentNotice = { type: 'error', text: error instanceof Error ? error.message : '支付渠道操作失败，请稍后重试。' };
    } else {
      state.message = error instanceof Error ? error.message : '操作失败，请稍后重试。';
    }
    render();
  }
}

async function handleLoginSubmit(event) {
  if (!event.target.matches('[data-admin-login]')) return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector('button[type="submit"]');
  button?.setAttribute('disabled', '');
  try {
    await login(form.querySelector('[name="username"]').value, form.querySelector('[name="password"]').value);
    await refresh();
  } catch (error) {
    root.innerHTML = loginScreen(error.message);
  } finally {
    button?.removeAttribute('disabled');
  }
}

function handleUserSearch(event) {
  if (!event.target.matches('[data-user-search]')) return;
  const query = event.target.value.trim().toLowerCase();
  let visible = 0;
  for (const row of document.querySelectorAll('[data-user-row]')) {
    const matches = !query || row.dataset.search.includes(query);
    row.hidden = !matches;
    if (matches) visible += 1;
  }
  const count = document.querySelector('[data-user-count]');
  if (count) count.textContent = String(visible);
}

async function initialize() {
  root.innerHTML = loginScreen();
  try {
    if (await login()) await refresh();
  } catch (error) {
    root.innerHTML = loginScreen(error.message);
  }
}

document.addEventListener('click', (event) => void onClick(event));
document.addEventListener('input', handleUserSearch);
document.addEventListener('error', (event) => {
  if (event.target.matches('.admin-user-avatar img')) event.target.remove();
}, true);
document.addEventListener('submit', (event) => void handleLoginSubmit(event));
void initialize();
