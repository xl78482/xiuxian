const app = document.querySelector('#app');
const state = {
  token: sessionStorage.getItem('xiuxian_token') ?? '',
  user: null,
  catalog: [],
  selectedCategory: 'all',
  selectedVariants: new Map(),
  checkout: null,
  orderPoll: null,
  checkoutIdempotencyKey: null,
  publicConfig: null,
};

const icon = {
  bag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8h12l1 12H5L6 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>',
  receipt: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h16v18l-3-2-3 2-3-2-3 2-3-2V3Z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
  shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 20 6v5c0 5-3.4 8.8-8 10-4.6-1.2-8-5-8-10V6l8-3Z"/><path d="m9 12 2 2 4-4"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="1"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/></svg>',
  settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 8h10M7 12h10M7 16h6"/></svg>',
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
  webApp.setHeaderColor?.('#f4f1e9');
  webApp.setBackgroundColor?.('#f4f1e9');
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (state.token) headers.set('Authorization', `Bearer ${state.token}`);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...options, headers });
  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) throw new Error(payload?.error?.message ?? '请求失败，请稍后重试。');
  return payload;
}

async function login() {
  setTelegramTheme();
  const telegram = window.Telegram?.WebApp;
  let session;
  if (telegram?.initData) {
    session = await api('/api/auth/telegram', { method: 'POST', body: JSON.stringify({ initData: telegram.initData }) });
  } else {
    const params = new URLSearchParams(location.search);
    session = await api('/api/auth/development', {
      method: 'POST',
      body: JSON.stringify({ telegramId: Number(params.get('devUser') ?? 100000001), username: 'Local Preview' }),
    });
  }
  state.token = session.accessToken;
  state.user = session.user;
  sessionStorage.setItem('xiuxian_token', state.token);
}

function findProduct(productId) {
  return state.catalog.find((product) => product.id === productId);
}

function findVariant(product, variantId) {
  return product?.variants.find((variant) => variant.id === variantId) ?? product?.variants[0];
}

function renderHeader() {
  return `
    <header class="topbar">
      <a class="brand" href="/" aria-label="返回 XiuXian 首页">
        <span class="brand-mark">XX</span>
        <span>XiuXian<small>Digital delivery</small></span>
      </a>
      <nav class="nav-actions" aria-label="操作">
        ${state.user?.isAdmin ? `<a class="icon-button" href="/admin" title="管理后台" aria-label="管理后台">${icon.settings}</a>` : ''}
        <button class="icon-button" data-action="open-orders" title="我的订单" aria-label="我的订单">${icon.receipt}</button>
      </nav>
    </header>`;
}

function productCard(product) {
  const selectedId = state.selectedVariants.get(product.id) ?? product.variants[0]?.id;
  const selected = findVariant(product, selectedId);
  const image = product.imageUrl ? esc(product.imageUrl) : '';
  return `
    <article class="product-card">
      <img class="product-image" src="${image}" alt="${esc(product.title)}" />
      <div class="product-body">
        <div class="product-meta"><span>${esc(product.category?.name ?? '数字商品')}</span><span>已售 ${selected?.sold ?? 0}</span></div>
        <h3 class="product-title">${esc(product.title)}</h3>
        <p class="product-description">${esc(product.description)}</p>
        <div class="variant-row">
          <select class="variant-select" data-product-id="${esc(product.id)}" aria-label="选择 ${esc(product.title)} 规格">
            ${product.variants.map((variant) => `<option value="${esc(variant.id)}" ${variant.id === selectedId ? 'selected' : ''} ${variant.stock < 1 ? 'disabled' : ''}>${esc(variant.name)} · ${money(variant.priceFen)}${variant.stock < 1 ? ' · 售罄' : ''}</option>`).join('')}
          </select>
          <button class="buy-button" data-action="open-checkout" data-product-id="${esc(product.id)}" title="购买 ${esc(product.title)}" aria-label="购买 ${esc(product.title)}" ${!selected || selected.stock < 1 ? 'disabled' : ''}>${icon.bag}</button>
        </div>
        <div class="stock-line"><span>${esc(selected?.name ?? '')}</span><strong>${selected?.stock ?? 0} 份可售</strong></div>
      </div>
    </article>`;
}

