const app = document.querySelector('#app');
const state = {
  token: '',
  user: null,
  catalog: [],
  activeTab: 'shop',
  tabTransition: null,
  orders: null,
  ordersLoading: false,
  ordersFilter: 'all',
  selectedCategory: 'all',
  detailProductId: null,
  selectedVariants: new Map(),
  checkout: null,
  orderPoll: null,
  paymentTimer: null,
  authRefreshPromise: null,
  checkoutIdempotencyKey: null,
  publicConfig: null,
  showRecharge: false,
  balanceEntries: null,
  activeRecharge: null,
  rechargePoll: null,
  rechargeTimer: null,
  // 入场动画控制：仅在首次加载 / 分类切换 / 打开详情时播放，避免频繁重绘导致动画轰炸
  catalogEnter: false,
  detailEnter: false,
};

// 最近一次渲染的二维码内容，轮询刷新时内容未变则复用已生成的 SVG，避免每 5 秒重算一次
let lastQrContent = null;
let lastBalanceFen = null;

function haptic(kind = 'light') {
  try {
    const haptics = window.Telegram?.WebApp?.HapticFeedback;
    if (!haptics) return;
    if (kind === 'selection') haptics.selectionChanged?.();
    else haptics.impactOccurred?.(kind);
  } catch { /* 震动反馈失败可忽略 */ }
}

function formatFen(fen) {
  return `¥${(Number(fen) / 100).toFixed(2)}`;
}

function animateBalanceAmounts() {
  const targets = [...document.querySelectorAll('[data-balance-amount]')];
  if (!targets.length) { lastBalanceFen = null; return; }
  const to = Number(targets[0].dataset.balance ?? 0);
  const from = Number.isFinite(lastBalanceFen) ? lastBalanceFen : to;
  lastBalanceFen = to;
  const apply = (value) => { for (const el of targets) el.textContent = formatFen(value); };
  if (from === to) { apply(to); return; }
  const start = performance.now();
  const duration = 480;
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    apply(Math.round(from + (to - from) * eased));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const icon = {
  bag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8h12l1 12H5L6 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>',
  receipt: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3.5" width="18" height="17" rx="4"/><path d="M8 9.3h8M8 12.6h6"/><circle cx="16.6" cy="16.5" r="3.2"/><path d="m15.4 16.5 1 1 1.7-1.8"/></svg>',
  shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 20 6v5c0 5-3.4 8.8-8 10-4.6-1.2-8-5-8-10V6l8-3Z"/><path d="m9 12 2 2 4-4"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="1"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/></svg>',
  settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 8h10M7 12h10M7 16h6"/></svg>',
  home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 11 9-8 9 8v10H3V11Z"/><path d="M9 21v-7h6v7"/></svg>',
  user: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3-7 8-7s8 3 8 7"/></svg>',
  package: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 7 8-4 8 4-8 4-8-4Z"/><path d="M4 7v10l8 4 8-4V7M12 11v10"/></svg>',
  support: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13v-2a8 8 0 0 1 16 0v2"/><path d="M4 13h3v6H5a1 1 0 0 1-1-1v-5ZM20 13h-3v6h2a1 1 0 0 0 1-1v-5ZM17 19c0 1-2 2-5 2"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6v5h-5M4 18v-5h5"/><path d="M6.1 9a7 7 0 0 1 11.5-2.4L20 11M4 13l2.4 4.4A7 7 0 0 0 17.9 15"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 10v6M12 7h.01"/></svg>',
  wallet: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h13a1 1 0 0 1 1 1v2"/><path d="M3 7v11a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-4"/></svg>',
};

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

// 将 #RRGGBB 转 rgba，用于主色派生浅填充 / 半透明毛玻璃底色
function hexToRgba(hex, alpha = 1) {
  if (typeof hex !== 'string') return `rgba(0,0,0,${alpha})`;
  let value = hex.trim();
  if (value.startsWith('#')) value = value.slice(1);
  let r = 0; let g = 0; let b = 0;
  if (value.length === 3) {
    r = parseInt(value[0] + value[0], 16);
    g = parseInt(value[1] + value[1], 16);
    b = parseInt(value[2] + value[2], 16);
  } else if (value.length === 6 && /^[0-9a-fA-F]{6}$/.test(value)) {
    r = parseInt(value.slice(0, 2), 16);
    g = parseInt(value.slice(2, 4), 16);
    b = parseInt(value.slice(4, 6), 16);
  } else {
    return `rgba(0,0,0,${alpha})`;
  }
  return `rgba(${r},${g},${b},${alpha})`;
}

function money(fen) {
  return `¥${(Number(fen) / 100).toFixed(2)}`;
}

function statusLabel(status) {
  return {
    pending_payment: '等待支付',
    payment_confirming: '链上确认中',
    paid: '付款已确认',
    fulfilling: '正在发卡',
    completed: '已自动发卡',
    payment_expired: '支付已过期',
    canceled: '订单已关闭',
    fulfillment_failed: '发卡需要处理',
    refunded: '已退款',
  }[status] ?? status;
}

// 订单状态分组（用于订单页顶部筛选）
const ORDER_GROUPS = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待支付', statuses: ['pending_payment'] },
  { key: 'processing', label: '进行中', statuses: ['payment_confirming', 'paid', 'fulfilling', 'fulfillment_failed'] },
  { key: 'completed', label: '已完成', statuses: ['completed'] },
  { key: 'closed', label: '已关闭', statuses: ['payment_expired', 'canceled', 'refunded'] },
];

// 订单状态在列表中的配色（区分可读性）
const STATUS_TONE = {
  pending_payment: 'warn',
  payment_confirming: 'info',
  paid: 'info',
  fulfilling: 'info',
  completed: 'ok',
  payment_expired: 'muted',
  canceled: 'muted',
  fulfillment_failed: 'danger',
  refunded: 'danger',
};

function filterOrders(statuses) {
  if (!statuses || statuses === 'all') return state.orders;
  const allowed = new Set(statuses);
  return state.orders.filter((order) => allowed.has(order.status));
}

function ordersGroupCount(group) {
  if (!state.orders) return 0;
  return filterOrders(group.statuses).length;
}

function setTelegramTheme() {
  const webApp = window.Telegram?.WebApp;
  if (!webApp) return;
  webApp.ready();
  webApp.expand();
  const theme = webApp.themeParams ?? {};
  // iOS 分组列表风格：secondary_bg 作页面底色，bg 作卡片白
  const bg = theme.secondary_bg_color || theme.bg_color || '#f2f2f7';
  const card = theme.bg_color || '#ffffff';
  const field = theme.field_bg_color || theme.input_field_color || 'rgba(120,120,128,0.12)';
  const accent = theme.accent_text_color || theme.button_color || '#0a84ff';
  const sr = document.documentElement.style;
  sr.setProperty('--ios-bg', bg);
  sr.setProperty('--ios-bg-raise', theme.bg_color || '#ffffff');
  sr.setProperty('--ios-card', card);
  sr.setProperty('--ios-field', field);
  sr.setProperty('--ios-ink', theme.text_color || '#1c1c1e');
  sr.setProperty('--ios-muted', theme.hint_color || '#8e8e93');
  sr.setProperty('--ios-subtle', theme.subtitle_text_color || theme.hint_color || 'rgba(60,60,67,0.6)');
  sr.setProperty('--ios-accent', accent);
  sr.setProperty('--ios-accent-text', theme.accent_text_color || accent);
  sr.setProperty('--ios-link', theme.link_color || accent);
  sr.setProperty('--ios-separator', theme.section_separator_color || theme.separator_color || 'rgba(60,60,67,0.22)');
  sr.setProperty('--ios-accent-soft', hexToRgba(accent, 0.12));
  sr.setProperty('--ios-accent-faint', hexToRgba(accent, 0.06));
  sr.setProperty('--ios-bar', hexToRgba(card, 0.8));
  sr.setProperty('--ios-danger', theme.destructive_text_color || '#ff3b30');
  // v1.0.23 晨曦亮色风：Telegram 原生头/背景跟随浅雾蓝底色
  webApp.setHeaderColor?.('#f3f5fb');
  webApp.setBackgroundColor?.('#f3f5fb');
  const metaThemeColor = document.querySelector('meta[name="theme-color"]');
  if (metaThemeColor) metaThemeColor.setAttribute('content', '#f3f5fb');
}

