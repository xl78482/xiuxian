import { useCallback, useEffect, useMemo, useState } from 'react';
import {
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
  X,
} from 'lucide-react';
import QRCode from 'qrcode';
import { useRawInitData, useSignal } from '@telegram-mini-apps/sdk-react';
import { viewport } from '@telegram-mini-apps/sdk-react';
import { createApi, ApiError } from './api';
import type { Category, Order, Product, PublicConfig, Recharge, User, Variant } from './types';

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

function App() {
  const rawInitData = useTelegramInitData();
  const expanded = useSignal(viewport.isExpanded);
  const api = useMemo(() => createApi(rawInitData), [rawInitData]);
  const initialPath = window.location.pathname;
  const initialTab = initialPath.startsWith('/wallet')
    ? 'profile'
    : initialPath.startsWith('/orders/')
      ? 'orders'
      : 'shop';
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState('');
  const [user, setUser] = useState<User | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [catalog, setCatalog] = useState<Product[]>([]);
  const [activeTab, setActiveTab] = useState<'shop' | 'orders' | 'profile'>(initialTab);
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersFilter, setOrdersFilter] = useState('all');
  const [category, setCategory] = useState('all');
  const [variants, setVariants] = useState<Record<string, string>>({});
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [checkout, setCheckout] = useState<{ product: Product; variant: Variant; quantity: number } | null>(null);
  const [orderDetail, setOrderDetail] = useState<Order | null>(null);
  const [balance, setBalance] = useState(0);
  const [balanceEntries, setBalanceEntries] = useState<Array<{ kind: string; changeFen: number; createdAt: string }>>([]);
  const [recharge, setRecharge] = useState<Recharge | null>(initialPath.startsWith('/wallet') ? { rechargeNo: '', amountFen: 0, status: 'new' } : null);
  const [rechargeAmount, setRechargeAmount] = useState('');
  const [balanceSheet, setBalanceSheet] = useState(false);
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);

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
        const productSlug = initialPath.match(/^\/products\/([^/]+)$/)?.[1];
        if (productSlug) setSelectedProduct(nextCatalog.find((product) => product.slug === decodeURIComponent(productSlug)) ?? null);
        const orderNo = initialPath.match(/^\/orders\/(XX\d{14}[A-F0-9]{8})$/)?.[1];
        if (orderNo) setOrderDetail(await api.getOrder(orderNo));
      })
      .catch((error) => { if (alive) setBootError(errorMessage(error)); })
      .finally(() => { if (alive) setBooting(false); });
    return () => { alive = false; };
  }, [api]);

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
    try {
      setOrderDetail(await api.getOrder(summary.orderNo));
    } catch (error) {
      notify(errorMessage(error));
    }
  }, [api, notify]);

  useEffect(() => {
    if (activeTab === 'orders' && orders === null && !ordersLoading) void loadOrders();
  }, [activeTab, loadOrders, orders, ordersLoading]);

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
    if (activeTab === 'profile' && user) void loadBalance();
  }, [activeTab, loadBalance, user]);

  useEffect(() => {
    if (!orderDetail || !['pending_payment', 'payment_confirming', 'paid', 'fulfilling'].includes(orderDetail.status)) return undefined;
    const timer = window.setInterval(async () => {
      try { setOrderDetail(await api.getOrder(orderDetail.orderNo)); } catch { /* transient polling failure */ }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [api, orderDetail?.orderNo, orderDetail?.status]);

  useEffect(() => {
    if (!recharge || !['pending_payment', 'payment_confirming'].includes(recharge.status)) return undefined;
    const timer = window.setInterval(async () => {
      try {
        const next = await api.getRecharge(recharge.rechargeNo);
        setRecharge(next);
        if (['paid', 'payment_expired', 'canceled'].includes(next.status)) await loadBalance();
      } catch { /* transient polling failure */ }
    }, 4000);
    return () => window.clearInterval(timer);
  }, [api, loadBalance, recharge?.rechargeNo, recharge?.status]);

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

  const openCheckout = (product: Product) => {
    const variant = selectedVariant(product);
    if (!variant || variant.stock < 1) return notify('该规格库存不足。');
    setSelectedProduct(null);
    setCheckout({ product, variant, quantity: 1 });
  };

  const submitCheckout = async () => {
    if (!checkout) return;
    setBusy(true);
    try {
      const order = await api.createOrder(checkout.variant.id, checkout.quantity, `buy_${crypto.randomUUID().replaceAll('-', '')}`);
      setCheckout(null);
      setOrders(null);
      setActiveTab('orders');
      setOrderDetail(order);
      notify('支付订单已创建。');
    } catch (error) { notify(errorMessage(error)); }
    finally { setBusy(false); }
  };

  const submitRecharge = async () => {
    const amount = Number(rechargeAmount);
    if (!Number.isFinite(amount) || amount <= 0) return notify('请输入正确的充值金额。');
    setBusy(true);
    try {
      const result = await api.createRecharge(amount, `rcg_${crypto.randomUUID().replaceAll('-', '')}`);
      setRecharge(result.recharge);
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

  return (
    <div className="app-shell" data-expanded={expanded ? 'true' : 'false'}>
      <Header tab={activeTab} onRefresh={() => { setOrders(null); void loadOrders(); }} />
      <main className="content-shell">
        {activeTab === 'shop' && (
          <ShopView
            catalog={catalog}
            categories={categories}
            category={category}
            onCategory={setCategory}
            visibleProducts={visibleProducts}
            selectedVariant={selectedVariant}
            onProduct={setSelectedProduct}
            onCheckout={openCheckout}
            onReload={reloadCatalog}
          />
        )}
        {activeTab === 'orders' && (
          <OrdersView
            orders={orders}
            loading={ordersLoading}
            filter={ordersFilter}
            onFilter={setOrdersFilter}
            onOpen={openOrder}
            onShop={() => setActiveTab('shop')}
          />
        )}
        {activeTab === 'profile' && (
          <ProfileView
            user={user}
            config={config}
            balance={balance}
            onOrders={() => setActiveTab('orders')}
            onRecharge={() => setRecharge({ rechargeNo: '', amountFen: 0, status: 'new' })}
            onBalanceDetail={() => setBalanceSheet(true)}
            onSupport={() => config.supportUrl && window.open(config.supportUrl, '_blank', 'noopener,noreferrer')}
          />
        )}
      </main>
      <BottomNav tab={activeTab} orderCount={orders?.length ?? 0} onTab={setActiveTab} />
      {selectedProduct && <ProductSheet product={selectedProduct} variant={selectedVariant(selectedProduct)} onClose={() => setSelectedProduct(null)} onVariant={(variant) => setVariants((current) => ({ ...current, [selectedProduct.id]: variant.id }))} onCheckout={() => openCheckout(selectedProduct)} />}
      {checkout && <CheckoutSheet checkout={checkout} busy={busy} onClose={() => setCheckout(null)} onQuantity={(quantity) => setCheckout((current) => current ? { ...current, quantity } : current)} onSubmit={submitCheckout} />}
      {orderDetail && <OrderSheet order={orderDetail} onClose={() => setOrderDetail(null)} onCopy={copy} onRefresh={async () => setOrderDetail(await api.getOrder(orderDetail.orderNo))} />}
      {recharge && <RechargeSheet recharge={recharge} amount={rechargeAmount} busy={busy} onAmount={setRechargeAmount} onClose={() => setRecharge(null)} onSubmit={submitRecharge} onCopy={copy} />}
      {balanceSheet && <BalanceSheet entries={balanceEntries} onClose={() => setBalanceSheet(false)} />}
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

function Header({ tab, onRefresh }: { tab: 'shop' | 'orders' | 'profile'; onRefresh: () => void }) {
  const content = tab === 'shop'
    ? <div className="brand-lockup"><span className="brand-mark">XX</span><div><h1>XiuXian</h1><p>数字商品商城</p></div></div>
    : <div className="page-title"><h1>{tab === 'orders' ? '我的订单' : '我的'}</h1>{tab === 'orders' && <p>支付与交付记录</p>}</div>;
  return <header className="top-header"><div className="top-header-inner">{content}{tab === 'orders' && <button className="icon-button compact-icon" onClick={onRefresh} aria-label="刷新订单"><RefreshCw size={16} /></button>}</div></header>;
}

function ShopView({ catalog, categories, category, onCategory, visibleProducts, selectedVariant, onProduct, onCheckout, onReload }: { catalog: Product[]; categories: Category[]; category: string; onCategory: (id: string) => void; visibleProducts: Product[]; selectedVariant: (product: Product) => Variant | undefined; onProduct: (product: Product) => void; onCheckout: (product: Product) => void; onReload: () => void }) {
  return <section className="page-section shop-section">
    <div className="shop-intro"><div><span className="eyebrow">DIGITAL SHELF</span><h2>精选数字商品</h2></div><span>即时交付 · 安全库存</span></div>
    <div className="category-scroll" role="tablist" aria-label="商品分类">
      <button className={`category-chip ${category === 'all' ? 'is-active' : ''}`} onClick={() => onCategory('all')}>全部 <small>{catalog.length}</small></button>
      {categories.map((item) => <button key={item.id} className={`category-chip ${category === item.id ? 'is-active' : ''}`} onClick={() => onCategory(item.id)}>{item.name} <small>{catalog.filter((product) => product.category?.id === item.id).length}</small></button>)}
    </div>
    <SectionHeading label="CATALOG" title="商品列表" count={`${visibleProducts.length} 件`} />
    {visibleProducts.length ? <div className="product-grid">{visibleProducts.map((product) => <ProductCard key={product.id} product={product} variant={selectedVariant(product)} onOpen={() => onProduct(product)} onCheckout={() => onCheckout(product)} />)}</div> : <EmptyPanel icon={<PackageOpen size={56} />} title="暂时没有商品" text="当前分类还没有可展示的数字商品" action="重新加载" onAction={onReload} />}
  </section>;
}

function SectionHeading({ label, title, count }: { label: string; title: string; count: string }) {
  return <div className="section-heading"><div><span className="eyebrow">{label}</span><h2>{title}</h2></div><span>{count}</span></div>;
}

function ProductCard({ product, variant, onOpen, onCheckout }: { product: Product; variant?: Variant; onOpen: () => void; onCheckout: () => void }) {
  return <article className="product-card"><button className="product-open" onClick={onOpen}><img src={assetUrl(product.imageUrl)} alt={product.title} /><div><span className="product-meta">{product.category?.name ?? '数字商品'} · 已售 {variant?.sold ?? 0}</span><h3>{product.title}</h3><p>{product.description || '即时交付的数字商品'}</p></div></button><div className="product-footer"><strong>{money(variant?.priceFen ?? 0)}</strong><span>{variant?.stock ?? 0} 份可售</span><button className="buy-icon" onClick={onCheckout} disabled={!variant || variant.stock < 1} aria-label={`购买 ${product.title}`}><ShoppingBag size={16} /></button></div></article>;
}

function OrdersView({ orders, loading, filter, onFilter, onOpen, onShop }: { orders: Order[] | null; loading: boolean; filter: string; onFilter: (key: string) => void; onOpen: (order: Order) => void; onShop: () => void }) {
  const filtered = orders?.filter((order) => { const group = ORDER_GROUPS.find((item) => item.key === filter); return !group?.statuses || group.statuses.includes(order.status); }) ?? [];
  return <section className="page-section orders-section"><div className="order-filters">{ORDER_GROUPS.map((group) => <button key={group.key} className={filter === group.key ? 'is-active' : ''} onClick={() => onFilter(group.key)}><b>{group.label}</b><small>{orders ? (group.statuses ? orders.filter((order) => group.statuses?.includes(order.status)).length : orders.length) : '·'}</small></button>)}</div>{loading ? <div className="skeleton-stack">{[1, 2, 3].map((key) => <div className="skeleton-row" key={key}><span /><div><i /><i /><i /></div></div>)}</div> : filtered.length ? <div className="order-list">{filtered.map((order) => <button className="order-row" key={order.orderNo} onClick={() => onOpen(order)}><span className="order-icon"><ClipboardList size={20} /></span><span className="order-copy"><b>{order.productTitle}</b><small>{order.variantName} · {formatDate(order.createdAt)}</small><em>{order.orderNo}</em></span><span className="order-side"><b>{money(order.totalPriceFen)}</b><em className={STATUS_TONE[order.status] ?? 'status-muted'}>{statusLabel(order.status)}</em><ChevronRight size={16} /></span></button>)}</div> : <EmptyPanel icon={<PackageOpen size={58} />} title="还没有订单" text="选购数字商品后，订单会显示在这里" action="去逛逛" onAction={onShop} />}</section>;
}

function ProfileView({ user, config, balance, onOrders, onRecharge, onBalanceDetail, onSupport }: { user: User; config: PublicConfig; balance: number; onOrders: () => void; onRecharge: () => void; onBalanceDetail: () => void; onSupport: () => void }) {
  return <section className="page-section profile-section"><div className="profile-card"><div className="profile-top"><div className={`avatar ${user.photoUrl ? 'has-image' : ''}`}>{user.photoUrl ? <img src={user.photoUrl} alt="Telegram 头像" /> : <UserRound size={30} />}</div><div className="profile-copy"><h2>{displayName(user)}</h2>{user.username && <p>@{user.username}</p>}<small>Telegram ID：{user.telegramId}</small></div><span className="connected"><i />已连接</span></div><div className="balance-row"><span>账户余额</span><strong>{money(balance)}</strong><button onClick={onRecharge}><WalletCards size={16} />充值</button></div></div><div className="menu-card"><button onClick={onOrders}><span><ClipboardList size={19} />我的订单</span><ChevronRight size={16} /></button><button onClick={onBalanceDetail}><span><WalletCards size={19} />余额明细</span><ChevronRight size={16} /></button>{config.supportUrl && <button onClick={onSupport}><span><Headphones size={19} />联系售后</span><ChevronRight size={16} /></button>}<div><span><ShieldCheck size={19} />当前版本</span><small>v{config.version}</small></div></div></section>;
}

function BottomNav({ tab, orderCount, onTab }: { tab: 'shop' | 'orders' | 'profile'; orderCount: number; onTab: (tab: 'shop' | 'orders' | 'profile') => void }) {
  const items = [{ key: 'shop' as const, label: '商城', icon: Home }, { key: 'orders' as const, label: '订单', icon: ClipboardList }, { key: 'profile' as const, label: '我的', icon: UserRound }];
  return <nav className="bottom-nav" aria-label="主导航">{items.map(({ key, label, icon: Icon }) => <button className={tab === key ? 'is-active' : ''} key={key} onClick={() => onTab(key)}><Icon size={22} /><span>{label}</span>{key === 'orders' && orderCount > 0 && <b>{orderCount}</b>}</button>)}</nav>;
}

function EmptyPanel({ icon, title, text, action, onAction }: { icon: React.ReactNode; title: string; text: string; action: string; onAction: () => void }) {
  return <div className="empty-panel"><span className="empty-icon">{icon}</span><h2>{title}</h2><p>{text}</p><button className="primary-button" onClick={onAction}>{action}</button></div>;
}

function ProductSheet({ product, variant, onClose, onVariant, onCheckout }: { product: Product; variant?: Variant; onClose: () => void; onVariant: (variant: Variant) => void; onCheckout: () => void }) {
  return <Sheet onClose={onClose}><div className="sheet-image"><img src={assetUrl(product.imageUrl)} alt={product.title} /><span>{product.category?.name ?? '数字商品'}</span></div><div className="sheet-copy"><span className="eyebrow">即时交付 · 安全库存</span><h2>{product.title}</h2><p>{product.description || '付款确认后，系统自动交付数字商品。'}</p></div><div className="variant-list">{product.variants.map((item) => <button key={item.id} className={item.id === variant?.id ? 'is-active' : ''} disabled={item.stock < 1} onClick={() => onVariant(item)}><span><b>{item.name}</b><small>{item.stock > 0 ? `${item.stock} 份可售` : '暂时售罄'}</small></span><strong>{money(item.priceFen)}</strong></button>)}</div><button className="primary-button wide" onClick={onCheckout} disabled={!variant || variant.stock < 1}><ShoppingBag size={17} />立即购买</button></Sheet>;
}

function CheckoutSheet({ checkout, busy, onClose, onQuantity, onSubmit }: { checkout: { product: Product; variant: Variant; quantity: number }; busy: boolean; onClose: () => void; onQuantity: (quantity: number) => void; onSubmit: () => void }) {
  const max = Math.min(checkout.variant.maxPerOrder, checkout.variant.stock);
  return <Sheet onClose={onClose}><div className="sheet-heading"><div><h2>确认订单</h2><p>付款成功后自动发卡</p></div><button className="sheet-close" onClick={onClose} aria-label="关闭"><X size={19} /></button></div><div className="checkout-line"><img src={assetUrl(checkout.product.imageUrl)} alt="" /><div><b>{checkout.product.title}</b><span>{checkout.variant.name} · {money(checkout.variant.priceFen)}</span></div></div><label className="field-label">购买数量</label><div className="quantity"><button onClick={() => onQuantity(Math.max(1, checkout.quantity - 1))}><Minus size={15} /></button><b>{checkout.quantity}</b><button onClick={() => onQuantity(Math.min(max, checkout.quantity + 1))}><Plus size={15} /></button></div><div className="total-row"><span>订单合计</span><strong>{money(checkout.variant.priceFen * checkout.quantity)}</strong></div><button className="primary-button wide" disabled={busy} onClick={onSubmit}>{busy ? <LoaderCircle className="animate-spin" size={17} /> : <ShoppingBag size={17} />}{busy ? '正在创建…' : '创建支付订单'}</button></Sheet>;
}

function BalanceSheet({ entries, onClose }: { entries: Array<{ kind: string; changeFen: number; createdAt: string }>; onClose: () => void }) {
  return <Sheet onClose={onClose}><div className="sheet-heading"><div><h2>余额明细</h2><p>近期账户余额变动记录</p></div><button className="sheet-close" onClick={onClose} aria-label="关闭"><X size={19} /></button></div>{entries.length ? <div className="balance-history">{entries.map((entry, index) => <div className="balance-entry" key={index}><div><b>{entry.kind}</b><small>{formatDate(entry.createdAt)}</small></div><strong className={entry.changeFen >= 0 ? 'text-green' : 'text-red'}>{entry.changeFen >= 0 ? '+' : ''}{money(entry.changeFen)}</strong></div>)}</div> : <div className="empty-state"><PackageOpen size={48} className="empty-icon" /><p>暂无余额变动记录</p></div>}</Sheet>;
}

function RechargeSheet({ recharge, amount, busy, onAmount, onClose, onSubmit, onCopy }: { recharge: Recharge; amount: string; busy: boolean; onAmount: (value: string) => void; onClose: () => void; onSubmit: () => void; onCopy: (value: string) => void }) {
  const instructions = recharge.payment?.paymentInstructions;
  return <Sheet onClose={onClose}><div className="sheet-heading"><div><h2>余额充值</h2><p>到账后余额自动增加</p></div><button className="sheet-close" onClick={onClose} aria-label="关闭"><X size={19} /></button></div>{recharge.rechargeNo ? <><PaymentBlock payment={recharge.payment} onCopy={onCopy} /><span className="sheet-note">充值单号：{recharge.rechargeNo}</span></> : <><label className="field-label">充值金额（元）</label><input className="amount-input" inputMode="decimal" type="number" min="0.01" step="0.01" value={amount} onChange={(event) => onAmount(event.target.value)} placeholder="例如 10" /><button className="primary-button wide" disabled={busy} onClick={onSubmit}>{busy ? '正在创建…' : '生成收款二维码'}</button></>}{instructions && <span className="sheet-note">使用 {instructions.label ?? '扫码支付'} 完成付款，页面会自动检测到账。</span>}</Sheet>;
}

function OrderSheet({ order, onClose, onCopy, onRefresh }: { order: Order; onClose: () => void; onCopy: (value: string) => void; onRefresh: () => void }) {
  return <Sheet onClose={onClose}><div className="sheet-heading"><div><h2>{order.productTitle}</h2><p>{order.orderNo} · {order.variantName}</p></div><button className="sheet-close" onClick={onClose} aria-label="关闭"><X size={19} /></button></div><span className={`order-state ${STATUS_TONE[order.status] ?? 'status-muted'}`}>{statusLabel(order.status)}</span>{order.payment?.paymentInstructions && ['pending_payment', 'payment_confirming'].includes(order.status) && <PaymentBlock payment={order.payment} onCopy={onCopy} />}{order.cards?.length ? <div className="card-codes">{order.cards.map((card) => <div key={card.code}><code>{card.code}</code><button onClick={() => onCopy(`${card.code}${card.password ? `\n密码：${card.password}` : ''}`)}><Copy size={15} /></button></div>)}</div> : <p className="sheet-note">支付确认后，卡密会显示在这里。</p>}<div className="total-row"><span>订单金额</span><strong>{money(order.totalPriceFen)}</strong></div><button className="outline-button wide" onClick={onRefresh}><RefreshCw size={15} />刷新订单状态</button></Sheet>;
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

function Sheet({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return <div className="sheet-backdrop" role="presentation" onClick={onClose}><aside className="sheet" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>{children}</aside></div>;
}

export default App;
