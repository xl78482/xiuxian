const app = document.querySelector('#app');
const state = {
  token: '',
  user: null,
  catalog: [],
  activeTab: 'shop',
  orders: null,
  ordersLoading: false,
  selectedCategory: 'all',
  searchQuery: '',
  detailProductId: null,
  selectedVariants: new Map(),
  checkout: null,
  orderPoll: null,
  paymentTimer: null,
  authRefreshPromise: null,
  checkoutIdempotencyKey: null,
  publicConfig: null,
};

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
  receipt: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h16v18l-3-2-3 2-3-2-3 2-3-2V3Z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
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
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 5 5"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 10v6M12 7h.01"/></svg>',
};

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
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

function setTelegramTheme() {
  const webApp = window.Telegram?.WebApp;
  if (!webApp) return;
  webApp.ready();
  webApp.expand();
  webApp.setHeaderColor?.('#f3f4f6');
  webApp.setBackgroundColor?.('#f3f4f6');
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
  const titles = {
    shop: ['XiuXian', '数字商品商城'],
    orders: ['我的订单', '支付与交付记录'],
    profile: ['我的', '账号与服务'],
  };
  const [title, subtitle] = titles[state.activeTab];
  return `
    <header class="mini-header">
      <div class="mini-header-title">
        ${state.activeTab === 'shop' ? '<span class="mini-logo">XX</span>' : ''}
        <div><h1>${title}</h1><p>${subtitle}</p></div>
      </div>
      <div class="mini-header-actions">
        ${state.activeTab === 'shop' ? `<button class="mini-icon-button" data-action="focus-search" title="搜索商品" aria-label="搜索商品">${icon.search}</button>` : ''}
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

function productCard(product) {
  const selectedId = state.selectedVariants.get(product.id) ?? product.variants[0]?.id;
  const selected = findVariant(product, selectedId);
  const purchasable = Boolean(state.publicConfig?.paymentReady && selected && selected.stock > 0);
  return `
    <article class="product-card">
      <button class="product-open" data-action="open-detail" data-product-id="${esc(product.id)}" aria-label="查看 ${esc(product.title)} 详情">
        <img class="product-image" src="${productImage(product)}" alt="${esc(product.title)}" />
        <div class="product-body">
          <div class="product-meta"><span>${esc(product.category?.name ?? '数字商品')}</span><span>已售 ${selected?.sold ?? 0}</span></div>
          <h3 class="product-title">${esc(product.title)}</h3>
          <p class="product-description">${esc(product.description || '即时交付的数字商品')}</p>
          <div class="product-price"><strong>${money(selected?.priceFen ?? 0)}</strong><span>${selected?.stock ?? 0} 份可售</span></div>
        </div>
      </button>
      <div class="product-actions">
        <select class="variant-select" data-product-id="${esc(product.id)}" aria-label="选择 ${esc(product.title)} 规格">
          ${product.variants.map((variant) => `<option value="${esc(variant.id)}" ${variant.id === selectedId ? 'selected' : ''} ${variant.stock < 1 ? 'disabled' : ''}>${esc(variant.name)}${variant.stock < 1 ? ' · 售罄' : ''}</option>`).join('')}
        </select>
        <button class="buy-button" data-action="open-checkout" data-product-id="${esc(product.id)}" title="购买 ${esc(product.title)}" aria-label="购买 ${esc(product.title)}" ${!purchasable ? 'disabled' : ''}>${icon.bag}<span>${purchaseLabel(selected)}</span></button>
      </div>
    </article>`;
}

function productDetailView(product) {
  const selectedId = state.selectedVariants.get(product.id) ?? product.variants[0]?.id;
  const selected = findVariant(product, selectedId);
  const purchasable = Boolean(state.publicConfig?.paymentReady && selected && selected.stock > 0);
  const minPrice = Math.min(...product.variants.map((variant) => variant.priceFen));
  const totalStock = product.variants.reduce((sum, variant) => sum + variant.stock, 0);
  return `<section class="product-detail">
    <div class="detail-cover"><img src="${productImage(product)}" alt="${esc(product.title)}" /><span>${esc(product.category?.name ?? '数字商品')}</span></div>
    <div class="detail-intro"><div class="detail-kicker">即时交付 · 安全库存</div><h1>${esc(product.title)}</h1><p>${esc(product.description || '付款确认后，系统自动交付数字商品。')}</p><div class="detail-stats"><span><b>${selected?.sold ?? 0}</b> 已售</span><span><b>${totalStock}</b> 份库存</span><span>起价 <b>${money(minPrice)}</b></span></div></div>
    <section class="detail-section"><div class="detail-section-title"><h2>选择规格</h2><span>${product.variants.length} 个选项</span></div><div class="detail-variants">${product.variants.map((variant) => `<button class="detail-variant ${variant.id === selectedId ? 'active' : ''} ${variant.stock < 1 ? 'sold-out' : ''}" data-action="select-detail-variant" data-product-id="${esc(product.id)}" data-variant-id="${esc(variant.id)}" ${variant.stock < 1 ? 'disabled' : ''}><span><strong>${esc(variant.name)}</strong><small>${variant.stock > 0 ? `${variant.stock} 份可售` : '暂时售罄'}</small></span><b>${money(variant.priceFen)}</b></button>`).join('')}</div></section>
    <section class="detail-section detail-copy"><div class="detail-section-title"><h2>商品说明</h2>${icon.info}</div><p>${esc(product.instructions || '支付成功后，卡密会显示在订单详情中，请及时复制保存。')}</p></section>
    <div class="detail-buybar"><div><small>当前规格 · ${esc(selected?.name ?? '未选择')}</small><strong>${money(selected?.priceFen ?? 0)}</strong></div><button class="primary-button" data-action="open-checkout" data-product-id="${esc(product.id)}" ${!purchasable ? 'disabled' : ''}>${icon.bag}<span>${state.publicConfig?.paymentReady ? '立即购买' : state.publicConfig?.paymentConfigured ? '支付已暂停' : '支付配置中'}</span></button></div>
  </section>`;
}

function renderTabbar() {
  const orderCount = state.orders?.length ?? 0;
  const tabs = [
    ['shop', '商城', icon.home],
    ['orders', '订单', icon.receipt],
    ['profile', '我的', icon.user],
  ];
  return `<nav class="mini-tabbar" aria-label="主导航">${tabs.map(([tab, label, glyph]) => `<button class="mini-tab ${state.activeTab === tab ? 'active' : ''}" data-action="switch-tab" data-tab="${tab}">${glyph}<span>${label}</span>${tab === 'orders' ? `<b>${orderCount}</b>` : ''}</button>`).join('')}</nav>`;
}

function shopView() {
  const categoryMap = new Map();
  for (const product of state.catalog) if (product.category) categoryMap.set(product.category.id, product.category);
  const query = state.searchQuery.trim().toLowerCase();
  const products = state.catalog.filter((product) => {
    const categoryMatch = state.selectedCategory === 'all' || product.category?.id === state.selectedCategory;
    const searchMatch = !query || `${product.title} ${product.description} ${product.category?.name ?? ''}`.toLowerCase().includes(query);
    return categoryMatch && searchMatch;
  });
  return `<section class="shop-view">
    <div class="shop-banner"><div><span>INSTANT DELIVERY</span><h2>今天想补充什么？</h2><p>${state.publicConfig?.paymentReady ? `${String(state.publicConfig.paymentToken ?? 'USDT').split('-').at(-1).toUpperCase()} · ${String(state.publicConfig.paymentChain ?? 'TRON').toUpperCase()} · 自动发卡` : '支付渠道配置中 · 暂不可下单'}</p></div><div class="banner-mark">XX</div></div>
    <label class="catalog-search">${icon.search}<input id="catalog-search" type="search" value="${esc(state.searchQuery)}" placeholder="搜索商品、类型或关键词" aria-label="搜索商品" /></label>
    <div class="filter-row" role="tablist" aria-label="商品分类">
      <button class="filter ${state.selectedCategory === 'all' ? 'active' : ''}" data-action="filter" data-category="all">全部</button>
      ${[...categoryMap.values()].map((category) => `<button class="filter ${state.selectedCategory === category.id ? 'active' : ''}" data-action="filter" data-category="${esc(category.id)}">${esc(category.name)}</button>`).join('')}
    </div>
    <div class="native-section-title"><div><span class="section-eyebrow">COLLECTION</span><h2>精选商品</h2></div><span>${products.length} 件</span></div>
    <div class="product-grid">${products.length ? products.map(productCard).join('') : `<div class="native-empty compact">${icon.package}<h2>没有匹配商品</h2><p>换个关键词或查看全部分类</p></div>`}</div>
  </section>`;
}

function ordersView() {
  if (state.ordersLoading) return '<div class="native-loading"><span></span><p>正在加载订单</p></div>';
  if (!state.orders?.length) return `<section class="native-empty">${icon.package}<h2>还没有订单</h2><p>选购数字商品后，订单会显示在这里</p><button data-action="switch-tab" data-tab="shop">去逛逛</button></section>`;
  return `<section class="orders-view"><div class="native-list">${state.orders.map((order) => `<button class="native-order" data-action="view-order" data-order-no="${esc(order.orderNo)}"><div class="native-order-icon">${icon.receipt}</div><div class="native-order-main"><strong>${esc(order.productTitle)}</strong><span>${esc(order.variantName)} · ${new Date(order.createdAt).toLocaleDateString('zh-CN')}</span><small>${esc(order.orderNo)}</small></div><div class="native-order-side"><b>${money(order.totalPriceFen)}</b><span>${esc(statusLabel(order.status))}</span>${icon.chevron}</div></button>`).join('')}</div></section>`;
}

function profileView() {
  const firstName = state.user?.firstName ?? '';
  const lastName = state.user?.lastName ?? '';
  const displayName = `${firstName} ${lastName}`.trim() || 'Telegram 用户';
  const initials = displayName.slice(0, 1).toUpperCase();
  const username = state.user?.username ? `@${state.user.username}` : '未设置 Telegram 用户名';
  const photo = state.user?.photoUrl;
  return `<section class="profile-view">
    <div class="profile-card"><div class="profile-avatar ${photo ? 'has-photo' : ''}"><span>${esc(initials)}</span>${photo ? `<img src="${esc(photo)}" alt="${esc(displayName)} 的 Telegram 头像" referrerpolicy="no-referrer" />` : ''}</div><div class="profile-info"><h2>${esc(displayName)}</h2><p>${esc(username)}</p><small>ID：${esc(state.user?.telegramId ?? '')}</small></div></div>
    <div class="native-menu">
      <button data-action="switch-tab" data-tab="orders"><span>${icon.receipt}<b>我的订单</b></span>${icon.chevron}</button>
      ${state.publicConfig?.supportUrl ? `<button data-action="open-support"><span>${icon.support}<b>联系售后</b></span>${icon.chevron}</button>` : ''}
      <div><span>${icon.shield}<b>当前版本</b></span><small>v${esc(state.publicConfig?.version ?? '1.0.8')}</small></div>
    </div>
  </section>`;
}

function renderCatalog() {
  const detail = state.detailProductId ? findProduct(state.detailProductId) : null;
  const views = { shop: shopView, orders: ordersView, profile: profileView };
  const content = detail ? productDetailView(detail) : views[state.activeTab]();
  app.innerHTML = `<div class="app-shell native-shell ${detail ? 'detail-shell' : ''}">${renderHeader()}<main class="mini-content">${content}</main>${renderDrawer()}<section class="order-panel" id="order-panel"></section>${detail ? '' : renderTabbar()}<div class="toast" id="toast" role="status"></div></div>`;
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

function renderPaymentQr(order) {
  const target = document.querySelector('#payment-qr');
  const instructions = order.payment?.paymentInstructions;
  if (!target || !instructions?.qrContent) return;
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

function setupPaymentView(order) {
  if (!order.payment?.paymentInstructions || !['pending_payment', 'payment_confirming'].includes(order.status)) {
    stopPaymentTimer();
    return;
  }
  renderPaymentQr(order);
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
    panel.innerHTML = orderPanelMarkup(order);
    setupPaymentView(order);
    if (replaceHistory) history.replaceState({}, '', `/orders/${order.orderNo}`);
    if (['pending_payment', 'payment_confirming', 'paid', 'fulfilling'].includes(order.status)) {
      state.orderPoll = setInterval(() => void refreshOrder(order.orderNo), 5000);
    }
  } catch (error) {
    panel.innerHTML = `<article class="order-card"><button class="close-button" data-action="close-order">${icon.close}</button><p>${esc(error.message)}</p></article>`;
  }
}

async function refreshOrder(orderNo) {
  const panel = document.querySelector('#order-panel');
  if (!panel?.classList.contains('open')) return;
  try {
    const order = await api(`/api/orders/${encodeURIComponent(orderNo)}`);
    panel.innerHTML = orderPanelMarkup(order);
    setupPaymentView(order);
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
    void loadOrders(true);
  }
}

async function loadOrders(force = false) {
  if (state.orders && !force) {
    renderCatalog();
    return;
  }
  state.ordersLoading = true;
  renderCatalog();
  try {
    state.orders = await api('/api/orders');
  } finally {
    state.ordersLoading = false;
    renderCatalog();
  }
}

function openDetail(productId) {
  const product = findProduct(productId);
  if (!product) return;
  state.detailProductId = product.id;
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
  state.detailProductId = null;
  clearInterval(state.orderPoll);
  stopPaymentTimer();
  state.activeTab = tab;
  history.replaceState({}, '', '/');
  renderCatalog();
  window.Telegram?.WebApp?.HapticFeedback?.selectionChanged?.();
  if (tab === 'orders') await loadOrders();
}

async function showOrders() {
  return switchTab('orders');
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
    renderCatalog();
    return;
  }
  if (action === 'focus-search') {
    document.querySelector('#catalog-search')?.focus();
    return;
  }
  if (action === 'open-detail') {
    return openDetail(actionElement.dataset.productId);
  }
  if (action === 'close-detail') {
    return closeDetail();
  }
  if (action === 'select-detail-variant') {
    state.selectedVariants.set(actionElement.dataset.productId, actionElement.dataset.variantId);
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
    renderCatalog();
    return;
  }
  if (action === 'close-checkout') {
    state.checkout = null;
    state.checkoutIdempotencyKey = null;
    renderCatalog();
    return;
  }
  if (action === 'quantity-minus' || action === 'quantity-plus') {
    const item = state.checkout;
    if (!item) return;
    const direction = action === 'quantity-plus' ? 1 : -1;
    const maximum = Math.min(item.variant.maxPerOrder, item.variant.stock);
    item.quantity = Math.max(1, Math.min(maximum, item.quantity + direction));
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

function onInput(event) {
  if (!event.target.matches('#catalog-search')) return;
  state.searchQuery = event.target.value;
  const selectionStart = event.target.selectionStart;
  renderCatalog();
  const input = document.querySelector('#catalog-search');
  input?.focus();
  if (input && selectionStart !== null) input.setSelectionRange(selectionStart, selectionStart);
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
    renderCatalog();
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
document.addEventListener('input', onInput);
window.addEventListener('popstate', () => {
  const detailProductId = routeProductSlug();
  state.detailProductId = detailProductId;
  if (!detailProductId) state.activeTab = 'shop';
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