// v1.0.27 全屏模式：Telegram 官方 requestFullscreen API。
// 要求：BotFather 已为该小程序启用 Fullscreen；较新客户端；
// 必须由用户手势触发（官方限制），故在首次点击时请求。
function setupFullscreen() {
  const webApp = window.Telegram?.WebApp;
  if (!webApp || typeof webApp.requestFullscreen !== 'function') return; // 旧客户端/网页版：保持 expand 现状
  const tryEnterFullscreen = () => {
    document.removeEventListener('click', tryEnterFullscreen);
    try {
      if (!webApp.isFullscreen) {
        const result = webApp.requestFullscreen();
        // 部分客户端返回 Promise，部分返回布尔值
        if (result && typeof result.catch === 'function') result.catch(() => { /* 用户取消或环境不允许 */ });
      }
    } catch { /* 忽略全屏失败，保持当前状态 */ }
  };
  document.addEventListener('click', tryEnterFullscreen, { once: true });
}

async function requestLoginSession() {
  const telegram = window.Telegram?.WebApp;
  const initData = typeof telegram?.initData === 'string' ? telegram.initData.trim() : '';
  if (!initData) {
    throw new ApiError('无法获取 Telegram 登录信息，请关闭后从机器人菜单重新打开小程序。', 401, 'telegram_init_data_missing');
  }
  return api('/api/auth/telegram', {
    method: 'POST',
    body: JSON.stringify({ initData }),
    retryAuth: false,
  });
}

function clearBuyerSession() {
  state.token = '';
  state.user = null;
  sessionStorage.removeItem('xiuxian_token');
}

async function refreshBuyerSession() {
  if (state.authRefreshPromise) return state.authRefreshPromise;
  state.authRefreshPromise = requestLoginSession()
    .then((session) => {
      state.token = session.accessToken;
      state.user = session.user;
      return session;
    })
    .catch((error) => {
      clearBuyerSession();
      throw error;
    })
    .finally(() => { state.authRefreshPromise = null; });
  return state.authRefreshPromise;
}

async function api(path, options = {}) {
  const { retryAuth = true, ...requestOptions } = options;
  const headers = new Headers(requestOptions.headers ?? {});
  const telegramInitData = window.Telegram?.WebApp?.initData;
  if (state.token && !path.startsWith('/api/auth/')) headers.set('Authorization', `Bearer ${state.token}`);
  if (typeof telegramInitData === 'string' && telegramInitData.trim() && !path.startsWith('/api/auth/')) {
    headers.set('X-Telegram-Init-Data', telegramInitData.trim());
  }
  if (requestOptions.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...requestOptions, headers });
  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json') ? await response.json() : null;
  if (response.status === 401 && retryAuth && !path.startsWith('/api/auth/')) {
    clearBuyerSession();
    await refreshBuyerSession();
    return api(path, { ...requestOptions, retryAuth: false });
  }
  if (response.status === 401) clearBuyerSession();
  if (!response.ok) {
    throw new ApiError(payload?.error?.message ?? '请求失败，请稍后重试。', response.status, payload?.error?.code);
  }
  return payload;
}

function findProduct(productId) {
  return state.catalog.find((product) => product.id === productId);
}

function findVariant(product, variantId) {
  return product?.variants.find((variant) => variant.id === variantId) ?? product?.variants[0];
}

function renderHeader() {
  const detail = state.detailProductId ? findProduct(state.detailProductId) : null;
  if (detail) {
    return `<header class="mini-header detail-header"><button class="mini-icon-button" data-action="close-detail" title="返回商城" aria-label="返回商城">${icon.back}</button><div class="detail-header-title"><strong>${esc(detail.title)}</strong><small>商品详情</small></div><span class="header-spacer"></span></header>`;
  }
  if (state.showRecharge) {
    return `<header class="mini-header detail-header"><button class="mini-icon-button" data-action="close-recharge" title="返回我的" aria-label="返回我的">${icon.back}</button><div class="detail-header-title"><strong>余额充值</strong><small>充值与管理余额</small></div><span class="header-spacer"></span></header>`;
  }
  const titles = {
    shop: ['XiuXian', '数字商品商城'],
    orders: ['我的订单', '支付与交付记录'],
    profile: ['我的', ''],
  };
  const [title, subtitle] = titles[state.activeTab];
  return `
    <header class="mini-header">
      <div class="mini-header-title">
        ${state.activeTab === 'shop' ? '<span class="mini-logo">XX</span>' : ''}
        <div><h1>${title}</h1>${subtitle ? `<p>${subtitle}</p>` : ''}</div>
      </div>
      <div class="mini-header-actions">
        ${state.activeTab === 'orders' ? `<button class="mini-icon-button" data-action="refresh-orders" title="刷新订单" aria-label="刷新订单">${icon.refresh}</button>` : ''}
      </div>
    </header>`;
}

function productImage(product) {
  return esc(product.imageUrl || '/assets/stream-pass.png');
}

function purchaseLabel(variant) {
  if (!variant || variant.stock < 1) return '售罄';
  if (state.publicConfig?.paymentReady) return '购买';
  return state.publicConfig?.paymentConfigured ? '已暂停' : '待配置';
}

function productCard(product, index = 0, animate = false) {
  const selectedId = state.selectedVariants.get(product.id) ?? product.variants[0]?.id;
  const selected = findVariant(product, selectedId);
  const purchasable = Boolean(state.publicConfig?.paymentReady && selected && selected.stock > 0);
  const enter = animate ? ' card-enter' : '';
  const delay = animate ? ` style="animation-delay:${Math.min(index * 45, 450)}ms"` : '';
  return `
    <article class="product-card card-stack${enter}"${delay}>
      <button class="product-open" data-action="open-detail" data-product-id="${esc(product.id)}" aria-label="查看 ${esc(product.title)} 详情">
        <img class="product-image" loading="lazy" decoding="async" src="${productImage(product)}" alt="${esc(product.title)}" />
        <div class="product-body">
          <div class="product-meta"><span>${esc(product.category?.name ?? '数字商品')}</span><span>已售 ${selected?.sold ?? 0}</span></div>
          <h3 class="product-title">${esc(product.title)}</h3>
          <p class="product-description">${esc(product.description || '即时交付的数字商品')}</p>
        </div>
      </button>
      <div class="product-actions">
        <div class="product-price"><strong>${money(selected?.priceFen ?? 0)}</strong><span>${selected?.stock ?? 0} 份可售</span></div>
        <button class="buy-button" data-action="open-checkout" data-product-id="${esc(product.id)}" title="购买 ${esc(product.title)}" aria-label="购买 ${esc(product.title)}" ${!purchasable ? 'disabled' : ''}>${icon.bag}</button>
      </div>
    </article>`;
}