function renderCatalog() {
  const categoryMap = new Map();
  for (const product of state.catalog) {
    if (product.category) categoryMap.set(product.category.id, product.category);
  }
  const products = state.selectedCategory === 'all'
    ? state.catalog
    : state.catalog.filter((product) => product.category?.id === state.selectedCategory);
  app.innerHTML = `
    <div class="app-shell">
      ${renderHeader()}
      <main class="page">
        <section class="hero">
          <div>
            <span class="eyebrow">Telegram instant store</span>
            <h1>支付确认后，<em>卡密即刻</em>送达。</h1>
            <p class="hero-copy">浏览会员、点卡和兑换码。每一笔订单由服务端验证付款后自动从加密卡池发放，订单页随时可再次查看。</p>
            <div class="hero-note"><span></span>当前支付方式：USDT · TRON</div>
          </div>
          <div class="hero-art" aria-hidden="true">
            <div class="hero-orbit"></div>
            <div class="hero-card"><div class="card-top"><span>XIUXIAN</span><span>01</span></div><div class="card-symbol">↗</div><div class="card-bottom">DIGITAL<br/>ACCESS</div></div>
          </div>
        </section>
        <section aria-labelledby="catalog-title">
          <div class="section-head"><div><h2 id="catalog-title">精选数字商品</h2><p>即时交付 · 可重复查看</p></div><p>${state.user ? `已登录：${esc(state.user.firstName)}` : ''}</p></div>
          <div class="filter-row" role="tablist" aria-label="商品分类">
            <button class="filter ${state.selectedCategory === 'all' ? 'active' : ''}" data-action="filter" data-category="all">全部</button>
            ${[...categoryMap.values()].map((category) => `<button class="filter ${state.selectedCategory === category.id ? 'active' : ''}" data-action="filter" data-category="${esc(category.id)}">${esc(category.name)}</button>`).join('')}
          </div>
          <div class="product-grid">${products.length ? products.map(productCard).join('') : '<div class="empty">该分类暂时没有可展示商品。</div>'}</div>
        </section>
        <section class="bottom-band">
          <div class="info-strip"><strong>付款验证后发卡</strong><span>浏览器跳转只用于体验。真正的订单完成以服务端支付回调和订单状态为准。</span></div>
          <div class="info-strip coral"><strong>卡密永久留档</strong><span>发放成功后，卡密始终保存在“我的订单”中，支持一键复制和售后查询。${state.publicConfig?.supportUrl ? ' <button class="support-link" data-action="open-support">联系售后</button>' : ''}</span></div>
        </section>
      </main>
      ${renderDrawer()}
      <section class="order-panel" id="order-panel"></section>
      <div class="toast" id="toast" role="status"></div>
    </div>`;
}

function renderDrawer() {
  const item = state.checkout;
  if (!item) return '<div class="drawer-backdrop" id="drawer"></div>';
  const { product, variant, quantity, message = '' } = item;
  return `
    <div class="drawer-backdrop open" id="drawer">
      <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="checkout-title">
        <div class="drawer-head"><div><h2 id="checkout-title">确认订单</h2><p class="drawer-kicker">付款成功后自动发卡</p></div><button class="close-button" data-action="close-checkout" title="关闭" aria-label="关闭">${icon.close}</button></div>
        <div class="checkout-product"><img src="${esc(product.imageUrl)}" alt="" /><div><strong>${esc(product.title)}</strong><span>${esc(variant.name)} · ${money(variant.priceFen)}</span><span>库存 ${variant.stock} 份</span></div></div>
        <label class="form-label">购买数量</label>
        <div class="quantity-control"><button data-action="quantity-minus" aria-label="减少数量">−</button><output>${quantity}</output><button data-action="quantity-plus" aria-label="增加数量">+</button></div>
        <label class="form-label">支付方式</label>
        <button class="payment-choice" type="button" aria-label="USDT Tron 支付"><span><strong>${esc((state.publicConfig?.paymentToken ?? 'USDT').replace('-', ' ').toUpperCase())} · ${esc((state.publicConfig?.paymentChain ?? 'TRON').toUpperCase())}</strong>独角兽支付托管收银台</span><b></b></button>
        <div class="total-line"><span>订单合计</span><strong>${money(variant.priceFen * quantity)}</strong></div>
        <button class="primary-button" data-action="submit-checkout">创建支付订单 ${icon.arrow}</button>
        ${message ? `<div class="notice error">${esc(message)}</div>` : '<div class="notice">订单将预留对应库存。DujiaoPay 确认到账后，系统会自动发放卡密。</div>'}
      </aside>
    </div>`;
}

