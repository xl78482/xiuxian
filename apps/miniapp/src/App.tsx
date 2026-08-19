import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  ClipboardList,
  Copy,
  Headphones,
  Home,
  LoaderCircle,
  Minus,
  PackageOpen,
  Plus,
  RefreshCw,
  ShieldCheck,
  ShoppingBag,
  UserRound,
  WalletCards,
} from 'lucide-react';
import QRCode from 'qrcode';
import { useRawInitData, useSignal } from '@telegram-mini-apps/sdk-react';
import { viewport } from '@telegram-mini-apps/sdk-react';
import { createApi, ApiError } from './api';
import { bindTelegramBackButton, setTelegramBackButton } from './telegram';
import type { Category, Order, PaymentMethod, Product, PublicConfig, Recharge, User, Variant } from './types';

type OrderGroup = { key: string; label: string; statuses: readonly string[] | null };

const ORDER_GROUPS: OrderGroup[] = [
  { key: 'all', label: '全部', statuses: null },
  { key: 'pending', label: '待支付', statuses: ['pending_payment'] },
  { key: 'processing', label: '进行中', statuses: ['payment_confirming', 'paid', 'fulfilling', 'fulfillment_failed'] },
  { key: 'completed', label: '已完成', statuses: ['completed'] },
  { key: 'closed', label: '已关闭', statuses: ['payment_expired', 'canceled', 'refunded'] },
];

const STATUS_LABEL: Record<string, string> = {
  pending_payment: '等待支付',
  payment_confirming: '链上确认中',
  paid: '付款已确认',
  fulfilling: '正在发卡',
  completed: '已自动发卡',
  payment_expired: '支付已过期',
  canceled: '订单已关闭',
  fulfillment_failed: '发卡需要处理',
  refunded: '已退款',
};

const STATUS_TONE: Record<string, string> = {
  pending_payment: 'status-warn',
  payment_confirming: 'status-info',
  paid: 'status-info',
  fulfilling: 'status-info',
  completed: 'status-ok',
  payment_expired: 'status-muted',
  canceled: 'status-muted',
  fulfillment_failed: 'status-danger',
  refunded: 'status-danger',
};

type Page =
  | { name: 'shop' }
  | { name: 'orders' }
  | { name: 'profile' }
  | { name: 'product'; product: Product }
  | { name: 'order'; orderNo: string; order?: Order }
  | { name: 'recharge'; recharge: Recharge }
  | { name: 'balance' };

function money(fen: number) {
  return `¥${(Number(fen) / 100).toFixed(2)}`;
}

function assetUrl(url?: string | null) {
  return url?.startsWith('/assets/') ? url : '/assets/stream-pass.png';
}