function productDetailView(product, animate = false) {
  const selectedId = state.selectedVariants.get(product.id) ?? product.variants[0]?.id;
  const selected = findVariant(product, selectedId);
  const purchasable = Boolean(state.publicConfig?.paymentReady && selected && selected.stock > 0);
  const minPrice = Math.min(...product.variants.map((variant) => variant.priceFen));
  const totalStock = product.variants.reduce((sum, variant) => sum + variant.stock, 0);
  const coverEnter = animate ? ' detail-enter' : '';
  const introEnter = animate ? ' detail-enter' : '';
  const sectionEnter = animate ? ' detail-enter' : '';
  const sectionDelay = animate ? ' style="animation-delay:70ms"' : '';
  return `<section class="product-detail">
    <div class="detail-cover${coverEnter}"><img decoding="async" src="${productImage(product)}" alt="${esc(product.title)}" /><span>${esc(product.category?.name ?? '数字商品')}</span></div>
    <div class="detail-intro${introEnter}"><div class="detail-kicker">即时交付 · 安全库存</div><h1>${esc(product.title)}</h1><p>${esc(product.description || '付款确认后，系统自动交付数字商品。')}</p><div class="detail-stats"><span><b>${selected?.sold ?? 0}</b> 已售</span><span><b>${totalStock}</b> 份库存</span><span>起价 <b>${money(minPrice)}</b></span></div></div>
    <section class="detail-section${sectionEnter}"><div class="detail-section-title"><h2>选择规格</h2><span>${product.variants.length} 个选项</span></div><div class="detail-variants">${product.variants.map((variant) => `<button class="detail-variant ${variant.id === selectedId ? 'active' : ''} ${variant.stock < 1 ? 'sold-out' : ''}" data-action="select-detail-variant" data-product-id="${esc(product.id)}" data-variant-id="${esc(variant.id)}" ${variant.stock < 1 ? 'disabled' : ''}><span><strong>${esc(variant.name)}</strong><small>${variant.stock > 0 ? `${variant.stock} 份可售` : '暂时售罄'}</small></span><b>${money(variant.priceFen)}</b></button>`).join('')}</div></section>
    <section class="detail-section detail-copy${sectionEnter}"${sectionDelay}><div class="detail-section-title"><h2>商品说明</h2>${icon.info}</div><p>${esc(product.instructions || '支付成功后，卡密会显示在订单详情中，请及时复制保存。')}</p></section>
    <div class="detail-buybar"><div><small>当前规格 · ${esc(selected?.name ?? '未选择')}</small><strong>${money(selected?.priceFen ?? 0)}</strong></div><button class="primary-button" data-action="open-checkout" data-product-id="${esc(product.id)}" ${!purchasable ? 'disabled' : ''}>${icon.bag}<span>${state.publicConfig?.paymentReady ? '立即购买' : state.publicConfig?.paymentConfigured ? '支付已暂停' : '支付配置中'}</span></button></div>
  </section>`;
}

function tabIndex(tab) {
  return ['shop', 'orders', 'profile'].indexOf(tab);
}

function renderMainViews(transition = null, animateCards = false) {
  const tabs = [
    ['shop', () => shopView(animateCards)],
    ['orders', ordersView],
    ['profile', profileView],
  ];
  const activeIndex = tabIndex(state.activeTab);
  const initialIndex = transition?.from ?? activeIndex;
  return `<div class="mini-tab-viewport"><div class="mini-tab-track" data-tab-track style="transform:translate3d(${initialIndex * -33.333333}%,0,0)">${tabs.map(([tab, view]) => `<div class="mini-tab-panel" data-tab-panel="${tab}" aria-hidden="${tab !== state.activeTab}" ${tab !== state.activeTab ? 'inert' : ''}>${view()}</div>`).join('')}</div></div>`;
}

function renderTabbar(transition = null) {
  const orderCount = state.orders?.length ?? 0;
  const tabs = [
    ['shop', '商城', icon.home],
    ['orders', '订单', icon.receipt],
    ['profile', '我的', icon.user],
  ];
  const activeIndex = tabIndex(state.activeTab);
  const initialIndex = transition?.from ?? activeIndex;
  return `<nav class="mini-tabbar" aria-label="主导航"><div class="mini-tabbar-inner"><span class="mini-tabbar-slider" data-tab-slider aria-hidden="true" style="transform:translate3d(${initialIndex * 100}%,0,0)"></span>${tabs.map(([tab, label, glyph]) => `<button class="mini-tab ${state.activeTab === tab ? 'active' : ''}" data-action="switch-tab" data-tab="${tab}"><span class="mini-tab-icon">${glyph}</span><span class="mini-tab-label">${label}</span>${tab === 'orders' ? `<b>${orderCount}</b>` : ''}</button>`).join('')}</div></nav>`;
}

function shopView(animate = false) {
  const categoryMap = new Map();
  for (const product of state.catalog) if (product.category) categoryMap.set(product.category.id, product.category);
  const products = state.catalog.filter((product) => state.selectedCategory === 'all' || product.category?.id === state.selectedCategory);
  return `<section class="shop-view">
    <div class="category-strip" role="tablist" aria-label="商品分类">
      <button class="category-capsule ${state.selectedCategory === 'all' ? 'active' : ''}" data-action="filter" data-category="all">全部<small>${state.catalog.length}</small></button>
      ${[...categoryMap.values()].map((category) => `<button class="category-capsule ${state.selectedCategory === category.id ? 'active' : ''}" data-action="filter" data-category="${esc(category.id)}">${esc(category.name)}<small>${state.catalog.filter((product) => product.category?.id === category.id).length}</small></button>`).join('')}
    </div>
    <div class="native-section-title"><div><span class="section-eyebrow">COLLECTION</span><h2>精选商品</h2></div><span>${products.length} 件</span></div>
    <div class="product-grid">${products.length ? products.map((product, index) => productCard(product, index, animate)).join('') : `<div class="native-empty compact">${icon.package}<h2>没有匹配商品</h2><p>切换分类看看其他商品</p></div>`}</div>
  </section>`;
}

function orderFilterStrip() {
  return `<div class="order-filter" role="tablist" aria-label="订单分类">${ORDER_GROUPS.map((group) => `<button class="order-filter-pill ${state.ordersFilter === group.key ? 'active' : ''}" data-action="order-filter" data-filter="${group.key}"><b>${group.label}</b><small>${ordersGroupCount(group)}</small></button>`).join('')}</div>`;
}

function ordersView() {
  if (state.ordersLoading) {
    return `<section class="orders-view"><div class="order-filter">${ORDER_GROUPS.map((group) => `<button class="order-filter-pill ${state.ordersFilter === group.key ? 'active' : ''}" data-action="order-filter" data-filter="${group.key}"><b>${group.label}</b><small>·</small></button>`).join('')}</div><div class="skeleton-list">${'<div class="skeleton-card"><div class="skeleton-block thumb"></div><div class="skeleton-lines"><div class="skeleton-block line w60"></div><div class="skeleton-block line w40"></div><div class="skeleton-block line w30"></div></div></div>'.repeat(4)}</div></section>`;
  }
  if (!state.orders?.length) return `<section class="native-empty">${icon.package}<h2>还没有订单</h2><p>选购数字商品后，订单会显示在这里</p><button data-action="switch-tab" data-tab="shop">去逛逛</button></section>`;
  const group = ORDER_GROUPS.find((g) => g.key === state.ordersFilter) ?? ORDER_GROUPS[0];
  const list = filterOrders(group.statuses);
  const body = list.length
    ? `<div class="native-list">${list.map((order) => {
        const tone = STATUS_TONE[order.status] ?? 'muted';
        return `<button class="native-order" data-action="view-order" data-order-no="${esc(order.orderNo)}"><div class="native-order-icon">${icon.receipt}</div><div class="native-order-main"><strong>${esc(order.productTitle)}</strong><span>${esc(order.variantName)} · ${new Date(order.createdAt).toLocaleDateString('zh-CN')}</span><small>${esc(order.orderNo)}</small></div><div class="native-order-side"><b>${money(order.totalPriceFen)}</b><span class="order-status-chip ${tone}">${esc(statusLabel(order.status))}</span>${icon.chevron}</div></button>`;
      }).join('')}</div>`
    : `<div class="native-empty compact">${icon.package}<h2>该分类下暂无订单</h2><p>“${esc(group.label)}”暂无匹配的订单记录，可切换到其他分类查看</p></div>`;
  return `<section class="orders-view">${orderFilterStrip()}${body}</section>`;
}

