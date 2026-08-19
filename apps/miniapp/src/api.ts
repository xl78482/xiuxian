import type {
  ApiErrorShape,
  Order,
  Product,
  PublicConfig,
  Recharge,
  Session,
  User,
} from './types';

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function createApi(rawInitData?: string) {
  let accessToken = '';
  let refreshPromise: Promise<Session> | null = null;

  const request = async <T>(path: string, options: RequestInit = {}, retryAuth = true): Promise<T> => {
    const headers = new Headers(options.headers ?? {});
    if (accessToken && !path.startsWith('/api/auth/')) headers.set('Authorization', `Bearer ${accessToken}`);
    if (rawInitData && !accessToken) headers.set('Authorization', `tma ${rawInitData}`);
    if (rawInitData && !path.startsWith('/api/auth/')) headers.set('X-Telegram-Init-Data', rawInitData);
    if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

    const response = await fetch(path, { ...options, headers });
    const payload = (response.headers.get('content-type') ?? '').includes('application/json')
      ? await response.json() as T & ApiErrorShape
      : null;
    if (response.status === 401 && retryAuth && !path.startsWith('/api/auth/')) {
      await authenticate();
      return request<T>(path, options, false);
    }
    if (!response.ok) {
      const error = payload as ApiErrorShape | null;
      throw new ApiError(error?.error?.message ?? '请求失败，请稍后重试。', response.status, error?.error?.code);
    }
    return payload as T;
  };

  const authenticate = async (): Promise<Session> => {
    if (!rawInitData) throw new ApiError('无法获取 Telegram 登录信息，请从机器人菜单重新打开小程序。', 401, 'telegram_init_data_missing');
    if (refreshPromise) return refreshPromise;
    refreshPromise = request<Session>('/api/auth/telegram', {
      method: 'POST',
      body: JSON.stringify({ initData: rawInitData }),
    }, false)
      .then((session) => {
        accessToken = session.accessToken;
        return session;
      })
      .finally(() => { refreshPromise = null; });
    return refreshPromise;
  };

  return {
    authenticate,
    getUser: () => request<User>('/api/me'),
    getConfig: () => request<PublicConfig>('/api/public-config'),
    getCatalog: () => request<Product[]>('/api/catalog'),
    getOrders: () => request<Order[]>('/api/orders'),
    getOrder: (orderNo: string) => request<Order>(`/api/orders/${encodeURIComponent(orderNo)}`),
    createOrder: (variantId: string, quantity: number, idempotencyKey: string) => request<Order>('/api/orders', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ variantId, quantity }),
    }),
    createRecharge: (amount: number, idempotencyKey: string) => request<{ recharge: Recharge }>('/api/me/recharge', {
      method: 'POST',
      body: JSON.stringify({ amount, idempotencyKey }),
    }),
    getRecharge: (rechargeNo: string) => request<Recharge>(`/api/me/recharge/${encodeURIComponent(rechargeNo)}`),
    getBalance: () => request<{ balanceFen: number; entries: Array<{ kind: string; changeFen: number; createdAt: string }> }>('/api/me/balance'),
  };
}

export type ApiClient = ReturnType<typeof createApi>;