function orderPanelMarkup(order) {
  const isMock = order.payment.provider === 'mock';
  const canPayMock = isMock && order.status === 'pending_payment';
  const canOpenCheckout = order.payment.checkoutUrl && order.status === 'pending_payment' && !isMock;
  const canRetryPaymentSession = !isMock && order.status === 'pending_payment' && !order.payment.checkoutUrl;
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
      ${order.status === 'pending_payment' ? `<div class="notice">${order.payment.payableAmount ? `应付 ${esc(order.payment.payableAmount)} ${esc(order.payment.tokenId ?? 'USDT')} · ` : ''}订单会在 ${new Date(order.payment.expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 前有效。</div>` : ''}
      ${canOpenCheckout ? '<button class="primary-button" data-action="open-payment">打开 USDT 支付页</button>' : ''}
      ${canRetryPaymentSession ? '<button class="primary-button" data-action="retry-payment-session">重新创建支付会话</button>' : ''}
      ${canPayMock ? '<button class="primary-button" data-action="complete-mock-payment">模拟付款成功并自动发卡</button>' : ''}
      ${order.status === 'fulfillment_failed' ? `<div class="notice error">${esc(order.failureReason ?? '发卡任务异常，请联系售后。')}</div>` : ''}
      ${canOpenSupport ? '<button class="copy-button" style="margin-top:12px" data-action="open-support">联系售后</button>' : ''}
      <h3 style="margin:26px 0 10px;font-size:15px">已发放卡密</h3>
      ${cards}
      <button class="copy-button" style="margin-top:18px" data-action="refresh-order">刷新订单状态</button>
    </article>`;
}

async function openOrder(orderNo, replaceHistory = true) {
  clearInterval(state.orderPoll);
  const panel = document.querySelector('#order-panel');
  panel.classList.add('open');
  panel.innerHTML = '<article class="order-card"><p>正在读取订单…</p></article>';
  try {
    const order = await api(`/api/orders/${encodeURIComponent(orderNo)}`);
    panel.innerHTML = orderPanelMarkup(order);
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
    if (['completed', 'payment_expired', 'canceled', 'fulfillment_failed'].includes(order.status)) clearInterval(state.orderPoll);
  } catch { /* Keep the current order view during a transient network failure. */ }
}

function closeOrder() {
  clearInterval(state.orderPoll);
  const panel = document.querySelector('#order-panel');
  panel?.classList.remove('open');
  history.replaceState({}, '', '/');
}

async function showOrders() {
  const panel = document.querySelector('#order-panel');
  panel.classList.add('open');
  try {
    const orders = await api('/api/orders');
    panel.innerHTML = `<article class="order-card"><button class="close-button" data-action="close-order">${icon.close}</button><h2>我的订单</h2><p class="order-no">已购买的卡密可在此永久查看</p><div class="card-list">${orders.length ? orders.map((order) => `<button class="issued-card" data-action="view-order" data-order-no="${esc(order.orderNo)}" style="text-align:left;border:1px solid var(--line)"><span><strong>${esc(order.productTitle)}</strong><code>${esc(order.orderNo)}</code></span><span class="order-status">${esc(statusLabel(order.status))}</span></button>`).join('') : '<div class="notice">暂时没有订单。</div>'}</div></article>`;
  } catch (error) {
    panel.innerHTML = `<article class="order-card"><button class="close-button" data-action="close-order">${icon.close}</button><p>${esc(error.message)}</p></article>`;
  }
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
    renderCatalog();
    if (order.payment.provider === 'mock') {
      await openOrder(order.orderNo);
      return;
    }
    showToast('支付订单已创建，正在打开收银台。');
    openExternalUrl(order.payment.checkoutUrl);
  } catch (error) {
    state.checkout = { ...item, message: error.message };
    renderCatalog();
  }
}

async function onClick(event) {
  const actionElement = event.target.closest('[data-action]');
  if (!actionElement) return;
  const action = actionElement.dataset.action;
  if (action === 'reload') {
    location.reload();
    return;
  }
  if (action === 'filter') {
    state.selectedCategory = actionElement.dataset.category;
    renderCatalog();
    return;
  }
  if (action === 'open-checkout') {
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
  if (action === 'open-payment') {
    const orderNo = location.pathname.match(/XX\d{14}[A-F0-9]{8}/)?.[0];
    if (!orderNo) return;
    const order = await api(`/api/orders/${orderNo}`);
    return openExternalUrl(order.payment.checkoutUrl);
  }
  if (action === 'complete-mock-payment') {
    const orderNo = location.pathname.match(/XX\d{14}[A-F0-9]{8}/)?.[0];
    if (!orderNo) return;
    actionElement.setAttribute('disabled', '');
    await api(`/api/dev/orders/${orderNo}/pay`, { method: 'POST' });
    showToast('模拟付款已确认，卡密已自动发放。');
    return refreshOrder(orderNo);
  }
  if (action === 'retry-payment-session') {
    const orderNo = location.pathname.match(/XX\d{14}[A-F0-9]{8}/)?.[0];
    if (!orderNo) return;
    actionElement.setAttribute('disabled', '');
    const order = await api(`/api/orders/${orderNo}/payment-session`, { method: 'POST' });
    if (order.payment.checkoutUrl) openExternalUrl(order.payment.checkoutUrl);
    return refreshOrder(orderNo);
  }
  if (action === 'open-support') {
    return openExternalUrl(state.publicConfig?.supportUrl);
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

async function initialize() {
  app.innerHTML = '<main class="page"><div class="empty">正在连接 XiuXian…</div></main>';
  try {
    if (state.token) {
      try { state.user = await api('/api/me'); } catch { state.token = ''; sessionStorage.removeItem('xiuxian_token'); }
    }
    if (!state.user) await login();
    [state.publicConfig, state.catalog] = await Promise.all([
      api('/api/public-config'),
      api('/api/catalog'),
    ]);
    for (const product of state.catalog) state.selectedVariants.set(product.id, product.variants[0]?.id);
    renderCatalog();
    const existingOrder = location.pathname.match(/(?:orders|pay\/mock)\/(XX\d{14}[A-F0-9]{8})/)?.[1];
    if (existingOrder) await openOrder(existingOrder, false);
  } catch (error) {
    app.innerHTML = `<main class="page"><div class="empty"><strong>暂时无法进入商店</strong><p>${esc(error.message)}</p><button class="copy-button" data-action="reload">重新连接</button></div></main>`;
  }
}

document.addEventListener('click', (event) => void onClick(event));
document.addEventListener('change', onChange);
void initialize();