function profileView() {
  const firstName = state.user?.firstName ?? '';
  const lastName = state.user?.lastName ?? '';
  const displayName = `${firstName} ${lastName}`.trim() || 'Telegram 用户';
  const username = state.user?.username ? `@${state.user.username}` : '';
  const photo = state.user?.photoUrl;
  const balance = Number(state.user?.balanceFen ?? 0);
  const online = state.user?.isActive !== false;
  return `<section class="profile-view">
    <div class="profile-capsule ${online ? '' : 'offline'}">
      <div class="capsule-row">
        <div class="profile-avatar ${photo ? 'has-photo' : ''}">${photo ? `<img src="${esc(photo)}" alt="${esc(displayName)} 的 Telegram 头像" referrerpolicy="no-referrer" />` : ''}</div>
        <div class="profile-info"><h2>${esc(displayName)}</h2>${username ? `<p class="profile-username">${esc(username)}</p>` : ''}<small class="profile-id">Telegram ID：${esc(state.user?.telegramId ?? '')}</small></div>
        <span class="profile-status ${online ? 'online' : 'offline'}"><i class="status-dot"></i>${online ? '已连接' : '未连接'}</span>
      </div>
      <div class="capsule-balance"><div class="balance-label">账户余额</div><div class="balance-amount"><small>￥</small><span data-balance-amount data-balance="${balance}">${money(balance).slice(1)}</span></div><button class="balance-recharge" data-action="open-recharge">${icon.wallet}<span>充值</span></button></div>
    </div>
    <div class="native-menu">
      <button data-action="switch-tab" data-tab="orders"><span>${icon.receipt}<b>我的订单</b></span>${icon.chevron}</button>
      ${state.publicConfig?.supportUrl ? `<button data-action="open-support"><span>${icon.support}<b>联系售后</b></span>${icon.chevron}</button>` : ''}
      <div><span>${icon.shield}<b>当前版本</b></span><small>v${esc(state.publicConfig?.version ?? '1.0.19')}</small></div>
    </div>
  </section>`;
}

function rechargeView(animate = false) {
  const balance = Number(state.user?.balanceFen ?? 0);
  const entries = state.balanceEntries ?? [];
  const active = state.activeRecharge;
  if (active) {
    return `<section class="recharge-view" id="recharge-root">
      <div class="recharge-balance"><span>当前余额</span><strong data-balance-amount data-balance="${balance}">${money(balance)}</strong></div>
      ${rechargePaymentMarkup(active)}
    </section>`;
  }
  return `<section class="recharge-view" id="recharge-root">
    <div class="recharge-balance"><span>当前余额</span><strong data-balance-amount data-balance="${balance}">${money(balance)}</strong></div>
    <div class="recharge-card${animate ? ' recharge-enter' : ''}">
      <h3>充值</h3>
      <p class="recharge-tip">输入充值金额，确认后将出示收款二维码，到账后余额自动增加。</p>
      <input name="recharge-amount" class="recharge-input" type="number" inputmode="decimal" min="0.01" step="0.01" placeholder="充值金额（元）" aria-label="充值金额" />
      <button class="recharge-submit" data-action="submit-recharge">充值</button>
    </div>
    <div class="balance-history"><div class="balance-history-title"><span class="section-eyebrow">BALANCE</span><h3>余额明细</h3></div>
      ${entries.length ? `<div class="balance-list">${entries.map((entry) => { const kindLabel = { recharge: '充值', adjust: '调整', purchase: '消费', refund: '退款', expire: '过期' }[entry.kind] ?? entry.kind; return `<div class="balance-item"><div><strong>${esc(kindLabel)}</strong><small>${new Date(entry.createdAt).toLocaleString('zh-CN')}</small></div><span class="${entry.changeFen >= 0 ? 'credit' : 'debit'}">${entry.changeFen >= 0 ? '+' : ''}${money(entry.changeFen)}</span></div>`; }).join('')}</div>` : '<div class="balance-empty">暂无余额变动记录</div>'}
    </div>
  </section>`;
}

function rechargePaymentMarkup(recharge) {
  const payment = recharge.payment;
  const instructions = payment?.paymentInstructions;
  const waiting = ['pending_payment', 'payment_confirming'].includes(recharge.status);
  if (!instructions) {
    return waiting
      ? '<div class="notice error">当前充值缺少支付信息，请返回重新发起。</div>'
      : '';
  }
  if (!waiting) {
    const failed = ['payment_expired', 'canceled'].includes(recharge.status);
    const label = recharge.status === 'paid' ? '充值到账，余额已增加' : recharge.status === 'payment_confirming' ? '已检测到付款，确认中' : '充值未完成';
    return `<div class="payment-result ${failed ? 'failed' : ''}"><span class="payment-live-dot"></span><div><strong>${esc(label)}</strong><small>${esc(paymentAmountLike(recharge))}</small></div><button class="copy-button" style="margin-left:auto" data-action="back-to-recharge">返回</button></div>`;
  }
  return `<section class="embedded-payment" aria-label="充值付款信息">
    <div class="payment-status-line"><span class="payment-live-dot"></span><strong>${esc(recharge.status === 'payment_confirming' ? '已检测到付款，正在确认' : '请扫码完成付款')}</strong><span class="payment-countdown" data-payment-countdown></span></div>
    <div class="payment-qr-frame"><div id="payment-qr" class="payment-qr" role="img" aria-label="付款二维码">正在生成二维码…</div></div>
    <p class="payment-hint">请使用${esc(paymentMethodLabel(instructions.method))}扫描二维码为余额充值，到账后自动入账。</p>
    <div class="payment-network"><span>支付方式</span><strong>${esc(instructions.label)}${instructions.network ? ` · ${esc(instructions.network)}` : ''}</strong></div>
    <div class="payment-amount-row"><div><small>充值金额</small><strong>${money(recharge.amountFen)}</strong></div></div>
    ${addressOf(instructions) ? `<div class="payment-address-row"><div><small>收款地址</small><code>${esc(addressOf(instructions))}</code></div><button class="copy-button" data-action="copy-payment" data-copy="${encodeURIComponent(addressOf(instructions))}">复制地址</button></div>` : ''}
    <div class="payment-order-note"><span>充值单号：${esc(recharge.rechargeNo)}</span><button data-action="copy-payment" data-copy="${encodeURIComponent(recharge.rechargeNo)}">复制</button></div>
  </section>`;
}

function paymentAmountLike(recharge) {
  const inst = recharge.payment?.paymentInstructions;
  if (recharge.payment?.payableAmount) return `${recharge.payment.payableAmount} ${recharge.payment.tokenId ?? 'USDT'}`;
  return `${money(recharge.amountFen)}`;
}

function addressOf(instructions) {
  return instructions?.address ?? '';
}

function syncTabViewportHeight(animate = true) {
  const viewport = document.querySelector('.mini-tab-viewport');
  const activePanel = viewport?.querySelector(`[data-tab-panel="${state.activeTab}"]`);
  if (!viewport || !activePanel) return;
  if (!animate) {
    viewport.style.transition = 'none';
    viewport.style.height = `${activePanel.scrollHeight}px`;
    void viewport.offsetWidth;
    viewport.style.transition = '';
    return;
  }
  viewport.style.height = `${activePanel.scrollHeight}px`;
  requestAnimationFrame(() => { viewport.style.height = `${activePanel.scrollHeight}px`; });
}