function statusLabel(status: string) {
  return STATUS_LABEL[status] ?? status;
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

function displayName(user: User) {
  return `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || 'Telegram 用户';
}

function errorMessage(error: unknown) {
  return error instanceof ApiError || error instanceof Error ? error.message : '操作失败，请稍后重试。';
}

function useTelegramInitData() {
  try {
    const fromSdk = useRawInitData();
    if (fromSdk) return fromSdk;
  } catch {
    // Continue with the standard launch-parameter fallback below.
  }
  return new URLSearchParams(window.location.search).get('tgWebAppData') ?? '';
}

function resolvePath(path: string, products: Product[]): Page {
  const orderMatch = path.match(/^\/orders\/(XX\d{14}[A-F0-9]{8})/);
  if (orderMatch) return { name: 'order', orderNo: orderMatch[1] };
  const productSlug = path.match(/^\/products\/([^/]+)/)?.[1];
  if (productSlug) {
    const product = products.find((item) => item.slug === decodeURIComponent(productSlug));
    if (product) return { name: 'product', product };
  }
  if (path.startsWith('/wallet/recharge')) return { name: 'recharge', recharge: { rechargeNo: '', amountFen: 0, status: 'new' } };
  if (path.startsWith('/wallet/balance')) return { name: 'balance' };
  if (path.startsWith('/wallet')) return { name: 'profile' };
  if (path.startsWith('/orders')) return { name: 'orders' };
  return { name: 'shop' };
}

function App() {
  const rawInitData = useTelegramInitData();
  const expanded = useSignal(viewport.isExpanded);
  const api = useMemo(() => createApi(rawInitData), [rawInitData]);
  const initialPath = window.location.pathname;

  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState('');
  const [user, setUser] = useState<User | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [catalog, setCatalog] = useState<Product[]>([]);
  const [page, setPage] = useState<Page>(() => resolvePath(window.location.pathname, []));
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersFilter, setOrdersFilter] = useState('all');
  const [category, setCategory] = useState('all');
  const [variants, setVariants] = useState<Record<string, string>>({});
  const [balance, setBalance] = useState(0);
  const [balanceEntries, setBalanceEntries] = useState<Array<{ kind: string; changeFen: number; createdAt: string }>>([]);
  const [recharge, setRecharge] = useState<Recharge | null>(null);
  const [rechargeAmount, setRechargeAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('');
  const [orderPaymentMethod, setOrderPaymentMethod] = useState('balance');
  const [orderQuantity, setOrderQuantity] = useState(1);
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);

  const activeTab: 'shop' | 'orders' | 'profile' = page.name === 'shop' || page.name === 'orders' || page.name === 'profile'
    ? page.name
    : page.name === 'order'
      ? 'orders'
      : page.name === 'product'
        ? 'shop'
        : 'profile';

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 2400);
  }, []);

  useEffect(() => {
    let alive = true;
    setBooting(true);
    api.authenticate()
      .then(async (session) => {
        const [nextConfig, nextCatalog] = await Promise.all([api.getConfig(), api.getCatalog()]);
        if (!alive) return;
        setUser(session.user);
        setBalance(session.user.balanceFen ?? 0);
        setConfig(nextConfig);
        setCatalog(nextCatalog);
        setVariants(Object.fromEntries(nextCatalog.map((product) => {
          const first = product.variants.find((variant) => variant.stock > 0) ?? product.variants[0];
          return [product.id, first?.id ?? ''];
        })));
        setPage(resolvePath(initialPath, nextCatalog));
      })
      .catch((error) => { if (alive) setBootError(errorMessage(error)); })
      .finally(() => { if (alive) setBooting(false); });
    return () => { alive = false; };
  }, [api]);

  useEffect(() => {
    if (paymentMethod) return;
    const methods = config?.paymentMethods ?? [];
    const preferred = methods.find((method) => method.ready && method.enabled) ?? methods[0];
    if (preferred) setPaymentMethod(preferred.id);
  }, [config, paymentMethod]);

  useEffect(() => {
    const onPopState = () => setPage(resolvePath(window.location.pathname, catalog));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [catalog]);

  const navigate = useCallback((next: Page) => {
    const path = next.name === 'shop' ? '/'
      : next.name === 'orders' ? '/orders/'
      : next.name === 'profile' ? '/wallet'
      : next.name === 'product' ? `/products/${encodeURIComponent(next.product.slug)}`
      : next.name === 'order' ? `/orders/${next.orderNo}`
      : next.name === 'recharge' ? '/wallet/recharge'
      : '/wallet/balance';
    setPage(next);
    window.history.pushState({}, '', path);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, []);

  const goBack = useCallback(() => {
    navigate({ name: activeTab });
  }, [activeTab, navigate]);

  // Telegram 原生 BackButton：首页（shop/orders/profile）隐藏，二级页（product/order/recharge/balance）显示，点击返回。
  useEffect(() => {
    const isTopLevel = page.name === 'shop' || page.name === 'orders' || page.name === 'profile';
    setTelegramBackButton(!isTopLevel);
    if (isTopLevel) return undefined;
    const off = bindTelegramBackButton(goBack);
    return () => { off(); setTelegramBackButton(false); };
  }, [page.name, goBack]);

  const loadOrders = useCallback(async () => {
    setOrdersLoading(true);
    try {
      setOrders(await api.getOrders());
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      setOrdersLoading(false);
    }
  }, [api, notify]);

  const openOrder = useCallback(async (summary: Order) => {
    navigate({ name: 'order', orderNo: summary.orderNo, order: summary });
  }, [navigate]);

  const prevPageName = useRef<string | null>(null);
  useEffect(() => {
    if (page.name !== 'orders') {
      prevPageName.current = page.name;
      return;
    }
    if (prevPageName.current !== 'orders') {
      setOrders(null);
      void loadOrders();
    }
    prevPageName.current = page.name;
  }, [page.name, loadOrders]);

  const changeOrderFilter = useCallback((key: string) => {
    setOrdersFilter(key);
    setOrders(null);
    void loadOrders();
  }, [loadOrders]);

  const loadBalance = useCallback(async () => {
    try {
      const result = await api.getBalance();
      setBalance(result.balanceFen);
      setBalanceEntries(result.entries);
    } catch (error) {
      notify(errorMessage(error));
    }
  }, [api, notify]);

  useEffect(() => {
    if (page.name === 'profile') void loadBalance();
  }, [page.name, loadBalance]);

  useEffect(() => {
    if (page.name !== 'order') return undefined;
    const orderNo = page.orderNo;
    if (page.order) return undefined;
    let alive = true;
    api.getOrder(orderNo)
      .then((order) => { if (alive) setPage((current) => current.name === 'order' ? { ...current, order } : current); })
      .catch((error) => notify(errorMessage(error)));
    return () => { alive = false; };
  }, [api, page.name, page.name === 'order' ? page.orderNo : null, page.name === 'order' ? page.order : null, notify]);

  const orderDetail = page.name === 'order' ? page.order ?? null : null;
  useEffect(() => {
    if (page.name !== 'order' || !page.order) return undefined;
    const orderNo = page.orderNo;
    const timer = window.setInterval(() => {
      api.getOrder(orderNo)
        .then((order) => setPage((current) => current.name === 'order' ? { ...current, order } : current))
        .catch(() => { /* transient polling failure */ });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [api, page.name, page.name === 'order' ? page.orderNo : null, page.name === 'order' ? page.order : null]);

  const activeRecharge = page.name === 'recharge' ? page.recharge : null;
  useEffect(() => {
    if (!activeRecharge || !['pending_payment', 'payment_confirming'].includes(activeRecharge.status)) return undefined;
    const timer = window.setInterval(async () => {
      try {
        const next = await api.getRecharge(activeRecharge.rechargeNo);
        setPage((current) => current.name === 'recharge' ? { ...current, recharge: next } : current);
        if (['paid', 'payment_expired', 'canceled'].includes(next.status)) await loadBalance();
      } catch { /* transient polling failure */ }
    }, 4000);
    return () => window.clearInterval(timer);
  }, [api, loadBalance, activeRecharge?.rechargeNo, activeRecharge?.status]);

  const categories = useMemo(() => {
    const map = new Map<string, Category>();
    catalog.forEach((product) => { if (product.category) map.set(product.category.id, product.category); });
    return [...map.values()];
  }, [catalog]);

  const visibleProducts = useMemo(
    () => catalog.filter((product) => category === 'all' || product.category?.id === category),
    [catalog, category],
  );

  const selectedVariant = useCallback((product: Product) => {
    const selectedId = variants[product.id];
    return product.variants.find((variant) => variant.id === selectedId)
      ?? product.variants.find((variant) => variant.stock > 0)
      ?? product.variants[0];
  }, [variants]);

  const reloadCatalog = async () => {
    try {
      const nextCatalog = await api.getCatalog();
      setCatalog(nextCatalog);
      setCategory((current) => current === 'all' || nextCatalog.some((product) => product.category?.id === current) ? current : 'all');
      setVariants((current) => Object.fromEntries(nextCatalog.map((product) => {
        const selected = current[product.id];
        const fallback = product.variants.find((variant) => variant.stock > 0) ?? product.variants[0];
        return [product.id, product.variants.some((variant) => variant.id === selected) ? selected : fallback?.id ?? ''];
      })));
      notify('商品目录已刷新。');
    } catch (error) { notify(errorMessage(error)); }
  };

  const openProduct = (product: Product) => {
    setOrderQuantity(1);
    navigate({ name: 'product', product });
  };

  const buyNow = async () => {
    if (page.name !== 'product') return;
    const variant = selectedVariant(page.product);
    if (!variant || variant.stock < 1) return notify('该规格库存不足。');
    const method = orderPaymentMethod;
    const total = variant.priceFen * orderQuantity;
    if (method === 'balance') {
      if (balance < total) return notify('余额不足，请先充值。');
    } else {
      const methods = config?.paymentMethods ?? [];
      if (!methods.some((candidate) => candidate.id === method && candidate.enabled && candidate.ready)) return notify('暂无可用的支付方式。');
    }
    setBusy(true);
    try {
      const order = await api.createOrder(variant.id, orderQuantity, `buy_${crypto.randomUUID().replaceAll('-', '')}`, method);
      setOrders(null);
      setBalance((current) => method === 'balance' ? current - total : current);
      setPage({ name: 'order', orderNo: order.orderNo, order });
      window.history.pushState({}, '', `/orders/${order.orderNo}`);
      window.scrollTo({ top: 0, behavior: 'instant' });
      notify(method === 'balance' ? '购买成功，正在发卡。' : '支付订单已创建。');
    } catch (error) { notify(errorMessage(error)); }
    finally { setBusy(false); }
  };

  const submitRecharge = async () => {
    const amount = Number(rechargeAmount);
    if (!Number.isFinite(amount) || amount <= 0) return notify('请输入正确的充值金额。');
    const methods = config?.paymentMethods ?? [];
    const provider = paymentMethod || methods.find((method) => method.ready && method.enabled)?.id || 'dujiaopay';
    if (!methods.some((method) => method.id === provider && method.enabled && method.ready)) return notify('暂无可用的支付方式。');
    setBusy(true);
    try {
      const result = await api.createRecharge(amount, `rcg_${crypto.randomUUID().replaceAll('-', '')}`, provider);
      setRecharge(result.recharge);
      setPage({ name: 'recharge', recharge: result.recharge });
      window.history.pushState({}, '', '/wallet/recharge');
      window.scrollTo({ top: 0, behavior: 'instant' });
      setRechargeAmount('');
    } catch (error) { notify(errorMessage(error)); }
    finally { setBusy(false); }
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      notify('已复制。');
    } catch { notify('复制失败，请手动选择。'); }
  };

  if (booting) return <LoadingScreen expanded={expanded} />;
  if (bootError || !user || !config) return <ErrorScreen message={bootError || '无法加载 Mini App。'} onRetry={() => window.location.reload()} />;

  if (page.name === 'product') {
    return (
      <div className="app-shell page-app-shell">
        <ProductPage
          product={page.product}
          variant={selectedVariant(page.product)}
          quantity={orderQuantity}
          balanceFen={balance}
          methods={config?.paymentMethods ?? []}
          paymentMethod={orderPaymentMethod}
          busy={busy}
          onBack={goBack}
          onVariant={(variant) => { setVariants((current) => ({ ...current, [page.product.id]: variant.id })); setOrderQuantity(1); }}
          onQuantity={setOrderQuantity}
          onPaymentMethod={setOrderPaymentMethod}
          onBuy={buyNow}
        />
        {toast && <div className="toast-message" role="status">{toast}</div>}
      </div>
    );
  }

  if (page.name === 'order') {
    return (
      <div className="app-shell page-app-shell">
        <OrderPage
          order={orderDetail}
          orderNo={page.orderNo}
          onBack={goBack}
          onCopy={copy}
          onRefresh={async () => {
            const next = await api.getOrder(page.orderNo);
            setPage((current) => current.name === 'order' ? { ...current, order: next } : current);
          }}
        />
        {toast && <div className="toast-message" role="status">{toast}</div>}
      </div>
    );
  }

  if (page.name === 'recharge') {
    return (
      <div className="app-shell page-app-shell">
        <RechargePage
          recharge={activeRecharge ?? { rechargeNo: '', amountFen: 0, status: 'new' }}
          amount={rechargeAmount}
          balanceFen={balance}
          methods={config?.paymentMethods ?? []}
          paymentMethod={paymentMethod}
          busy={busy}
          onAmount={setRechargeAmount}
          onProvider={setPaymentMethod}
          onBack={goBack}
          onSubmit={submitRecharge}
          onCopy={copy}
        />
        {toast && <div className="toast-message" role="status">{toast}</div>}
      </div>
    );
  }

  if (page.name === 'balance') {
    return (
      <div className="app-shell page-app-shell">
        <BalancePage entries={balanceEntries} onBack={goBack} />
        {toast && <div className="toast-message" role="status">{toast}</div>}
      </div>
    );
  }

  return (
    <div className="app-shell" data-expanded={expanded ? 'true' : 'false'}>
      <Header tab={activeTab} />
      <main className="content-shell">
        <div key={activeTab} className="tab-transition">
          {page.name === 'shop' && (
            <ShopView
              catalog={catalog}
              categories={categories}
              category={category}
              onCategory={setCategory}
              visibleProducts={visibleProducts}
              selectedVariant={selectedVariant}
              onProduct={openProduct}
              onBuy={openProduct}
              onReload={reloadCatalog}
            />
          )}
          {page.name === 'orders' && (
            <OrdersView
              orders={orders}
              loading={ordersLoading}
              filter={ordersFilter}
              onFilter={changeOrderFilter}
              onOpen={openOrder}
              onShop={() => navigate({ name: 'shop' })}
            />
          )}
          {page.name === 'profile' && (
            <ProfileView
              user={user}
              config={config}
              balance={balance}
              onOrders={() => navigate({ name: 'orders' })}
              onRecharge={() => navigate({ name: 'recharge', recharge: { rechargeNo: '', amountFen: 0, status: 'new' } })}
              onBalanceDetail={() => navigate({ name: 'balance' })}
              onSupport={() => config.supportUrl && window.open(config.supportUrl, '_blank', 'noopener,noreferrer')}
            />
          )}
        </div>
      </main>
      <BottomNav tab={activeTab} onTab={(tab) => navigate({ name: tab })} />
      {toast && <div className="toast-message" role="status">{toast}</div>}
    </div>
  );
}

function LoadingScreen({ expanded }: { expanded: boolean }) {
  return <div className="center-screen"><LoaderCircle className="animate-spin text-accent" size={28} /><span>正在连接 XiuXian…</span><small>{expanded ? '已展开到最大可用高度' : '正在准备 Telegram Mini App'}</small></div>;
}

function ErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="center-screen"><CircleAlert className="text-rose-400" size={42} /><h1>暂时无法进入商店</h1><p>{message}</p><button className="primary-button" onClick={onRetry}>重新连接</button></div>;
}

function Header({ tab }: { tab: 'shop' | 'orders' | 'profile' }) {
  const content = tab === 'shop'
    ? <div className="brand-lockup" key="shop"><span className="brand-mark">XX</span><div><h1>XiuXian</h1><p>数字商品商城</p></div></div>
    : <div className="page-title" key={tab}><h1>{tab === 'orders' ? '我的订单' : '我的'}</h1>{tab === 'orders' && <p>支付与交付记录</p>}</div>;
  return <header className="top-header"><div className="top-header-inner">{content}</div></header>;
}

function ShopView({ catalog, categories, category, onCategory, visibleProducts, selectedVariant, onProduct, onBuy, onReload }: { catalog: Product[]; categories: Category[]; category: string; onCategory: (id: string) => void; visibleProducts: Product[]; selectedVariant: (product: Product) => Variant | undefined; onProduct: (product: Product) => void; onBuy: (product: Product) => void; onReload: () => void }) {
  return <section className="page-section shop-section">
    <div className="shop-intro"><div><span className="eyebrow">DIGITAL SHELF</span><h2>精选数字商品</h2></div><span>即时交付 · 安全库存</span></div>
    <div className="category-scroll" role="tablist" aria-label="商品分类">
      <button className={`category-chip ${category === 'all' ? 'is-active' : ''}`} onClick={() => onCategory('all')}>全部 <small>{catalog.length}</small></button>
      {categories.map((item) => <button key={item.id} className={`category-chip ${category === item.id ? 'is-active' : ''}`} onClick={() => onCategory(item.id)}>{item.name} <small>{catalog.filter((product) => product.category?.id === item.id).length}</small></button>)}
    </div>
    <SectionHeading label="CATALOG" title="商品列表" count={`${visibleProducts.length} 件`} />
    {visibleProducts.length ? <div className="product-grid">{visibleProducts.map((product) => <ProductCard key={product.id} product={product} variant={selectedVariant(product)} onOpen={() => onProduct(product)} onBuy={() => onBuy(product)} />)}</div> : <EmptyPanel icon={<PackageOpen size={56} />} title="暂时没有商品" text="当前分类还没有可展示的数字商品" action="重新加载" onAction={onReload} />}
  </section>;
}

function SectionHeading({ label, title, count }: { label: string; title: string; count: string }) {
  return <div className="section-heading"><div><span className="eyebrow">{label}</span><h2>{title}</h2></div><span>{count}</span></div>;
}

function ProductCard({ product, variant, onOpen, onBuy }: { product: Product; variant?: Variant; onOpen: () => void; onBuy: () => void }) {
  const soldOut = !variant || variant.stock < 1;
  return <article className="product-card">
    <button className="product-open" onClick={onOpen}>
      <img src={assetUrl(product.imageUrl)} alt={product.title} />
      <span className="product-cat">{product.category?.name ?? '数字商品'}</span>
      {soldOut && <em className="product-soldout">已售罄</em>}
      <div>
        <h3>{product.title}</h3>
        <p>{product.description || '即时交付的数字商品'}</p>
        <span className="product-meta">已售 {variant?.sold ?? 0} · {product.variants.length} 种规格</span>
      </div>
    </button>
    <div className="product-footer">
      <div className="product-price"><strong>{money(variant?.priceFen ?? 0)}</strong><span>{variant?.stock ?? 0} 份可售</span></div>
      <button className="buy-button" onClick={onBuy} disabled={soldOut} aria-label={`购买 ${product.title}`}><ShoppingBag size={14} />购买</button>
    </div>
  </article>;
}

function OrdersView({ orders, loading, filter, onFilter, onOpen, onShop }: { orders: Order[] | null; loading: boolean; filter: string; onFilter: (key: string) => void; onOpen: (order: Order) => void; onShop: () => void }) {
  const filtered = orders?.filter((order) => { const group = ORDER_GROUPS.find((item) => item.key === filter); return !group?.statuses || group.statuses.includes(order.status); }) ?? [];
  return <section className="page-section orders-section"><div className="order-filters">{ORDER_GROUPS.map((group) => <button key={group.key} className={filter === group.key ? 'is-active' : ''} onClick={() => onFilter(group.key)}><b>{group.label}</b><small>{orders ? (group.statuses ? orders.filter((order) => group.statuses?.includes(order.status)).length : orders.length) : '·'}</small></button>)}</div>{loading ? <div className="skeleton-stack">{[1, 2, 3].map((key) => <div className="skeleton-row" key={key}><span /><div><i /><i /><i /></div></div>)}</div> : filtered.length ? <div className="order-list">{filtered.map((order) => <button className="order-row" key={order.orderNo} onClick={() => onOpen(order)}><span className="order-icon"><ClipboardList size={20} /></span><span className="order-copy"><b>{order.productTitle}</b><small>{order.variantName} · {formatDate(order.createdAt)}</small><em>{order.orderNo}</em></span><span className="order-side"><b>{money(order.totalPriceFen)}</b><em className={STATUS_TONE[order.status] ?? 'status-muted'}>{statusLabel(order.status)}</em><ChevronRight size={16} /></span></button>)}</div> : <EmptyPanel icon={<PackageOpen size={58} />} title="还没有订单" text="选购数字商品后，订单会显示在这里" action="去逛逛" onAction={onShop} />}</section>;
}

function ProfileView({ user, config, balance, onOrders, onRecharge, onBalanceDetail, onSupport }: { user: User; config: PublicConfig; balance: number; onOrders: () => void; onRecharge: () => void; onBalanceDetail: () => void; onSupport: () => void }) {
  return <section className="page-section profile-section"><div className="profile-card"><div className="profile-top"><div className={`avatar ${user.photoUrl ? 'has-image' : ''}`}>{user.photoUrl ? <img src={user.photoUrl} alt="Telegram 头像" /> : <UserRound size={30} />}</div><div className="profile-copy"><h2>{displayName(user)}</h2>{user.username && <p>@{user.username}</p>}<small>Telegram ID：{user.telegramId}</small></div><span className="connected"><i />已连接</span></div><div className="balance-row"><span>账户余额</span><strong>{money(balance)}</strong><button onClick={onRecharge}><WalletCards size={16} />充值</button></div></div><div className="menu-card"><button onClick={onOrders}><span><ClipboardList size={19} />我的订单</span><ChevronRight size={16} /></button><button onClick={onBalanceDetail}><span><WalletCards size={19} />余额明细</span><ChevronRight size={16} /></button>{config.supportUrl && <button onClick={onSupport}><span><Headphones size={19} />联系售后</span><ChevronRight size={16} /></button>}<div><span><ShieldCheck size={19} />当前版本</span><small>v{config.version}</small></div></div></section>;
}

function BottomNav({ tab, onTab }: { tab: 'shop' | 'orders' | 'profile'; onTab: (tab: 'shop' | 'orders' | 'profile') => void }) {
  const items = useMemo(() => [
    { key: 'shop' as const, label: '商城', icon: Home },
    { key: 'orders' as const, label: '订单', icon: ClipboardList },
    { key: 'profile' as const, label: '我的', icon: UserRound },
  ], []);
  const navRef = useRef<HTMLElement | null>(null);
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [indicator, setIndicator] = useState({ left: 0, width: 0, ready: false });

  useEffect(() => {
    const nav = navRef.current;
    const active = buttonRefs.current[tab];
    if (!nav || !active) return;
    let frame = 0;
    const update = () => {
      const navRect = nav.getBoundingClientRect();
      const rect = active.getBoundingClientRect();
      setIndicator({ left: rect.left - navRect.left, width: rect.width, ready: true });
    };
    frame = requestAnimationFrame(update);
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, [tab]);

  return (
    <nav ref={navRef} className="bottom-nav" aria-label="主导航">
      <span
        className="bottom-nav-indicator"
        style={{
          transform: `translateX(${indicator.left}px)`,
          width: indicator.width,
          opacity: indicator.ready ? 1 : 0,
        }}
      />
      {items.map(({ key, label, icon: Icon }) => {
        const active = tab === key;
        return (
          <button
            key={key}
            ref={(el) => { buttonRefs.current[key] = el; }}
            className={active ? 'is-active' : ''}
            onClick={() => onTab(key)}
            aria-current={active ? 'page' : undefined}
          >
            <span className="nav-icon-wrap">
              <Icon size={22} strokeWidth={active ? 2.5 : 1.8} className="nav-icon" />
            </span>
            <span className="nav-label">{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

function EmptyPanel({ icon, title, text, action, onAction }: { icon: React.ReactNode; title: string; text: string; action: string; onAction: () => void }) {
  return <div className="empty-panel"><span className="empty-icon">{icon}</span><h2>{title}</h2><p>{text}</p><button className="primary-button" onClick={onAction}>{action}</button></div>;
}

function PageView({ title, subtitle, onBack, children, footer }: { title: string; subtitle?: string; onBack: () => void; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="page-view">
      <header className="page-header">
        <button className="back-button" onClick={onBack} aria-label="返回"><ChevronLeft size={22} /></button>
        <div className="page-header-title"><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
        <span className="page-header-spacer" />
      </header>
      <div className="page-view-body">{children}</div>
      {footer && <div className="page-view-footer">{footer}</div>}
    </div>
  );
}

function ProductPage({ product, variant, quantity, balanceFen, methods, paymentMethod, busy, onBack, onVariant, onQuantity, onPaymentMethod, onBuy }: { product: Product; variant?: Variant; quantity: number; balanceFen: number; methods: PaymentMethod[]; paymentMethod: string; busy: boolean; onBack: () => void; onVariant: (variant: Variant) => void; onQuantity: (quantity: number) => void; onPaymentMethod: (id: string) => void; onBuy: () => void }) {
  const availableVariant = variant ?? product.variants.find((item) => item.stock > 0);
  const max = availableVariant ? Math.min(availableVariant.maxPerOrder, availableVariant.stock) : 0;
  const total = availableVariant ? availableVariant.priceFen * quantity : 0;
  const balanceReady = balanceFen >= total;
  const externalMethods = methods.filter((method) => method.enabled);
  const selectedReady = paymentMethod === 'balance' ? balanceReady : externalMethods.some((method) => method.id === paymentMethod && method.ready);
  const canBuy = !busy && !!availableVariant && availableVariant.stock >= 1 && quantity >= 1 && selectedReady;
  return (
    <PageView title={product.title} subtitle={product.category?.name ?? '数字商品'} onBack={onBack}
      footer={<div className="buy-bar"><div className="buy-bar-total"><span>合计</span><strong>{money(total)}</strong></div><button className="primary-button buy-bar-button" disabled={!canBuy} onClick={onBuy}>{busy ? <LoaderCircle className="animate-spin" size={17} /> : <ShoppingBag size={17} />}{busy ? '正在创建…' : '购买'}</button></div>}>
      <div className="page-hero"><img src={assetUrl(product.imageUrl)} alt={product.title} /><span className="page-hero-tag">{product.category?.name ?? '数字商品'}</span></div>
      <div className="page-section-block">
        <span className="eyebrow">即时交付 · 安全库存</span>
        <h2>{product.title}</h2>
        <p className="page-desc">{product.description || '付款确认后，系统自动交付数字商品。'}</p>
      </div>
      <div className="page-section-block">
        <h3 className="block-title">选择规格</h3>
        <div className="variant-list">{product.variants.map((item) => <button key={item.id} className={item.id === availableVariant?.id ? 'is-active' : ''} disabled={item.stock < 1} onClick={() => onVariant(item)}><span><b>{item.name}</b><small>{item.stock > 0 ? `${item.stock} 份可售` : '暂时售罄'}</small></span><strong>{money(item.priceFen)}</strong></button>)}</div>
      </div>
      <div className="page-section-block">
        <h3 className="block-title">购买数量</h3>
        <div className="quantity"><button onClick={() => onQuantity(Math.max(1, quantity - 1))}><Minus size={15} /></button><b>{quantity}</b><button onClick={() => onQuantity(Math.min(max || 1, quantity + 1))}><Plus size={15} /></button></div>
        <span className="sheet-note">该规格单次最多购买 {max || 0} 件</span>
      </div>
      <div className="page-section-block">
        <h3 className="block-title">支付方式</h3>
        <div className="pay-methods">
          <button type="button" className={`pay-method${paymentMethod === 'balance' ? ' is-active' : ''}`} disabled={!balanceReady} onClick={() => onPaymentMethod('balance')}>
            <span className="pay-method-radio" aria-hidden="true" />
            <span className="pay-method-copy"><b>余额支付</b><small>当前余额 {money(balanceFen)}</small></span>
            <em className={`pay-method-badge${balanceReady ? '' : ' is-unready'}`}>{balanceReady ? '可用' : '余额不足'}</em>
          </button>
          {externalMethods.map((method) => {
            const active = method.id === paymentMethod;
            return <button key={method.id} type="button" className={`pay-method${active ? ' is-active' : ''}`} disabled={!method.ready} onClick={() => onPaymentMethod(method.id)}>
              <span className="pay-method-radio" aria-hidden="true" />
              <span className="pay-method-copy"><b>{method.name}</b><small>{method.description ?? method.label ?? method.id}</small></span>
              <em className={`pay-method-badge${method.ready ? '' : ' is-unready'}`}>{method.ready ? '可用' : '未配置'}</em>
            </button>;
          })}
        </div>
      </div>
    </PageView>
  );
}

function BalancePage({ entries, onBack }: { entries: Array<{ kind: string; changeFen: number; createdAt: string }>; onBack: () => void }) {
  return (
    <PageView title="余额明细" subtitle="近期账户余额变动记录" onBack={onBack}>
      {entries.length ? <div className="balance-history">{entries.map((entry, index) => <div className="balance-entry" key={index}><div><b>{entry.kind}</b><small>{formatDate(entry.createdAt)}</small></div><strong className={entry.changeFen >= 0 ? 'text-green' : 'text-red'}>{entry.changeFen >= 0 ? '+' : ''}{money(entry.changeFen)}</strong></div>)}</div> : <div className="empty-state"><PackageOpen size={48} className="empty-icon" /><p>暂无余额变动记录</p></div>}
    </PageView>
  );
}

function RechargePage({ recharge, amount, balanceFen, methods, paymentMethod, busy, onAmount, onProvider, onBack, onSubmit, onCopy }: { recharge: Recharge; amount: string; balanceFen: number; methods: PaymentMethod[]; paymentMethod: string; busy: boolean; onAmount: (value: string) => void; onProvider: (id: string) => void; onBack: () => void; onSubmit: () => void; onCopy: (value: string) => void }) {
  const instructions = recharge.payment?.paymentInstructions;
  const presets = [10, 50, 100, 200, 500];
  const available = methods.filter((method) => method.enabled);
  const selectedReady = available.some((method) => method.id === paymentMethod && method.ready);
  const amountValid = Number(amount) > 0;
  return (
    <PageView title="余额充值" subtitle="到账后余额自动增加" onBack={onBack}
      footer={!recharge.rechargeNo ? <button className="primary-button wide" disabled={busy || !amountValid || !selectedReady} onClick={onSubmit}>{busy ? '正在创建…' : '立即充值'}</button> : undefined}>
      {recharge.rechargeNo ? <>
        <PaymentBlock payment={recharge.payment} onCopy={onCopy} />
        <span className="sheet-note">充值单号：{recharge.rechargeNo}</span>
      </> : <>
        <div className="balance-card">
          <span className="balance-card-label">当前余额</span>
          <strong className="balance-card-amount">{money(balanceFen)}</strong>
        </div>
        <div className="page-section-block">
          <h3 className="block-title">充值金额</h3>
          <div className="amount-presets">
            {presets.map((preset) => (
              <button key={preset} type="button" className={`amount-preset${amount === String(preset) ? ' is-active' : ''}`} onClick={() => onAmount(String(preset))}>¥{preset}</button>
            ))}
          </div>
          <label className="field-label">自定义金额（元）</label>
          <input className="amount-input" inputMode="decimal" type="number" min="0.01" step="0.01" value={amount} onChange={(event) => onAmount(event.target.value)} placeholder="例如 10" />
        </div>
        <div className="page-section-block">
          <h3 className="block-title">支付方式</h3>
          {available.length ? <div className="pay-methods">{available.map((method) => {
            const active = method.id === paymentMethod;
            return <button key={method.id} type="button" className={`pay-method${active ? ' is-active' : ''}`} disabled={!method.ready} onClick={() => onProvider(method.id)}>
              <span className="pay-method-radio" aria-hidden="true" />
              <span className="pay-method-copy"><b>{method.name}</b><small>{method.description ?? method.label ?? method.id}</small></span>
              <em className={`pay-method-badge${method.ready ? '' : ' is-unready'}`}>{method.ready ? '可用' : '未配置'}</em>
            </button>;
          })}</div> : <p className="sheet-note">暂无可用的支付方式，请联系管理员。</p>}
        </div>
      </>}
      {instructions && <span className="sheet-note">使用 {instructions.label ?? '扫码支付'} 完成付款，页面会自动检测到账。</span>}
    </PageView>
  );
}

function OrderPage({ order, orderNo, onBack, onCopy, onRefresh }: { order: Order | null; orderNo: string; onBack: () => void; onCopy: (value: string) => void; onRefresh: () => void }) {
  return (
    <PageView title={order?.productTitle ?? '订单详情'} subtitle={order ? `${order.orderNo} · ${order.variantName}` : orderNo} onBack={onBack}
      footer={<button className="outline-button wide" onClick={onRefresh}><RefreshCw size={15} />刷新订单状态</button>}>
      {!order ? <div className="loading-panel"><LoaderCircle className="animate-spin text-accent" size={26} /><p>正在加载订单…</p></div>
        : <>
          <span className={`order-state ${STATUS_TONE[order.status] ?? 'status-muted'}`}>{statusLabel(order.status)}</span>
          {order.payment?.paymentInstructions && ['pending_payment', 'payment_confirming'].includes(order.status) && <PaymentBlock payment={order.payment} onCopy={onCopy} />}
          {order.cards?.length ? <div className="card-codes">{order.cards.map((card) => <div key={card.code}><code>{card.code}</code><button onClick={() => onCopy(`${card.code}${card.password ? `\n密码：${card.password}` : ''}`)}><Copy size={15} /></button></div>)}</div> : <p className="sheet-note">支付确认后，卡密会显示在这里。</p>}
          <div className="total-row"><span>订单金额</span><strong>{money(order.totalPriceFen)}</strong></div>
        </>}
    </PageView>
  );
}

function PaymentBlock({ payment, onCopy }: { payment?: Order['payment']; onCopy: (value: string) => void }) {
  const instructions = payment?.paymentInstructions;
  if (!instructions?.qrContent) return null;
  return <div className="payment-block"><PaymentQr value={instructions.qrContent} /><strong>{payment?.payableAmount ?? ''} {instructions.amountUnit ?? instructions.label ?? ''}</strong>{instructions.address && <button className="address-copy" onClick={() => onCopy(instructions.address ?? '')}><span>{instructions.address}</span><Copy size={14} /></button>}</div>;
}

function PaymentQr({ value }: { value: string }) {
  const [svg, setSvg] = useState('');
  useEffect(() => { let alive = true; QRCode.toString(value, { type: 'svg', margin: 1, width: 220 }).then((result) => { if (alive) setSvg(result); }).catch(() => setSvg('')); return () => { alive = false; }; }, [value]);
  return <div className="qr-frame" aria-label="付款二维码" dangerouslySetInnerHTML={{ __html: svg || '<span>二维码生成中…</span>' }} />;
}

export default App;