function refreshTabPanel(tab) {
  const views = { shop: shopView, orders: ordersView, profile: profileView };
  const panel = document.querySelector(`[data-tab-panel="${tab}"]`);
  const view = views[tab];
  if (!panel || !view) return false;
  panel.innerHTML = view();
  if (tab === 'orders') {
    const badge = document.querySelector('.mini-tab[data-tab="orders"] b');
    if (badge) badge.textContent = String(state.orders?.length ?? 0);
  }
  if (tab === state.activeTab) syncTabViewportHeight();
  return true;
}

function playTabTransition(transition) {
  if (!transition || transition.from === transition.to) return;
  const track = document.querySelector('[data-tab-track]');
  const slider = document.querySelector('[data-tab-slider]');
  if (!track || !slider) return;
  const activeIndex = tabIndex(state.activeTab);
  const targetTrack = `translate3d(${activeIndex * -33.333333}%, 0, 0)`;
  const targetSlider = `translate3d(${activeIndex * 100}%, 0, 0)`;
  // 强制 reflow 提交初始位置（HTML 已渲染为旧位置），随后同步改动目标值，
  // 无需依赖 rAF 也能触发 CSS transition，后台/省电场景下更稳。
  void track.offsetWidth;
  void slider.offsetWidth;
  track.style.transform = targetTrack;
  slider.style.transform = targetSlider;
  // 兜底：个别 WebView 需要下一帧才应用，用 rAF 再强制一次（幂等，不影响已有过渡）。
  requestAnimationFrame(() => {
    track.style.transform = targetTrack;
    slider.style.transform = targetSlider;
  });
}

function renderCatalog() {
  const transition = state.tabTransition;
  state.tabTransition = null;
  const detail = state.detailProductId ? findProduct(state.detailProductId) : null;
  const inRecharge = state.showRecharge;
  const animateCards = state.catalogEnter;
  const animateDetail = state.detailEnter;
  state.catalogEnter = false;
  state.detailEnter = false;
  // 重渲染前记录滚动位置，重绘后恢复，避免在长列表中切换规格/分类时页面跳动
  const scrollY = window.scrollY;
  let content;
  if (detail) content = productDetailView(detail, animateDetail);
  else if (inRecharge) content = rechargeView(animateCards);
  else content = renderMainViews(transition, animateCards);
  const prevHeight = document.querySelector('.mini-tab-viewport')?.style.height ?? '';
  app.innerHTML = `<div class="app-shell native-shell ${detail ? 'detail-shell' : ''}">${renderHeader()}<main class="mini-content">${content}</main>${renderDrawer()}<section class="order-panel" id="order-panel"></section>${detail || inRecharge ? '' : renderTabbar(transition)}<div class="toast" id="toast" role="status"></div></div>`;
  const viewport = document.querySelector('.mini-tab-viewport');
  // 以旧高度作为过渡起点，让切换时视口高度平滑跟随位移，避免瞬跳
  if (viewport && prevHeight) {
    viewport.style.height = prevHeight;
    void viewport.offsetHeight; // 提交旧高度作为过渡起点
  }
  syncTabViewportHeight();
  playTabTransition(transition);
  window.scrollTo(0, scrollY);
  animateBalanceAmounts();
}

function renderDrawer() {
  const item = state.checkout;
  if (!item) return '<div class="drawer-backdrop" id="drawer"></div>';
  const { product, variant, quantity, message = '' } = item;
  return `
    <div class="drawer-backdrop open" id="drawer">
      <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="checkout-title">
        <div class="drawer-head"><div><h2 id="checkout-title">确认订单</h2><p class="drawer-kicker">付款成功后自动发卡</p></div><button class="close-button" data-action="close-checkout" title="关闭" aria-label="关闭">${icon.close}</button></div>
        <div class="checkout-product"><img src="${productImage(product)}" alt="" /><div><strong>${esc(product.title)}</strong><span>${esc(variant.name)} · ${money(variant.priceFen)}</span><span>库存 ${variant.stock} 份</span></div></div>
        <label class="form-label">购买数量</label>
        <div class="quantity-control"><button data-action="quantity-minus" aria-label="减少数量">−</button><output>${quantity}</output><button data-action="quantity-plus" aria-label="增加数量">+</button></div>
        <label class="form-label">支付方式</label>
        <button class="payment-choice" type="button" aria-label="USDT Tron 支付"><span><strong>${esc(String(state.publicConfig?.paymentToken ?? 'USDT').split('-').at(-1).toUpperCase())} · ${esc((state.publicConfig?.paymentChain ?? 'TRON').toUpperCase())}</strong>Mini App 内扫码付款，到账后自动发卡</span><b></b></button>
        <div class="total-line"><span>订单合计</span><strong>${money(variant.priceFen * quantity)}</strong></div>
        <button class="primary-button" data-action="submit-checkout">创建支付订单</button>
        ${message ? `<div class="notice error">${esc(message)}</div>` : '<div class="notice">订单将预留对应库存。DujiaoPay 确认到账后，系统会自动发放卡密。</div>'}
      </aside>
    </div>`;
}

function closeCheckout() {
  // 先播放收起动画（遮罩淡出 + 抽屉下滑），动画结束再移除，避免瞬间消失
  const backdrop = document.querySelector('#drawer');
  if (backdrop?.classList.contains('open')) {
    backdrop.classList.remove('open');
    setTimeout(() => {
      state.checkout = null;
      state.checkoutIdempotencyKey = null;
      renderCatalog();
    }, 260);
  } else {
    state.checkout = null;
    state.checkoutIdempotencyKey = null;
    renderCatalog();
  }
}

function paymentMethodLabel(method) {
  return {
    crypto: '数字货币付款',
    wechat: '微信付款',
    alipay: '支付宝付款',
    other: '扫码付款',
  }[method] ?? '扫码付款';
}

function paymentStatusCopy(status) {
  return {
    pending_payment: '请扫码完成付款',
    payment_confirming: '已检测到付款，正在确认',
    paid: '付款已确认，准备发卡',
    fulfilling: '付款已确认，正在发卡',
    completed: '付款成功，卡密已发放',
    payment_expired: '付款二维码已过期',
    canceled: '订单已关闭',
  }[status] ?? '等待付款状态更新';
}

function paymentAmount(order) {
  const instructions = order.payment.paymentInstructions;
  if (order.payment.payableAmount && instructions?.amountUnit) {
    return `${order.payment.payableAmount} ${instructions.amountUnit}`;
  }
  if (order.payment.payableAmount) {
    return `${order.payment.payableAmount} ${order.payment.tokenId ?? 'USDT'}`;
  }
  if (order.payment.fiatAmount && order.payment.fiatCurrency) {
    return `${order.payment.fiatAmount} ${order.payment.fiatCurrency}`;
  }
  return money(order.totalPriceFen);
}

function embeddedPaymentMarkup(order) {
  const payment = order.payment;
  const instructions = payment.paymentInstructions;
  const waiting = ['pending_payment', 'payment_confirming'].includes(order.status);
  if (!instructions) {
    return waiting
      ? '<div class="notice error">当前支付会话缺少内嵌付款信息，请关闭订单后重新下单。</div>'
      : '';
  }
  if (!waiting) {
    const failed = ['payment_expired', 'canceled'].includes(order.status);
    return `<div class="payment-result ${failed ? 'failed' : ''}"><span class="payment-live-dot"></span><div><strong>${esc(paymentStatusCopy(order.status))}</strong><small>${esc(paymentMethodLabel(instructions.method))} · ${esc(paymentAmount(order))}</small></div></div>`;
  }
  const address = instructions.address;
  const amount = paymentAmount(order);
  const expires = payment.expiresAt ? new Date(payment.expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
  return `<section class="embedded-payment" aria-label="内嵌付款信息">
    <div class="payment-status-line"><span class="payment-live-dot"></span><strong>${esc(paymentStatusCopy(order.status))}</strong><span class="payment-countdown" data-payment-countdown>${expires ? `有效期至 ${expires}` : '请完成付款'}</span></div>
    <div class="payment-qr-frame"><div id="payment-qr" class="payment-qr" role="img" aria-label="付款二维码">正在生成二维码…</div></div>
    <p class="payment-hint">请使用${esc(paymentMethodLabel(instructions.method))}扫描二维码。付款后无需跳转，页面会自动检测到账并发放卡密。</p>
    <div class="payment-network"><span>支付方式</span><strong>${esc(instructions.label)}${instructions.network ? ` · ${esc(instructions.network)}` : ''}</strong></div>
    <div class="payment-amount-row"><div><small>应付金额</small><strong>${esc(amount)}</strong></div><button class="copy-button" data-action="copy-payment" data-copy="${encodeURIComponent(payment.payableAmount ?? amount)}">复制金额</button></div>
    ${instructions.network ? `<div class="payment-network"><span>网络</span><strong>${esc(instructions.network)}</strong></div>` : ''}
    ${address ? `<div class="payment-address-row"><div><small>收款地址</small><code>${esc(address)}</code></div><button class="copy-button" data-action="copy-payment" data-copy="${encodeURIComponent(address)}">复制地址</button></div>` : ''}
    <div class="payment-order-note"><span>订单号：${esc(order.orderNo)}</span><button data-action="copy-payment" data-copy="${encodeURIComponent(order.orderNo)}">复制</button></div>
  </section>`;
}

function orderPanelMarkup(order) {
  const canRetryPaymentSession = order.status === 'pending_payment' && !order.payment.checkoutUrl && !order.payment.paymentInstructions;
  const canOpenSupport = Boolean(state.publicConfig?.supportUrl) && ['fulfillment_failed', 'payment_expired', 'canceled'].includes(order.status);
  const cards = order.cards?.length
    ? `<div class="card-list">${order.cards.map((card) => `<div class="issued-card"><div><code>${esc(card.code)}</code>${card.password ? `<code>密码：${esc(card.password)}</code>` : ''}${card.note ? `<small>${esc(card.note)}</small>` : ''}</div><button class="copy-button" data-action="copy-card" data-copy="${encodeURIComponent(`${card.code}${card.password ? `\n密码：${card.password}` : ''}`)}">复制</button></div>`).join('')}</div>`
    : '<div class="notice">支付确认后卡密将显示在这里。若链上交易仍在确认，请稍后刷新订单状态。</div>';
  return `
    <article class="order-card">
      <button class="close-button" data-action="close-order" title="关闭订单" aria-label="关闭订单">${icon.close}</button>
      <h2>${esc(order.productTitle)}</h2>
      <p class="order-no">${esc(order.orderNo)} · ${esc(order.variantName)} · ${order.quantity} 件</p>
      <span class="order-status">${esc(statusLabel(order.status))}</span>
      <div class="total-line"><span>订单金额</span><strong>${money(order.totalPriceFen)}</strong></div>
      ${embeddedPaymentMarkup(order)}
      ${order.status === 'pending_payment' && !order.payment.paymentInstructions ? `<div class="notice">${order.payment.payableAmount ? `应付 ${esc(paymentAmount(order))} · ` : ''}订单会在 ${order.payment.expiresAt ? new Date(order.payment.expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '有效期内'} 完成付款。</div>` : ''}
      ${canRetryPaymentSession ? '<button class="primary-button" data-action="retry-payment-session">重新创建支付会话</button>' : ''}
      ${order.status === 'fulfillment_failed' ? `<div class="notice error">${esc(order.failureReason ?? '发卡任务异常，请联系售后。')}</div>` : ''}
      ${canOpenSupport ? '<button class="copy-button" style="margin-top:12px" data-action="open-support">联系售后</button>' : ''}
      <h3 style="margin:26px 0 10px;font-size:15px">已发放卡密</h3>
      ${cards}
      <button class="copy-button" style="margin-top:18px" data-action="refresh-order">刷新订单状态</button>
    </article>`;
}

function stopPaymentTimer() {
  if (state.paymentTimer) clearInterval(state.paymentTimer);
  state.paymentTimer = null;
}

function renderPaymentQr(order, force = false) {
  const target = document.querySelector('#payment-qr');
  const instructions = order.payment?.paymentInstructions;
  if (!target || !instructions?.qrContent) return;
  // 内容未变化且页面上已有二维码时跳过重建（轮询刷新复用，避免每 5 秒重算）
  if (!force && lastQrContent === instructions.qrContent && target.querySelector('svg')) return;
  lastQrContent = instructions.qrContent;
  if (typeof window.qrcode !== 'function') {
    target.textContent = '二维码组件加载失败，请刷新页面。';
    return;
  }
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(instructions.qrContent, 'Byte');
    qr.make();
    target.innerHTML = qr.createSvgTag({
      scalable: true,
      cellSize: 5,
      margin: 14,
      alt: { text: `${instructions.label} ${instructions.network ?? ''} 付款二维码` },
      title: { text: '付款二维码' },
    });
  } catch {
    target.textContent = '二维码内容过长或无效，请复制收款地址付款。';
  }
}

function startPaymentTimer(order) {
  stopPaymentTimer();
  const target = document.querySelector('[data-payment-countdown]');
  if (!target || !order.payment?.expiresAt) return;
  const expiresAt = new Date(order.payment.expiresAt).getTime();
  const serverTime = new Date(order.payment.serverTime ?? '').getTime();
  const clockOffset = Number.isFinite(serverTime) ? serverTime - Date.now() : 0;
  const tick = () => {
    const remaining = expiresAt - (Date.now() + clockOffset);
    if (remaining <= 0) {
      target.textContent = '二维码已过期';
      target.classList.add('expired');
      stopPaymentTimer();
      return;
    }
    const seconds = Math.floor(remaining / 1000);
    const minutes = Math.floor(seconds / 60);
    const rest = String(seconds % 60).padStart(2, '0');
    target.textContent = `剩余 ${String(minutes).padStart(2, '0')}:${rest}`;
  };
  tick();
  state.paymentTimer = setInterval(tick, 1000);
}

function setupPaymentView(order, forceQr = false) {
  if (!order.payment?.paymentInstructions || !['pending_payment', 'payment_confirming'].includes(order.status)) {
    stopPaymentTimer();
    return;
  }
  renderPaymentQr(order, forceQr);
  startPaymentTimer(order);
}

async function openOrder(orderNo, replaceHistory = true) {
  clearInterval(state.orderPoll);
  stopPaymentTimer();
  const panel = document.querySelector('#order-panel');
  panel.classList.add('open');
  panel.innerHTML = '<article class="order-card"><p>正在读取订单…</p></article>';
  try {
    const order = await api(`/api/orders/${encodeURIComponent(orderNo)}`);
    updateOrderPanel(order, true);
    if (replaceHistory) history.replaceState({}, '', `/orders/${order.orderNo}`);
    if (['pending_payment', 'payment_confirming', 'paid', 'fulfilling'].includes(order.status)) {
      state.orderPoll = setInterval(() => void refreshOrder(order.orderNo), 5000);
    }
  } catch (error) {
    panel.innerHTML = `<article class="order-card"><button class="close-button" data-action="close-order">${icon.close}</button><p>${esc(error.message)}</p></article>`;
  }
}

function updateOrderPanel(order, forceQr = false) {
  const panel = document.querySelector('#order-panel');
  if (!panel) return;
  const scrollTop = panel.scrollTop;
  // 轮询刷新前保留当前二维码 SVG，内容未变时直接复用，避免每 5 秒重算一次
  const qrSvg = document.querySelector('#payment-qr svg')?.outerHTML ?? null;
  const qrContent = order.payment?.paymentInstructions?.qrContent ?? null;
  panel.innerHTML = orderPanelMarkup(order);
  panel.scrollTop = scrollTop;
  const target = document.querySelector('#payment-qr');
  if (!forceQr && qrSvg && target && !target.querySelector('svg') && lastQrContent === qrContent) {
    target.innerHTML = qrSvg;
  }
  setupPaymentView(order, forceQr);
}

async function refreshOrder(orderNo) {
  const panel = document.querySelector('#order-panel');
  if (!panel?.classList.contains('open')) return;
  try {
    const order = await api(`/api/orders/${encodeURIComponent(orderNo)}`);
    updateOrderPanel(order, false);
    if (['completed', 'payment_expired', 'canceled', 'fulfillment_failed'].includes(order.status)) clearInterval(state.orderPoll);
  } catch { /* Keep the current order view during a transient network failure. */ }
}

function closeOrder() {
  clearInterval(state.orderPoll);
  stopPaymentTimer();
  const panel = document.querySelector('#order-panel');
  panel?.classList.remove('open');
  history.replaceState({}, '', '/');
  if (state.activeTab === 'orders') {
    state.orders = null;
    // 等待关闭过渡播放完再刷新列表，避免动画被重建打断
    setTimeout(() => void loadOrders(true), 200);
  }
}

async function loadOrders(force = false, { renderLoading = true } = {}) {
  if (state.orders && !force) {
    if (renderLoading) renderCatalog();
    return;
  }
  state.ordersLoading = true;
  if (renderLoading) renderCatalog();
  try {
    state.orders = await api('/api/orders');
  } finally {
    state.ordersLoading = false;
    if (!refreshTabPanel('orders')) renderCatalog();
  }
}

function openDetail(productId) {
  const product = findProduct(productId);
  if (!product) return;
  state.detailProductId = product.id;
  state.detailEnter = true;
  haptic('light');
  history.pushState({}, '', `/products/${encodeURIComponent(product.slug)}`);
  renderCatalog();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function closeDetail() {
  state.detailProductId = null;
  history.pushState({}, '', '/');
  renderCatalog();
}

async function switchTab(tab) {
  if (!['shop', 'orders', 'profile'].includes(tab)) return;
  const previousTab = state.activeTab;
  state.detailProductId = null;
  state.showRecharge = false;
  clearInterval(state.orderPoll);
  stopPaymentTimer();
  // 离开充值页时停止充值轮询与倒计时（activeRecharge 保留，回来可继续查看）
  clearInterval(state.rechargePoll);
  clearInterval(state.rechargeTimer);
  state.activeTab = tab;
  if (previousTab !== tab) state.tabTransition = { from: tabIndex(previousTab), to: tabIndex(tab) };
  if (tab === 'orders' && !state.orders) state.ordersLoading = true;
  history.replaceState({}, '', '/');
  renderCatalog();
  haptic('selection');
  if (tab === 'orders') await loadOrders(false, { renderLoading: false });
}

async function showOrders() {
  return switchTab('orders');
}

async function loadBalance(force = false) {
  try {
    const data = await api('/api/me/balance');
    if (state.user) state.user.balanceFen = data.balanceFen;
    state.balanceEntries = data.entries ?? [];
  } catch { /* transient errors keep existing balance view */ }
  if (state.showRecharge) renderCatalog();
}

async function submitRecharge() {
  const amount = Number(document.querySelector('[name="recharge-amount"]')?.value);
  if (!Number.isFinite(amount) || amount <= 0) {
    showToast('请输入正确的充值金额。');
    return;
  }
  if (!state.publicConfig?.paymentReady) {
    showToast(state.publicConfig?.paymentConfigured ? '支付渠道已暂停，请稍后再试。' : '支付渠道未配置，暂无法充值。');
    return;
  }
  const button = document.querySelector('[data-action="submit-recharge"]');
  button?.setAttribute('disabled', '');
  try {
    const idempotencyKey = `rcg_${crypto.randomUUID().replaceAll('-', '')}`;
    const { recharge } = await api('/api/me/recharge', {
      method: 'POST',
      body: JSON.stringify({ amount, idempotencyKey }),
    });
    state.activeRecharge = recharge;
    renderCatalog();
    setupRechargePaymentView(recharge);
  } catch (error) {
    showToast(error instanceof Error ? error.message : '发起充值失败，请稍后重试。');
    button?.removeAttribute('disabled');
  }
}

function setupRechargePaymentView(recharge) {
  const instructions = recharge.payment?.paymentInstructions;
  if (instructions) renderPaymentQrFor(recharge);
  startRechargeCountdown(recharge);
  if (['pending_payment', 'payment_confirming'].includes(recharge.status)) {
    clearInterval(state.rechargePoll);
    state.rechargePoll = setInterval(() => void pollRecharge(recharge.rechargeNo), 4000);
  }
}

function renderPaymentQrFor(recharge) {
  const target = document.querySelector('#payment-qr');
  const instructions = recharge.payment?.paymentInstructions;
  if (!target || !instructions?.qrContent) return;
  if (lastQrContent === instructions.qrContent && target.querySelector('svg')) return;
  lastQrContent = instructions.qrContent;
  if (typeof window.qrcode !== 'function') { target.textContent = '二维码组件加载失败，请刷新页面。'; return; }
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(instructions.qrContent, 'Byte');
    qr.make();
    target.innerHTML = qr.createSvgTag({ scalable: true, cellSize: 5, margin: 14 });
  } catch {
    target.textContent = '二维码内容无效，请复制收款地址付款。';
  }
}

function startRechargeCountdown(recharge) {
  const target = document.querySelector('[data-payment-countdown]');
  if (!target || !recharge.payment?.expiresAt) { if (target) target.textContent = '请完成付款'; return; }
  const expiresAt = new Date(recharge.payment.expiresAt).getTime();
  const tick = () => {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) { target.textContent = '二维码已过期'; target.classList.add('expired'); return; }
    const s = Math.floor(remaining / 1000);
    target.textContent = `剩余 ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  tick();
  clearInterval(state.rechargeTimer);
  state.rechargeTimer = setInterval(tick, 1000);
}

async function pollRecharge(rechargeNo) {
  try {
    const data = await api(`/api/me/recharge/${rechargeNo}`);
    if (!data?.rechargeNo) return;
    state.activeRecharge = data;
    const root = document.querySelector('#recharge-root');
    if (root) {
      // 仅局部刷新充值视图：保留二维码 SVG、不重建整个页面
      const svg = document.querySelector('#payment-qr svg')?.outerHTML ?? null;
      root.outerHTML = rechargeView();
      const target = document.querySelector('#payment-qr');
      if (svg && target && !target.querySelector('svg') && lastQrContent === (data.payment?.paymentInstructions?.qrContent ?? null)) {
        target.innerHTML = svg;
      }
      setupRechargePaymentView(data);
    }
    if (['paid', 'payment_expired', 'canceled'].includes(data.status)) {
      clearInterval(state.rechargePoll);
      clearInterval(state.rechargeTimer);
      await refreshUserAndBalance();
      if (root) renderCatalog();
    } else if (data.payment?.paymentInstructions && !document.querySelector('#payment-qr')) {
      setupRechargePaymentView(data);
    }
  } catch { /* transient errors keep polling */ }
}

async function refreshUserAndBalance() {
  try {
    const data = await api('/api/me/balance');
    if (state.user) state.user.balanceFen = data.balanceFen;
    state.balanceEntries = data.entries ?? [];
  } catch { /* ignore */ }
}

function showToast(message) {
  const toast = document.querySelector('#toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2200);
}

function openExternalUrl(url) {
  if (!url) return;
  const webApp = window.Telegram?.WebApp;
  if (url.startsWith('tg://') && webApp?.openTelegramLink) webApp.openTelegramLink(url);
  else if (webApp?.openLink) webApp.openLink(url);
  else window.location.assign(url);
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

async function submitCheckout() {
  const item = state.checkout;
  if (!item) return;
  const button = document.querySelector('[data-action="submit-checkout"]');
  button?.setAttribute('disabled', '');
  haptic('medium');
  try {
    const idempotencyKey = state.checkoutIdempotencyKey ?? `buy_${crypto.randomUUID().replaceAll('-', '')}`;
    state.checkoutIdempotencyKey = idempotencyKey;
    const order = await api('/api/orders', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ variantId: item.variant.id, quantity: item.quantity }),
    });
    state.checkout = null;
    state.checkoutIdempotencyKey = null;
    state.orders = null;
    state.detailProductId = null;
    state.activeTab = 'orders';
    renderCatalog();
    showToast('支付订单已创建，请在当前页面扫码付款。');
    await openOrder(order.orderNo);
  } catch (error) {
    state.checkout = { ...item, message: error.message };
    renderCatalog();
  }
}

async function onClick(event) {
  const actionElement = event.target.closest('[data-action]');
  if (!actionElement) return;
  const action = actionElement.dataset.action;
  if (action === 'switch-tab') return switchTab(actionElement.dataset.tab);
  if (action === 'refresh-orders') {
    state.orders = null;
    return loadOrders(true);
  }
  if (action === 'reload') {
    location.reload();
    return;
  }
  if (action === 'filter') {
    state.selectedCategory = actionElement.dataset.category;
    state.catalogEnter = true;
    haptic('selection');
    renderCatalog();
    return;
  }
  if (action === 'order-filter') {
    state.ordersFilter = actionElement.dataset.filter;
    refreshTabPanel('orders');
    return;
  }
  if (action === 'open-detail') {
    return openDetail(actionElement.dataset.productId);
  }
  if (action === 'close-detail') {
    return closeDetail();
  }
  if (action === 'open-recharge') {
    state.showRecharge = true;
    state.balanceEntries = null;
    state.catalogEnter = true;
    history.pushState({}, '', '/wallet');
    renderCatalog();
    void loadBalance();
    return;
  }
  if (action === 'close-recharge') {
    state.showRecharge = false;
    state.activeRecharge = null;
    clearInterval(state.rechargePoll);
    clearInterval(state.rechargeTimer);
    history.pushState({}, '', '/');
    renderCatalog();
    return;
  }
  if (action === 'back-to-recharge') {
    state.activeRecharge = null;
    clearInterval(state.rechargePoll);
    clearInterval(state.rechargeTimer);
    renderCatalog();
    return;
  }
  if (action === 'submit-recharge') {
    return submitRecharge();
  }
  if (action === 'select-detail-variant') {
    state.selectedVariants.set(actionElement.dataset.productId, actionElement.dataset.variantId);
    haptic('selection');
    renderCatalog();
    return;
  }
  if (action === 'open-checkout') {
    if (!state.publicConfig?.paymentReady) return showToast(state.publicConfig?.paymentConfigured ? '支付渠道已暂停，请稍后再试。' : '支付渠道正在配置，请稍后再试。');
    const product = findProduct(actionElement.dataset.productId);
    const variant = findVariant(product, state.selectedVariants.get(product.id));
    if (!variant || variant.stock < 1) return showToast('该规格库存不足。');
    state.checkoutIdempotencyKey = null;
    state.checkout = { product, variant, quantity: 1 };
    haptic('light');
    renderCatalog();
    return;
  }
  if (action === 'close-checkout') {
    return closeCheckout();
  }
  if (action === 'quantity-minus' || action === 'quantity-plus') {
    const item = state.checkout;
    if (!item) return;
    const direction = action === 'quantity-plus' ? 1 : -1;
    const maximum = Math.min(item.variant.maxPerOrder, item.variant.stock);
    item.quantity = Math.max(1, Math.min(maximum, item.quantity + direction));
    haptic('selection');
    renderCatalog();
    return;
  }
  if (action === 'submit-checkout') return submitCheckout();
  if (action === 'open-orders') return showOrders();
  if (action === 'close-order') return closeOrder();
  if (action === 'view-order') return openOrder(actionElement.dataset.orderNo);
  if (action === 'refresh-order') {
    const orderNo = location.pathname.match(/XX\d{14}[A-F0-9]{8}/)?.[0];
    if (orderNo) return refreshOrder(orderNo);
  }
  if (action === 'retry-payment-session') {
    const orderNo = location.pathname.match(/XX\d{14}[A-F0-9]{8}/)?.[0];
    if (!orderNo) return;
    actionElement.setAttribute('disabled', '');
    await api(`/api/orders/${orderNo}/payment-session`, { method: 'POST' });
    showToast('付款信息已恢复。');
    return refreshOrder(orderNo);
  }
  if (action === 'open-support') {
    return openExternalUrl(state.publicConfig?.supportUrl);
  }
  if (action === 'copy-payment') {
    const content = decodeURIComponent(actionElement.dataset.copy ?? '');
    await copyText(content);
    return showToast('付款信息已复制。');
  }
  if (action === 'copy-card') {
    const content = decodeURIComponent(actionElement.dataset.copy ?? '');
    await copyText(content);
    return showToast('卡密已复制。');
  }
}

function onChange(event) {
  const select = event.target.closest('.variant-select');
  if (!select) return;
  state.selectedVariants.set(select.dataset.productId, select.value);
  renderCatalog();
}

function routeProductSlug() {
  const slug = location.pathname.match(/^\/products\/([^/]+)$/)?.[1];
  if (!slug) return null;
  return state.catalog.find((product) => product.slug === decodeURIComponent(slug))?.id ?? null;
}

async function initialize() {
  app.innerHTML = '<main class="page"><div class="empty">正在连接 XiuXian…</div></main>';
  try {
    clearBuyerSession();
    setTelegramTheme();
    setupFullscreen();
    await refreshBuyerSession();
    [state.publicConfig, state.catalog] = await Promise.all([
      api('/api/public-config'),
      api('/api/catalog'),
    ]);
    for (const product of state.catalog) {
      const initialVariant = product.variants.find((variant) => variant.stock > 0) ?? product.variants[0];
      state.selectedVariants.set(product.id, initialVariant?.id);
    }
    const existingOrder = location.pathname.match(/orders\/(XX\d{14}[A-F0-9]{8})/)?.[1];
    const detailProductId = routeProductSlug();
    if (existingOrder) state.activeTab = 'orders';
    if (detailProductId) state.detailProductId = detailProductId;
    if (location.pathname.startsWith('/wallet')) {
      state.activeTab = 'profile';
      state.showRecharge = true;
    }
    renderCatalog();
    if (state.showRecharge) void loadBalance();
    if (existingOrder) await openOrder(existingOrder, false);
  } catch (error) {
    app.innerHTML = `<main class="page"><div class="empty"><strong>暂时无法进入商店</strong><p>${esc(error.message)}</p><button class="copy-button" data-action="reload">重新连接</button></div></main>`;
  }
}

document.addEventListener('click', (event) => {
  void onClick(event).catch((error) => {
    event.target.closest('[data-action]')?.removeAttribute('disabled');
    showToast(error instanceof Error ? error.message : '操作失败，请稍后重试。');
  });
});
document.addEventListener('change', onChange);
window.addEventListener('popstate', () => {
  const detailProductId = routeProductSlug();
  state.detailProductId = detailProductId;
  if (location.pathname.startsWith('/wallet')) {
    state.activeTab = 'profile';
    state.showRecharge = true;
  } else {
    state.showRecharge = false;
    if (!detailProductId) state.activeTab = 'shop';
  }
  renderCatalog();
});
document.addEventListener('error', (event) => {
  if (event.target.matches('.profile-avatar img')) {
    event.target.closest('.profile-avatar')?.classList.remove('has-photo');
    event.target.remove();
    return;
  }
  if (event.target.matches('.product-image, .detail-cover img, .checkout-product img')) {
    event.target.src = '/assets/stream-pass.png';
  }
}, true);
void initialize();
